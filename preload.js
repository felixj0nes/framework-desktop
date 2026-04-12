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

  // ── Auto-update control (renderer → main) ───────────────────────────
  // Trigger a manual check (e.g. from a settings button). Returns nothing —
  // results arrive via the event listeners below.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  // Start downloading an available update (portal banner "Update now" button)
  downloadUpdate: () => ipcRenderer.send('update:download'),
  // Quit and apply a downloaded update (portal banner "Restart" button)
  installUpdate:  () => ipcRenderer.send('update:install'),
  // Dismiss the update banner — main process has no action to take
  dismissUpdate:  () => ipcRenderer.send('update:dismiss'),

  // ── Auto-update events (main → renderer) ────────────────────────────
  onUpdateAvailable:  (cb) => { ipcRenderer.on('update:available',  (_e, info) => cb(info)) },
  onUpdateProgress:   (cb) => { ipcRenderer.on('update:progress',   (_e, info) => cb(info)) },
  onUpdateDownloaded: (cb) => { ipcRenderer.on('update:downloaded', (_e, info) => cb(info)) },
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update:available')
    ipcRenderer.removeAllListeners('update:progress')
    ipcRenderer.removeAllListeners('update:downloaded')
  },

  // ── Auth token secure storage (renderer ↔ main) ─────────────────────
  // Used on session restore — renderer requests any persisted tokens
  // so Supabase can be re-initialised without a full browser OAuth flow.
  auth: {
    getTokens:   () => ipcRenderer.invoke('auth:get-tokens'),
    clearTokens: () => ipcRenderer.send('auth:clear-tokens'),
  },
})
