// Preload runs in a sandboxed renderer context before the page loads.
// Exposes a minimal, typed API via contextBridge — no raw Node access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,

  versions: {
    electron: process.versions.electron,
    chrome:   process.versions.chrome,
    node:     process.versions.node,
  },

  // Platform — so renderer can conditionally show window buttons
  platform: process.platform,

  // ── Window controls (renderer → main) ───────────────────────────────
  win: {
    minimize:       () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close:          () => ipcRenderer.invoke('win:close'),
    isMaximized:    () => ipcRenderer.invoke('win:is-maximized'),
  },

  // ── Session reminder preference ──────────────────────────────────────
  setSessionReminder: (enabled) => ipcRenderer.send('session:reminder', Boolean(enabled)),

  // ── Auto-update events (renderer → main) ────────────────────────────
  downloadUpdate: () => ipcRenderer.send('update-download'),
  installUpdate:  () => ipcRenderer.send('update-install'),
  dismissUpdate:  () => ipcRenderer.send('update-dismiss'),

  // ── Auto-update events (main → renderer) ────────────────────────────
  onUpdateAvailable: (cb) => { ipcRenderer.on('update-available', (_e, info) => cb(info)) },
  onUpdateProgress:  (cb) => { ipcRenderer.on('update-progress',  (_e, info) => cb(info)) },
  onUpdateDownloaded:(cb) => { ipcRenderer.on('update-downloaded', (_e, info) => cb(info)) },
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update-available')
    ipcRenderer.removeAllListeners('update-progress')
    ipcRenderer.removeAllListeners('update-downloaded')
  },
})
