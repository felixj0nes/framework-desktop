// Preload for the update window — sandboxed, minimal surface area.
// Exposes only what update.html needs: receive status events, send skip/retry.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  update: {
    // Register a callback for status events from the main process.
    // data shape: { state: 'downloading'|'installing'|'stalled', version?, percent? }
    onStatus: (callback) => {
      ipcRenderer.on('update:status', (_e, data) => {
        // Validate shape before passing into the renderer — never trust IPC blindly
        if (data && typeof data.state === 'string') callback(data)
      })
    },
    // Ask the main process to open the main window without updating
    skip: () => ipcRenderer.send('update:skip'),
    // Ask the main process to retry a stalled download
    retry: () => ipcRenderer.send('update:retry'),
  },
})
