const { app, BrowserWindow, shell, Menu } = require('electron')
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

// ─── Single instance lock ─────────────────────────────────────────────────────
// Ensures only one app window exists. When a second launch is triggered (e.g.
// by the OS routing a framework:// URL on Windows), the first instance handles it.
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
// Sent by framework.club/login after successful login with ?desktop=1
function handleAuthCallback(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'auth') return
    const at = parsed.searchParams.get('at')
    const rt = parsed.searchParams.get('rt')
    if (!at || !rt || !mainWindow) return
    // Load the desktop-auth page which sets the Supabase session then goes to /portal
    const target = `${APP_URL}/portal/desktop-auth?at=${encodeURIComponent(at)}&rt=${encodeURIComponent(rt)}`
    mainWindow.loadURL(target)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } catch (e) {
    console.error('Auth callback error:', e)
  }
}

// ─── Main window ──────────────────────────────────────────────────────────────
let mainWindow
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
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
  })

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize()
    mainWindow.show()
  })

  // Start at the portal — middleware will redirect to /login if not authenticated
  mainWindow.loadURL(`${APP_URL}/portal`)

  // When the app lands on the login page, open the browser for the desktop auth flow.
  // The user logs in via their browser; the site then redirects back via deep link.
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    const loginUrl = `${APP_URL}/login`
    if (url.startsWith(loginUrl) && !url.includes('desktop=1') && !browserLoginOpened) {
      browserLoginOpened = true
      shell.openExternal(`${loginUrl}?desktop=1`)
      // Show a holding page in the app while we wait for the browser login
      mainWindow.loadURL(`${APP_URL}/login?desktop=1&waiting=1`)
    }
    // Reset flag once back in the portal (e.g. after sign-out)
    if (url.startsWith(`${APP_URL}/portal`) && !url.includes('desktop-auth')) {
      browserLoginOpened = false
    }
  })

  // Open external links in the default browser, not in-app
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

  mainWindow.on('close', () => saveState(mainWindow))
}

// ─── App menu ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'

  // Windows: no visible menu bar — clean shell appearance
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }

  // Mac: minimal menu required by the OS (menu bar is always visible)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
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
      submenu: [
        { role: 'reload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Windows: deep link arrives as a command-line arg in second-instance
app.on('second-instance', (_event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith(`${PROTOCOL}://`))
  if (url) handleAuthCallback(url)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// Mac: deep link arrives via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthCallback(url)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
