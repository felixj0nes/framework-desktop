// Preload runs in a sandboxed renderer context before the page loads.
// Exposes a minimal, typed API via contextBridge — no raw Node access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  // Lets the web app detect it is running inside the Electron shell.
  // Used to: suppress "Download app" nav item, show desktop-only features.
  isElectron: true,

  // Version info — useful for support / "about" screens
  versions: {
    electron: process.versions.electron,
    chrome:   process.versions.chrome,
    node:     process.versions.node,
  },

  // ── Auto-update events (renderer → main) ──────────────────────────────────
  // Trigger download of available update
  downloadUpdate: () => ipcRenderer.send('update-download'),
  // Install downloaded update and restart
  installUpdate:  () => ipcRenderer.send('update-install'),
  // Dismiss the update banner
  dismissUpdate:  () => ipcRenderer.send('update-dismiss'),

  // ── Auto-update events (main → renderer) ──────────────────────────────────
  // Register a callback for when an update is available
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', (_e, info) => cb(info))
  },
  // Register a callback for download progress
  onUpdateProgress: (cb) => {
    ipcRenderer.on('update-progress', (_e, info) => cb(info))
  },
  // Register a callback for when an update has been downloaded
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on('update-downloaded', (_e, info) => cb(info))
  },

  // Clean up IPC listeners when the component unmounts
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update-available')
    ipcRenderer.removeAllListeners('update-progress')
    ipcRenderer.removeAllListeners('update-downloaded')
  },
})
