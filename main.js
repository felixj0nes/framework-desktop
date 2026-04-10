const { app, BrowserWindow, shell, Menu, Tray, Notification, nativeImage, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')

// ─── Squirrel startup events (Windows installer lifecycle) ────────────────────
// Must be handled before anything else — quit immediately on install/update/uninstall
if (process.platform === 'win32') {
  const squirrelCommand = process.argv[1]
  if (squirrelCommand === '--squirrel-install' ||
      squirrelCommand === '--squirrel-updated' ||
      squirrelCommand === '--squirrel-uninstall' ||
      squirrelCommand === '--squirrel-obsolete') {
    app.quit()
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_URL  = 'https://framework.club'
const APP_NAME = 'Framework'
const PROTOCOL = 'framework'
const IS_PACKAGED = app.isPackaged

// ─── Auto-updater ─────────────────────────────────────────────────────────────
// Only active in packaged builds — avoids spurious update checks during dev.
let autoUpdater = null
if (IS_PACKAGED) {
  try {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.autoDownload = false  // ask the user before downloading
    autoUpdater.autoInstallOnAppQuit = false
    // Disable update checks in dev; electron-updater reads publish config from package.json
    autoUpdater.logger = null
  } catch (e) {
    // electron-updater not installed — safe to ignore, update checks will be skipped
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

// ─── Window state ─────────────────────────────────────────────────────────────
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return { width: 1280, height: 820 } }
}

function saveState(win) {
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

// ─── Auth callback ────────────────────────────────────────────────────────────
// Handles framework://auth?at=ACCESS_TOKEN&rt=REFRESH_TOKEN
//
// Security note: tokens are forwarded as URL query params to /portal/desktop-auth,
// where they are consumed immediately by Supabase setSession() and not stored.
// The desktop-auth page then redirects to /portal, clearing the tokens from the URL.
// A more hardened future approach: pass tokens via postMessage or a one-time token
// store (safeStorage) to avoid any URL-bar or referrer-log exposure.
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
  } catch (e) {
    // Silently discard malformed auth callbacks
  }
}

// ─── Splash window ────────────────────────────────────────────────────────────
let splashWindow = null
const SPLASH_MIN_MS = 900  // minimum time splash is shown, even on fast connections

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    transparent: false,
    backgroundColor: '#F9FAFB',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
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

// ─── Main window ──────────────────────────────────────────────────────────────
let mainWindow = null
let tray = null
let browserLoginOpened = false
let splashShownAt = 0
let liveSessionNotifiedToday = false

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
    // Surface colour prevents flash between Electron chrome and web app background
    backgroundColor: '#F9FAFB',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      // Block devtools in production builds
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

  // Show main window only after splash has been visible for at least SPLASH_MIN_MS
  mainWindow.once('ready-to-show', () => {
    const elapsed = Date.now() - splashShownAt
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed)
    setTimeout(() => {
      closeSplash()
      if (state.maximized) mainWindow.maximize()
      mainWindow.show()
      // Check for updates after main window is shown (non-blocking)
      if (autoUpdater) {
        setTimeout(() => checkForUpdates(), 3000)
      }
      // Check for upcoming live sessions
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

  // Minimise to tray on close (Windows) — first time shows tooltip
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

  // Register keyboard shortcuts for the renderer
  // Keyboard shortcuts — intercepted here so they work even when a text input is focused
  // Cmd+K is handled in the renderer (document keydown) to allow the palette to receive focus.
  // Cmd+L, Cmd+R, Cmd+, are intercepted here because they would otherwise conflict with
  // Chrome's built-in shortcuts (location bar, reload, settings).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isMod = process.platform === 'darwin' ? input.meta : input.control
    if (!isMod || input.shift || input.alt) return
    switch (input.key.toLowerCase()) {
      case 'l':
        event.preventDefault()
        mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("library")').catch(() => {})
        break
      case 'r':
        // Only intercept plain Cmd+R (not Cmd+Shift+R reload)
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

// ─── System tray ──────────────────────────────────────────────────────────────
let trayTooltipShown = false

function showTrayMinimiseTooltip() {
  if (trayTooltipShown) return
  trayTooltipShown = true
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'Framework is still running',
      body: 'Framework is minimised to the system tray. Click the tray icon to reopen.',
      icon: path.join(__dirname, 'build', 'icon.png'),
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
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })

    // Single click on Windows also opens the window
    if (process.platform === 'win32') {
      tray.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) {
            mainWindow.focus()
          } else {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      })
    }
  } catch (e) {
    // Tray creation can fail in some headless environments — safe to ignore
  }
}

function updateTrayMenu(sessionInfo) {
  if (!tray || tray.isDestroyed()) return
  const sessionLabel = sessionInfo
    ? `Today's session: ${sessionInfo}`
    : "Today's session: —"

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Framework',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { label: sessionLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Check for updates',
      click: () => {
        if (autoUpdater) checkForUpdates(true)
        else if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        saveState(mainWindow)
        tray = null
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

// ─── Live session notifications ───────────────────────────────────────────────
let sessionCheckTimer = null

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
    if (data.session?.is_live) {
      updateTrayMenu('Live now')
    } else if (data.next_session) {
      updateTrayMenu(`${data.next_session} EST`)
    }

    // Fire notification if session starts within 15 minutes
    if (data.next_session_ms && data.next_session_ms > 0 && data.next_session_ms <= 15 * 60 * 1000) {
      const minutesAway = Math.ceil(data.next_session_ms / 60000)
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'Framework — Live session starting',
          body: `AM session starts in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}. 0800–1100 EST.`,
          icon: path.join(__dirname, 'build', 'icon.png'),
          silent: false,
        })
        n.on('click', () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
            mainWindow.webContents.executeJavaScript('window.__fwNav && window.__fwNav("livestream")')
          }
        })
        n.show()
        liveSessionNotifiedToday = true
      }
    }
  } catch (e) {
    // Network errors during session check are non-critical
  }
}

function scheduleSessionCheck() {
  // Immediate check on launch
  checkLiveSchedule()
  // Then every 5 minutes
  sessionCheckTimer = setInterval(() => {
    checkLiveSchedule()
  }, 5 * 60 * 1000)
  // Reset the daily notification flag at midnight
  const now = new Date()
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
  setTimeout(() => {
    liveSessionNotifiedToday = false
    // Re-schedule after midnight
    scheduleSessionCheck()
  }, msToMidnight)
}

// ─── Auto-update logic ────────────────────────────────────────────────────────
let updateBannerShown = false

function checkForUpdates(manual = false) {
  if (!autoUpdater) return
  try {
    autoUpdater.checkForUpdates().catch(() => {})
  } catch (e) {}
}

function setupAutoUpdater() {
  if (!autoUpdater) return

  autoUpdater.on('update-available', (info) => {
    if (updateBannerShown) return
    updateBannerShown = true
    // Send to renderer to show in-app banner
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', { version: info.version })
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { percent: Math.round(progress.percent) })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: info.version })
    }
  })

  autoUpdater.on('error', (err) => {
    // Silently log — never crash on update failure
    if (!IS_PACKAGED) console.error('[updater]', err.message)
  })
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
function setupIPC() {
  // Renderer requests update download
  ipcMain.on('update-download', () => {
    if (autoUpdater) {
      try { autoUpdater.downloadUpdate().catch(() => {}) } catch (e) {}
    }
  })

  // Renderer requests install + restart
  ipcMain.on('update-install', () => {
    if (autoUpdater) {
      try {
        saveState(mainWindow)
        autoUpdater.quitAndInstall(false, true)
      } catch (e) {}
    }
  })

  // Renderer dismisses update banner
  ipcMain.on('update-dismiss', () => {
    updateBannerShown = false
  })
}

// ─── App menu ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'

  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }

  // Mac menu — minimal, no reload/devtools in production
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
          label: 'Check for updates…',
          click: () => checkForUpdates(true),
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
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' }, { role: 'front' },
      ],
    },
  ]))
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu()
  setupIPC()
  setupAutoUpdater()

  // Show splash first, record the time so we can enforce minimum display duration
  createSplash()
  splashShownAt = Date.now()

  // Create main window immediately — it loads in background while splash is shown
  createWindow()

  // Create tray (Windows + Linux only; macOS uses the Dock)
  if (process.platform !== 'darwin') {
    createTray()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  })
})

// Windows: deep link arrives as a command-line arg in second-instance
app.on('second-instance', (_event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`))
  if (url) handleAuthCallback(url)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// Mac: deep link arrives via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthCallback(url)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit if we have a tray — window close goes to tray
    if (!tray) app.quit()
  }
})

// Clean up on actual quit
app.on('before-quit', () => {
  if (sessionCheckTimer) clearInterval(sessionCheckTimer)
  if (mainWindow && !mainWindow.isDestroyed()) saveState(mainWindow)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
