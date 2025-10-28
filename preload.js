const { contextBridge, ipcRenderer } = require('electron');
// Preload startup log — helps diagnose whether the preload script actually
// executed. This will appear in the renderer DevTools console and in the
// main process logs depending on configuration.
try { console.log('[preload] preload.js loaded') } catch (e) { }

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

// System power operations (poweroff / reboot). Renderer must provide the
// sudo password (if required). This bridge simply forwards to main.
contextBridge.exposeInMainWorld('electronSystem', {
    poweroff: (password) => ipcRenderer.invoke('system:power', 'poweroff', password),
    reboot: (password) => ipcRenderer.invoke('system:power', 'reboot', password),
    closeApp: () => ipcRenderer.invoke('system:stop-and-quit')
});


// Small ready flag the renderer can check quickly to determine if the
// preload bridge loaded at all.
try { contextBridge.exposeInMainWorld('__electron_bridge_loaded', true) } catch (e) { }
