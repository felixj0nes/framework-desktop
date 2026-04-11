const { app, BrowserWindow, shell, Menu, Tray, Notification, nativeImage, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const fs   = require('fs')

// ─── Squirrel startup events (Windows installer lifecycle) ────────────────────
// Must be handled before anything else — quit immediately on install/update/uninstall
if (process.platform === 'win32') {
  const squirrelCommand = process.argv[1]
  if (squirrelCommand === '--squirrel-install'   ||
      squirrelCommand === '--squirrel-updated'    ||
      squirrelCommand === '--squirrel-uninstall'  ||
      squirrelCommand === '--squirrel-obsolete') {
    app.quit()
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_URL   = 'https://framework.club'
const APP_NAME  = 'Framework'
const PROTOCOL  = 'framework'
const IS_PACKAGED = app.isPackaged

// ─── Auto-updater ─────────────────────────────────────────────────────────────
// Only active in packaged builds — avoids spurious update checks during dev.
let autoUpdater = null
if (IS_PACKAGED) {
  try {
    autoUpdater = require('electron-updater').autoUpdater
    // We control the download manually — never auto-download silently
    autoUpdater.autoDownload        = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger              = null  // use our own logError() instead
  } catch (e) {
    // electron-updater not bundled — update checks will be skipped gracefully
    autoUpdater = null
  }
}

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit() }

// ─── Custom protocol ──────────────────────────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// ─── Window state persistence ─────────────────────────────────────────────────
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return { width: 1280, height: 820 } }
}

function saveState(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMaximized() || win.isMinimized()) {
    try {
      const prev = loadState()
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...prev, maximized: win.isMaximized() }))
    } catch {}
    return
  }
  try {
    const b = win.getBounds()
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...b, maximized: false }))
  } catch {}
}

// ─── Error logging ────────────────────────────────────────────────────────────
const LOG_FILE = path.join(app.getPath('userData'), 'update-errors.log')

function logError(tag, message) {
  if (!IS_PACKAGED) { console.error(tag, message); return }
  try {
    const entry = `${new Date().toISOString()} ${tag} ${String(message)}\n`
    fs.appendFileSync(LOG_FILE, entry)
  } catch {}
}

// ─── Auth callback ────────────────────────────────────────────────────────────
// Handles framework://auth?at=ACCESS_TOKEN&rt=REFRESH_TOKEN
//
// Security note: tokens are forwarded as URL query params to /portal/desktop-auth,
// where they are consumed immediately by Supabase setSession() and not stored.
// The desktop-auth page then redirects to /portal, clearing the tokens from the URL.
// Recommended future improvement: use safeStorage to store a one-time token and
// retrieve it via a secure IPC call, removing tokens from the URL entirely.
function handleAuthCallback(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'auth') return
    const at = parsed.searchParams.get('at')
    const rt = parsed.searchParams.get('rt')
    if (!at || !rt || !mainWindow) return
    const target = `${APP_URL}/portal/desktop-auth?at=${encodeURIComponent(at)}&rt=${encodeURIComponent(rt)}`
    mainWindow.loadURL(target)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } catch {
    // Silently discard malformed auth callbacks
  }
}

// ─── Eastern time utilities ───────────────────────────────────────────────────
// Returns the current time decomposed into Eastern time (EST/EDT), accounting
// for US daylight saving rules: EDT = UTC-4 (second Sun Mar → first Sun Nov),
// EST = UTC-5 (first Sun Nov → second Sun Mar).

function getEasternTime() {
  const now  = new Date()
  const year = now.getUTCFullYear()

  // Second Sunday in March at 02:00 EST = 07:00 UTC → DST starts (→ EDT)
  const marchFirst    = new Date(Date.UTC(year, 2, 1))
  const marchFirstDay = marchFirst.getUTCDay() // 0=Sun
  const daysTo1stSunMar = marchFirstDay === 0 ? 7 : (7 - marchFirstDay)
  const dstStart = new Date(Date.UTC(year, 2, 1 + daysTo1stSunMar + 7, 7, 0, 0))

  // First Sunday in November at 02:00 EDT = 06:00 UTC → DST ends (→ EST)
  const novFirst    = new Date(Date.UTC(year, 10, 1))
  const novFirstDay = novFirst.getUTCDay()
  const daysTo1stSunNov = novFirstDay === 0 ? 0 : (7 - novFirstDay)
  const dstEnd = new Date(Date.UTC(year, 10, 1 + daysTo1stSunNov, 6, 0, 0))

  const isEDT = now >= dstStart && now < dstEnd
  const offsetMs = (isEDT ? -4 : -5) * 60 * 60 * 1000

  const eastern = new Date(now.getTime() + offsetMs)
  return {
    dayOfWeek:    eastern.getUTCDay(),     // 0=Sun … 6=Sat
    hour:         eastern.getUTCHours(),
    minute:       eastern.getUTCMinutes(),
    totalMinutes: eastern.getUTCHours() * 60 + eastern.getUTCMinutes(),
  }
}

// Returns true if the current moment falls inside the AM session window
// (Mon–Fri, 08:00–11:00 Eastern).  We defer updates during this window
// to avoid interrupting a live session.
function isInLiveSessionHours() {
  const { dayOfWeek, totalMinutes } = getEasternTime()
  if (dayOfWeek === 0 || dayOfWeek === 6) return false  // weekend
  return totalMinutes >= 480 && totalMinutes < 660       // 08:00–11:00
}

// Returns the number of milliseconds until 11:00 Eastern today.
function msUntilSessionEnd() {
  const { hour, minute } = getEasternTime()
  if (hour >= 11) return 0
  return ((11 * 60) - (hour * 60 + minute)) * 60 * 1000
}

// ─── Splash window ────────────────────────────────────────────────────────────
let splashWindow  = null
let splashShownAt = 0
const SPLASH_MIN_MS = 900   // minimum splash display time even on fast connections

function createSplash() {
  splashWindow = new BrowserWindow({
    width:       400,
    height:      300,
    frame:       false,
    resizable:   false,
    movable:     true,
    center:      true,
    transparent: false,
    backgroundColor: '#F9FAFB',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
    },
  })
  splashWindow.loadFile(path.join(__dirname, 'build', 'splash.html'))
  splashWindow.once('closed', () => { splashWindow = null })
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

// ─── Update window ────────────────────────────────────────────────────────────
let updateWindow = null

function createUpdateWindow() {
  updateWindow = new BrowserWindow({
    width:       440,
    height:      320,
    frame:       false,
    resizable:   false,
    movable:     false,
    center:      true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#F9FAFB',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'build', 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      devTools:         !IS_PACKAGED,
    },
  })
  updateWindow.loadFile(path.join(__dirname, 'build', 'update.html'))
  updateWindow.once('closed', () => { updateWindow = null })
}

// Send a status event to the update window.
function sendUpdateStatus(data) {
  if (!updateWindow || updateWindow.isDestroyed()) return
  updateWindow.webContents.send('update:status', data)
}

// Show the update window — sends the initial downloading status.
// Waits for did-finish-load if the page hasn't loaded yet.
function showUpdateWindow(version) {
  if (!updateWindow || updateWindow.isDestroyed()) return

  const sendInitial = () => {
    sendUpdateStatus({ state: 'downloading', version, percent: 0 })
  }

  if (updateWindow.webContents.isLoading()) {
    updateWindow.webContents.once('did-finish-load', sendInitial)
  } else {
    sendInitial()
  }

  updateWindow.show()
}

function closeUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.destroy()
    updateWindow = null
  }
}

// ─── Update flow state ────────────────────────────────────────────────────────
let proceedAllowed      = false  // true once update decision is resolved
let mainWindowReady     = false  // true once main window fires ready-to-show
let updateConsecErrors  = 0      // consecutive update errors (triggers notification at 3)
let updateCheckTimeout  = null   // 8-second max wait for update-check resolution
let downloadStallTimer  = null   // 30-second stall detector during download

// Called when we know the update path is resolved (no update, timeout, error, skip).
// If the main window is already ready, shows it immediately; otherwise waits for
// ready-to-show.  Always enforces the SPLASH_MIN_MS minimum display time.
function proceedWhenReady() {
  closeUpdateWindow()
  proceedAllowed = true

  if (!mainWindowReady) return  // ready-to-show handler will pick this up

  const elapsed    = Date.now() - splashShownAt
  const remaining  = Math.max(0, SPLASH_MIN_MS - elapsed)
  setTimeout(() => {
    closeSplash()
    if (!mainWindow || mainWindow.isDestroyed()) return
    const state = loadState()
    if (state.maximized) mainWindow.maximize()
    mainWindow.show()
    scheduleSessionCheck()
  }, remaining)
}

// ─── Main window ──────────────────────────────────────────────────────────────
let mainWindow        = null
let tray              = null
let browserLoginOpened = false

function createWindow() {
  const state = loadState()
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width:     state.width  ?? 1280,
    height:    state.height ?? 820,
    x:         state.x,
    y:         state.y,
    minWidth:  920,
    minHeight: 600,
    title:     APP_NAME,
    icon:      path.join(__dirname, 'build', 'icon.png'),
    // Surface colour prevents white flash between Electron chrome and web app background
    backgroundColor: '#F9FAFB',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      devTools:         !IS_PACKAGED,
    },
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : {
      titleBarOverlay: {
        color:       '#F9FAFB',
        symbolColor: '#1F2937',
        height:      40,
      },
    }),
  })

  // Show main window only when both:
  //  1. the update check has resolved (proceedAllowed = true)
  //  2. the renderer has finished loading (mainWindowReady = true)
  // and only after the splash has been shown for at least SPLASH_MIN_MS.
  mainWindow.once('ready-to-show', () => {
    mainWindowReady = true
    if (!proceedAllowed) return   // still waiting for update decision — proceedWhenReady() handles this
    const elapsed   = Date.now() - splashShownAt
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed)
    setTimeout(() => {
      closeSplash()
      const s = loadState()
      if (s.maximized) mainWindow.maximize()
      mainWindow.show()
      scheduleSessionCheck()
    }, remaining)
  })

  mainWindow.loadURL(`${APP_URL}/portal`)

  mainWindow.webContents.on('did-navigate', (_event, url) => {
    const loginUrl = `${APP_URL}/login`
    if (url.startsWith(loginUrl) && !url.includes('desktop=1') && !browserLoginOpened) {
      browserLoginOpened = true
      shell.openExternal(`${loginUrl}?desktop=1`)
      mainWindow.loadURL(`${loginUrl}?desktop=1&waiting=1`)
    }
    if (url.startsWith(`${APP_URL}/portal`) && !url.includes('desktop-auth')) {
      browserLoginOpened = false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (_event, url) => {
    if (!url.startsWith(APP_URL)) {
      _event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Minimise to tray on close (Windows) — first time shows a tooltip
  mainWindow.on('close', (event) => {
    if (process.platform !== 'darwin' && tray) {
      event.preventDefault()
      mainWindow.hide()
      showTrayMinimiseTooltip()
    } else {
      saveState(mainWindow)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  // Keyboard shortcuts that would conflict with Chrome's defaults are
  // intercepted here so they work even when a text input is focused.
  // Cmd+K is handled in the renderer (document keydown) so the command
  // palette can receive focus correctly.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isMod = process.platform === 'darwin' ? input.meta : input.control
    if (!isMod || input.shift || input.alt) return
    switch (input.key.toLowerCase()) {
      case 'l':
        event.preventDefault()
        mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("library")').catch(() => {})
        break
      case 'r':
        // Plain Cmd+R only (Cmd+Shift+R is browser reload)
        event.preventDefault()
        mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("replays")').catch(() => {})
        break
      case ',':
        event.preventDefault()
        mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("account")').catch(() => {})
        break
    }
  })
}

// ─── Auto-update logic ────────────────────────────────────────────────────────
function clearStallTimer() {
  if (downloadStallTimer) { clearTimeout(downloadStallTimer); downloadStallTimer = null }
}

function resetStallTimer() {
  clearStallTimer()
  downloadStallTimer = setTimeout(() => {
    // No download-progress event for 30 seconds — signal stall
    sendUpdateStatus({ state: 'stalled' })
  }, 30_000)
}

function handleUpdateError(err) {
  clearTimeout(updateCheckTimeout)
  clearStallTimer()
  logError('[updater]', err?.message ?? String(err))

  updateConsecErrors++

  // Close update window and fall through to the normal app launch
  closeUpdateWindow()
  proceedWhenReady()

  // After 3 consecutive failures, surface a brief OS notification
  if (updateConsecErrors >= 3 && Notification.isSupported()) {
    const n = new Notification({
      title:  'Framework',
      body:   'Update check failed. Framework will retry automatically.',
      silent: true,
    })
    n.show()
  }

  // Schedule a retry in 30 minutes
  setTimeout(() => { startUpdateCheck() }, 30 * 60 * 1000)
}

function setupAutoUpdater() {
  if (!autoUpdater) return

  autoUpdater.on('update-not-available', () => {
    clearTimeout(updateCheckTimeout)
    updateConsecErrors = 0
    proceedWhenReady()
  })

  autoUpdater.on('update-available', (info) => {
    clearTimeout(updateCheckTimeout)
    updateConsecErrors = 0

    // ── Session-hours deferral ──────────────────────────────────────────
    // Do not interrupt a live AM session (Mon–Fri 08:00–11:00 Eastern).
    if (isInLiveSessionHours()) {
      const deferMs = msUntilSessionEnd() + 5 * 60 * 1000  // session end + 5 min buffer
      logError('[updater]', `Update deferred — inside session hours. Retrying in ${Math.round(deferMs / 60000)} min.`)
      setTimeout(() => {
        if (!isInLiveSessionHours()) startUpdateCheck()
      }, deferMs)
      proceedWhenReady()
      return
    }

    // ── Show update window ──────────────────────────────────────────────
    // Brief pause so the splash doesn't flash off immediately
    setTimeout(() => {
      closeSplash()
      showUpdateWindow(info.version)

      // Start the download
      resetStallTimer()
      autoUpdater.downloadUpdate().catch(handleUpdateError)
    }, 400)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    resetStallTimer()
    const percent = Math.round(progressObj.percent ?? 0)
    sendUpdateStatus({ state: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearStallTimer()
    sendUpdateStatus({ state: 'installing' })
    // Wait for the installing animation before restarting
    setTimeout(() => {
      saveState(mainWindow)
      autoUpdater.quitAndInstall(false, true)
    }, 1_800)
  })

  autoUpdater.on('error', handleUpdateError)
}

// Begin the update check that runs on every launch.
// The entire check has an 8-second hard timeout — a slow network must
// never hold up the app launch indefinitely.
function startUpdateCheck() {
  if (!autoUpdater || !IS_PACKAGED) {
    // Dev mode or no updater — proceed straight to main window
    proceedWhenReady()
    return
  }

  updateCheckTimeout = setTimeout(() => {
    logError('[updater]', 'Update check timed out after 8s — proceeding to launch')
    proceedWhenReady()
  }, 8_000)

  try {
    autoUpdater.checkForUpdates().catch((err) => {
      clearTimeout(updateCheckTimeout)
      handleUpdateError(err)
    })
  } catch (err) {
    clearTimeout(updateCheckTimeout)
    handleUpdateError(err)
  }
}

// Manual update check (from tray menu / macOS app menu)
function checkForUpdateManual() {
  if (!autoUpdater || !IS_PACKAGED) return
  try {
    autoUpdater.checkForUpdates().catch(() => {})
  } catch {}
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
function setupIPC() {
  // Update window — skip: open the main window without installing
  ipcMain.on('update:skip', () => {
    clearStallTimer()
    closeUpdateWindow()
    proceedWhenReady()
  })

  // Update window — retry: restart a stalled download
  ipcMain.on('update:retry', () => {
    if (!autoUpdater) return
    resetStallTimer()
    autoUpdater.downloadUpdate().catch(handleUpdateError)
  })
}

// ─── System tray ──────────────────────────────────────────────────────────────
let trayTooltipShown = false

function showTrayMinimiseTooltip() {
  if (trayTooltipShown) return
  trayTooltipShown = true
  if (Notification.isSupported()) {
    const n = new Notification({
      title:  'Framework is still running',
      body:   'Framework is minimised to the system tray. Click the tray icon to reopen.',
      icon:   path.join(__dirname, 'build', 'icon.png'),
      silent: true,
    })
    n.show()
  }
}

function createTray() {
  try {
    let trayIcon
    const iconPath = path.join(__dirname, 'build', 'icon.png')
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    } else {
      trayIcon = nativeImage.createEmpty()
    }
    tray = new Tray(trayIcon)
    tray.setToolTip('Framework')
    updateTrayMenu()

    tray.on('double-click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus() }
    })

    // Single click on Windows also opens the window
    if (process.platform === 'win32') {
      tray.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) mainWindow.focus()
          else { mainWindow.show(); mainWindow.focus() }
        }
      })
    }
  } catch {
    // Tray creation can fail in headless environments — safe to ignore
  }
}

function updateTrayMenu(sessionInfo) {
  if (!tray || tray.isDestroyed()) return
  const sessionLabel = sessionInfo ? `Today's session: ${sessionInfo}` : "Today's session: —"

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Framework',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } },
    },
    { label: sessionLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Check for updates',
      click: () => { if (autoUpdater) checkForUpdateManual() },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { saveState(mainWindow); tray = null; app.quit() },
    },
  ])
  tray.setContextMenu(menu)
}

// ─── Live session notifications ───────────────────────────────────────────────
let sessionCheckTimer          = null
let liveSessionNotifiedToday   = false

async function checkLiveSchedule() {
  if (liveSessionNotifiedToday) return
  try {
    const https = require('https')
    const fetchSchedule = () => new Promise((resolve, reject) => {
      const req = https.get(`${APP_URL}/api/livestream`, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve(null) }
        })
      })
      req.on('error', reject)
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')) })
    })

    const data = await fetchSchedule()
    if (!data) return

    // Update tray menu with session info
    if (data.session?.is_live) updateTrayMenu('Live now')
    else if (data.next_session)  updateTrayMenu(`${data.next_session} EST`)

    // Fire notification if session starts within 15 minutes
    if (data.next_session_ms && data.next_session_ms > 0 && data.next_session_ms <= 15 * 60 * 1000) {
      const minutesAway = Math.ceil(data.next_session_ms / 60000)
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'Framework — Live session starting',
          body:  `AM session starts in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}. 0800–1100 EST.`,
          icon:  path.join(__dirname, 'build', 'icon.png'),
          silent: false,
        })
        n.on('click', () => {
          if (mainWindow) {
            mainWindow.show(); mainWindow.focus()
            mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("livestream")').catch(() => {})
          }
        })
        n.show()
        liveSessionNotifiedToday = true
      }
    }
  } catch {
    // Network errors during session check are non-critical — ignore silently
  }
}

function scheduleSessionCheck() {
  checkLiveSchedule()
  sessionCheckTimer = setInterval(() => { checkLiveSchedule() }, 5 * 60 * 1000)

  // Reset daily notification flag at midnight
  const now = new Date()
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
  setTimeout(() => {
    liveSessionNotifiedToday = false
    if (sessionCheckTimer) { clearInterval(sessionCheckTimer); sessionCheckTimer = null }
    scheduleSessionCheck()
  }, msToMidnight)
}

// ─── App menu ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'
  if (!isMac) { Menu.setApplicationMenu(null); return }

  // macOS only — minimal menu, no reload/devtools in production
  const viewSubmenu = IS_PACKAGED
    ? [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ]
    : [
        { role: 'reload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        { type: 'separator' }, { role: 'toggleDevTools' },
      ]

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label:   'Check for updates…',
          click:   () => checkForUpdateManual(),
          enabled: !!autoUpdater,
        },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' }, { role: 'front' },
      ],
    },
  ]))
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu()
  setupIPC()
  setupAutoUpdater()

  // 1. Show splash immediately — brand presence from first frame
  createSplash()
  splashShownAt = Date.now()

  // 2. Create update window (hidden) — ready to show if an update is found
  createUpdateWindow()

  // 3. Create main window (loads in background while splash/update window is shown)
  createWindow()

  // 4. Create tray (Windows/Linux — macOS uses the Dock)
  if (process.platform !== 'darwin') createTray()

  // 5. Start update check — this is the decision gate.
  //    If no update: proceedWhenReady() → main window shows
  //    If update found: update window shows, main window stays hidden
  startUpdateCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  })
})

// Windows: deep link arrives as a command-line arg in the second instance
app.on('second-instance', (_event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`))
  if (url) handleAuthCallback(url)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show(); mainWindow.focus()
  }
})

// macOS: deep link arrives via open-url
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthCallback(url)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit if the app is minimised to tray
    if (!tray) app.quit()
  }
})

app.on('before-quit', () => {
  clearTimeout(updateCheckTimeout)
  clearStallTimer()
  if (sessionCheckTimer) { clearInterval(sessionCheckTimer); sessionCheckTimer = null }
  saveState(mainWindow)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
