const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronTTS', {
    speak: (text) => ipcRenderer.invoke('tts:speak', text)
});
