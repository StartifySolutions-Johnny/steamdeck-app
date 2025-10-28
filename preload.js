const { contextBridge, ipcRenderer } = require('electron');

// Expose a small TTS bridge to the renderer. Methods return Promises so the
// renderer can await success/failure if desired.
contextBridge.exposeInMainWorld('electronTTS', {
    speak: (text, opts) => ipcRenderer.invoke('tts:speak', text, opts),
    stop: () => ipcRenderer.invoke('tts:stop'),
    isAvailable: () => ipcRenderer.invoke('tts:isAvailable')
});
