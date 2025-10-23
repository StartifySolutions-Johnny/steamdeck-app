const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
    onProgress: (cb) => ipcRenderer.on('updater-progress', (ev, data) => cb(data)),
    onStatus: (cb) => ipcRenderer.on('updater-status', (ev, data) => cb(data))
})
