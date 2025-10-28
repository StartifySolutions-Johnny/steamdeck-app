const { contextBridge, ipcRenderer } = require('electron');

// Expose a small TTS bridge to the renderer. Methods return Promises so the
// renderer can await success/failure if desired.
contextBridge.exposeInMainWorld('electronTTS', {
    speak: (text, opts) => ipcRenderer.invoke('tts:speak', text, opts),
    stop: () => ipcRenderer.invoke('tts:stop'),
    isAvailable: () => ipcRenderer.invoke('tts:isAvailable')
});

// Expose a tiny auto-start/systemctl bridge to the renderer. Only works on
// Linux where `systemctl --user` is available. Methods return Promises.
contextBridge.exposeInMainWorld('electronAutoStart', {
    getStatus: () => ipcRenderer.invoke('autostart:status'),
    setEnabled: (enabled) => ipcRenderer.invoke('autostart:set', enabled)
});
