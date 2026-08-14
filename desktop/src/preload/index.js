'use strict'

/**
 * Bridge for the boot screen. The harness Web UI never calls into it — every
 * exposed action either opens a native dialog or a folder, so the surface stays
 * safe to leave attached after the window navigates to the harness.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus(callback) {
    ipcRenderer.on('shell:status', (_event, payload) => callback(payload))
  },
  retry() {
    ipcRenderer.send('shell:retry')
  },
  openLogs() {
    ipcRenderer.send('shell:open-logs')
  },
  chooseWorkspace() {
    ipcRenderer.send('shell:choose-workspace')
  },
  info() {
    return ipcRenderer.invoke('shell:info')
  },
})
