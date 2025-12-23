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
    closeApp: (password) => ipcRenderer.invoke('system:stop-and-quit', password)
});


// Small ready flag the renderer can check quickly to determine if the
// preload bridge loaded at all.
try { contextBridge.exposeInMainWorld('__electron_bridge_loaded', true) } catch (e) { }

// Expose nmcli-based Wi-Fi controls (Linux). Methods return Promises.
contextBridge.exposeInMainWorld('electronWifi', {
    scan: () => ipcRenderer.invoke('wifi:scan'),
    connect: (ssid, password) => ipcRenderer.invoke('wifi:connect', ssid, password),
    disconnect: (ssid) => ipcRenderer.invoke('wifi:disconnect', ssid),
    list: () => ipcRenderer.invoke('wifi:list'),
    status: (ssid) => ipcRenderer.invoke('wifi:status', ssid)
});

// Brightness bridge using system brightnessctl (Linux). Exposes get() -> {ok, supported, value}
// and set(percent) -> {ok, supported}.
contextBridge.exposeInMainWorld('electronBrightness', {
    get: () => ipcRenderer.invoke('brightness:get'),
    set: (percent) => ipcRenderer.invoke('brightness:set', percent)
});

// Updater bridge: check for update and trigger update run. Also allow
// subscribing to progress/status events emitted by main during update.
contextBridge.exposeInMainWorld('electronUpdater', {
    check: (opts = {}) => ipcRenderer.invoke('updater:check', opts),
    run: (opts = {}) => ipcRenderer.invoke('updater:run', opts),
    onProgress: (cb) => {
        const listener = (_, p) => cb(p)
        ipcRenderer.on('updater-progress', listener)
        return () => ipcRenderer.removeListener('updater-progress', listener)
    },
    onStatus: (cb) => {
        const listener = (_, s) => cb(s)
        ipcRenderer.on('updater-status', listener)
        return () => ipcRenderer.removeListener('updater-status', listener)
    }
});
