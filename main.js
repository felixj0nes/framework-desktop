const { app, BrowserWindow, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_URL  = 'https://framework.club'
const APP_NAME = 'Framework'

// ─── Window state ─────────────────────────────────────────────────────────────
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return { width: 1280, height: 820 } }
}

function saveState(win) {
  if (win.isMaximized() || win.isMinimized()) {
    // Only persist maximized flag, keep last bounds
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

// ─── Main window ──────────────────────────────────────────────────────────────
let mainWindow

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
    show: false, // avoids white flash on startup
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
    // Mac: native traffic lights inset into the window
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
  })

  // Show once the page is ready to avoid blank frame
  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.loadURL(APP_URL)

  // Keep navigation inside the app domain; open everything else in the browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_URL)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('close', () => saveState(mainWindow))
}

// ─── App menu ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin'

  const template = [
    // Mac: app menu
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu()
  createWindow()

  // Mac: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
