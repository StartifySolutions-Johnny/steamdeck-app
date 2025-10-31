const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn, exec } = require('child_process')
const os = require('os')
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

log.transports.file.level = "info";
autoUpdater.logger = log;

autoUpdater.autoDownload = true; // automatski preuzmi nove verzije

autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info.version);
});

autoUpdater.on("update-not-available", () => {
    log.info("No update available");
});

autoUpdater.on("error", (err) => {
    log.error("Update error:", err);
});

autoUpdater.on("download-progress", (progress) => {
    log.info(`Progress: ${Math.round(progress.percent)}%`);
});

autoUpdater.on("update-downloaded", async (info) => {
    log.info("Update downloaded, will install on quit");
    try {
        // If running on Linux try to create a stable symlink to the new AppImage
        // so the systemd service can reference a predictable filename.
        if (process.platform === 'linux') {
            try { await tryCreateAppImageSymlink() } catch (e) { log.warn('[updater] failed to create symlink:', e && e.message) }
        }
    } catch (e) {
        log.warn('[updater] post-download hook error:', e && e.message)
    }
    autoUpdater.quitAndInstall();
});

// Proveri update odmah kad se app pokrene
app.on("ready", () => {
    autoUpdater.checkForUpdatesAndNotify();
});

// Track any spawned native TTS process so we can stop it later
let currentTtsProcess = null

/**
 * Try to spawn a system TTS binary as a fallback on Linux.
 * Tries `spd-say` first, then `espeak`.
 * Returns true if a process was spawned, false otherwise.
 */
function spawnTtsFallback(text, opts = {}) {
    // opts may include: { lang: 'en-US', voice: 'en-us+f3', rate: 150, pitch: 50, amplitude: 100 }
    const { lang = 'en-US', voice = null, rate = 150, pitch = 50, amplitude = 100 } = opts || {}
    if (currentTtsProcess) {
        try { currentTtsProcess.kill() } catch (e) { }
        currentTtsProcess = null
    }

    // Helper to try spawning a command with args, returns true on spawn
    const trySpawn = (cmd, args) => {
        try {
            currentTtsProcess = spawn(cmd, args)
            currentTtsProcess.on('exit', () => { currentTtsProcess = null })
            currentTtsProcess.on('error', () => { currentTtsProcess = null })
            return true
        } catch (e) {
            currentTtsProcess = null
            return false
        }
    }

    try {
        // Prefer spd-say (often available via speech-dispatcher). It will use
        // system configured voices which are typically higher quality than
        // espeak. We pass -l for locale if supported and fall back to plain.
        // const spdArgs = []
        // try {
        //     // include language flag if present
        //     if (lang) spdArgs.push('-l', lang)
        //     spdArgs.push(text)
        //     if (trySpawn('spd-say', spdArgs)) return true
        // } catch (e) { /* fallthrough */ }

        // If spd-say not available or failed, prefer espeak-ng if present
        // Build espeak/espeak-ng args with voice/rate/pitch/amplitude
        // espeak/espeak-ng options: -v <voice>, -s <speed words/min>, -p <pitch 0-99>, -a <amplitude 0-200>
        const espeakVoice = voice || (lang ? String(lang).toLowerCase().replace('_', '-') : 'en')
        const espeakArgs = ['-v', espeakVoice, '-s', String(rate), '-p', String(pitch), '-a', String(amplitude), text]
        if (trySpawn('espeak-ng', espeakArgs)) return true
        if (trySpawn('espeak', espeakArgs)) return true

        // Last resort: try a very simple espeak call with only voice/lang
        if (trySpawn('espeak', ['-v', espeakVoice, text])) return true
        return false
    } catch (e) {
        currentTtsProcess = null
        return false
    }
}

// IPC: speak text — always use the local fallback (spd-say / espeak) via spawnTtsFallback
// Accepts (text, opts) where opts may include { lang }
ipcMain.handle('tts:speak', async (_, text, opts = {}) => {
    try {
        const safeOpts = opts && typeof opts === 'object' ? opts : { lang: opts }
        // Kill any existing TTS process first
        try { if (currentTtsProcess) { try { currentTtsProcess.kill() } catch (e) { } currentTtsProcess = null } } catch (e) { }
        const spawned = spawnTtsFallback(text, safeOpts)
        return { ok: !!spawned }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// IPC: stop any current TTS (kill spawned process)
ipcMain.handle('tts:stop', async () => {
    try {
        if (currentTtsProcess) {
            try { currentTtsProcess.kill() } catch (e) { /* ignore */ }
            currentTtsProcess = null
        }
        return { ok: true }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// IPC: isAvailable => quick heuristic to detect at least one available TTS path
ipcMain.handle('tts:isAvailable', async () => {
    try {
        // On Linux check common paths for spd-say / espeak / espeak-ng / pico2wave
        if (process.platform === 'linux') {
            const candidates = [
                '/usr/bin/spd-say', '/bin/spd-say',
                '/usr/bin/espeak-ng', '/bin/espeak-ng',
                '/usr/bin/espeak', '/bin/espeak',
                '/usr/bin/pico2wave', '/bin/pico2wave'
            ]
            for (const p of candidates) {
                try { if (fs.existsSync(p)) return { ok: true } } catch (e) { }
            }
            return { ok: false }
        }
        // Fallback: optimistic true for other platforms
        return { ok: true }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// Helper: fetch JSON with timeout
function fetchJson(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => data += chunk)
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data))
                } catch (err) {
                    reject(err)
                }
            })
        })
        req.on('error', reject)
        req.setTimeout(timeout, () => { req.abort(); reject(new Error('Timeout')) })
    })
}

// Try to create a stable symlink to the most-recently downloaded AppImage.
// This centralizes the logic so we can call it at startup.
async function tryCreateAppImageSymlink() {
    try {
        if (process.platform !== 'linux') return
        const execDir = path.dirname(process.execPath || process.resourcesPath || __dirname)
        log.info('[updater] attempting to locate new AppImage to create stable symlink (startup)')
        const candidateDirs = [
            execDir,
            process.resourcesPath || execDir,
            path.join(os.homedir(), 'Applications'),
            (app.getPath && app.getPath('userData')) || execDir,
            os.tmpdir(),
            '/tmp',
            '/var/tmp'
        ]

        function findNewestAppImage(dirs) {
            const re = /^Gamepad-App-.*\.AppImage$/
            let best = null
            for (const d of dirs) {
                try {
                    if (!d || !fs.existsSync(d)) continue
                    const names = fs.readdirSync(d)
                    for (const n of names) {
                        if (!re.test(n)) continue
                        const full = path.join(d, n)
                        try {
                            const st = fs.statSync(full)
                            if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs }
                        } catch (e) { }
                    }
                } catch (e) { }
            }
            return best && best.path
        }

        const found = findNewestAppImage(candidateDirs)
        if (found) {
            try {
                const targetDir = path.join(os.homedir(), 'Applications')
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })
                const linkPath = path.join(targetDir, 'Gamepad-App.AppImage')
                try { if (fs.existsSync(linkPath) || (fs.lstatSync && fs.lstatSync(linkPath).isSymbolicLink())) fs.unlinkSync(linkPath) } catch (e) { }
                fs.symlinkSync(found, linkPath)
                log.info('[updater] symlink created:', linkPath, '->', found)
            } catch (e) {
                log.warn('[updater] symlink create failed:', e && e.message)
            }
        } else {
            log.warn('[updater] could not find a downloaded Gamepad-App-*.AppImage in candidate dirs:', candidateDirs)
        }
    } catch (e) {
        log.warn('[updater] tryCreateAppImageSymlink failed:', e && e.message)
    }
}

async function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        kiosk: true,
        fullscreen: true,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
            // devTools: true
        }
    })

    // Open DevTools
    // try { win.webContents.openDevTools({ mode: 'undocked' }) } catch (e) { }

    try {
        // Diagnostic log: confirm which preload path is being used
        log.info('[main] BrowserWindow preload:', path.join(__dirname, 'preload.js'))
    } catch (e) { console.log('[main] preload log failed', e && e.message) }

    // enforce kiosk/fullscreen and remove menu
    try { win.setKiosk(true); win.setFullScreen(true); win.removeMenu() } catch (e) { }

    // Re-enter fullscreen/kiosk if the window leaves it for any reason
    win.on('leave-full-screen', () => { try { win.setFullScreen(true); win.setKiosk(true) } catch (e) { } })
    win.on('enter-html-full-screen', () => { try { win.setFullScreen(true); win.setKiosk(true) } catch (e) { } })

    // Block common keyboard shortcuts that could exit fullscreen or close the window
    win.webContents.on('before-input-event', (event, input) => {
        const ctrlOrCmd = input.control || input.meta
        const alt = input.alt
        const key = (input.key || '').toLowerCase()

        // block: F11, Escape, Ctrl/Cmd+W, Alt+F4, Ctrl/Cmd+R, Ctrl/Cmd+Shift+I (devtools)
        if (
            input.code === 'F11' ||
            key === 'escape' ||
            (ctrlOrCmd && key === 'w') ||
            (alt && input.code === 'F4') ||
            (ctrlOrCmd && key === 'r') ||
            (ctrlOrCmd && input.shift && key === 'i')
        ) {
            event.preventDefault()
        }
    })

    // Resolve possible dist locations. When packaged, electron-builder may
    // place unpacked resources under process.resourcesPath (app.asar.unpacked)
    const resourcesPath = process.resourcesPath || __dirname
    const unpackedDistIndex = path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'index.html')
    const extraResourcesDistIndex = path.join(resourcesPath, 'app-dist', 'index.html')
    // Prefer an embedded dist folder inside this Electron app first (dev)
    const embeddedDistIndex = path.join(__dirname, 'dist', 'index.html')
    // Fallback to the sibling project build
    //const siblingDistIndex = path.join(__dirname, '..', 'nintendo-switch-web-ui', 'dist', 'index.html')
    const localIndex = path.join(__dirname, 'index.html')

    // Choose the first path that exists, preferring unpacked/external resources when packaged
    const chosenDistIndex = fs.existsSync(unpackedDistIndex) ? unpackedDistIndex : (fs.existsSync(extraResourcesDistIndex) ? extraResourcesDistIndex : fs.existsSync(embeddedDistIndex) ? embeddedDistIndex : null)
    // resolvedDistDir will hold the final, writable dist directory the app should serve from.
    // It's computed below (may be copied to userData on AppImage) and then reused by the server.
    let resolvedDistDir = null

    // Updater: do a lightweight check at startup (no downloading). If an update
    // is available, notify the user (notification + renderer event). Actual
    // download/apply will be triggered from the Settings modal via IPC.
    try {
        const updater = require(path.join(__dirname, 'updater'))

        // Determine the runtime dist directory (where the app currently serves from).
        const runtimeSourceDir = path.dirname(chosenDistIndex || embeddedDistIndex)
        let distDir = runtimeSourceDir

        // Detect AppImage / mounted runtime on Linux and prefer a writable copy in userData
        const runningOnLinux = process.platform === 'linux'
        const runningAsAppImage = !!process.env.APPIMAGE || (process.resourcesPath && process.resourcesPath.includes('/.mount'))
        if (runningOnLinux && runningAsAppImage) {
            try {
                const userDist = path.join(app.getPath('userData'), 'dist')
                if (runtimeSourceDir && fs.existsSync(runtimeSourceDir) && !fs.existsSync(userDist)) {
                    fs.mkdirSync(userDist, { recursive: true })
                    if (typeof fs.cpSync === 'function') fs.cpSync(runtimeSourceDir, userDist, { recursive: true })
                    else {
                        const copyRecursiveSync = (src, dest) => {
                            const entries = fs.readdirSync(src, { withFileTypes: true })
                            for (const entry of entries) {
                                const srcPath = path.join(src, entry.name)
                                const destPath = path.join(dest, entry.name)
                                if (entry.isDirectory()) {
                                    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath)
                                    copyRecursiveSync(srcPath, destPath)
                                } else fs.copyFileSync(srcPath, destPath)
                            }
                        }
                        copyRecursiveSync(runtimeSourceDir, userDist)
                    }
                    distDir = userDist
                } else if (fs.existsSync(userDist)) distDir = userDist
            } catch (e) { console.warn('[updater] failed to prepare writable dist copy:', e && e.message); distDir = runtimeSourceDir }
            resolvedDistDir = distDir
        }

        // perform a lightweight check (no downloads)
        try {
            const check = await updater.checkForUpdate({ distDir, remoteBaseUrl: 'https://nintendo-switch-content-ee8d316db220.herokuapp.com' })
            if (check && check.available) {
                try { new Notification({ title: 'Content update available', body: `New content ${check.remoteVer}` }).show() } catch (e) { }
                try { if (win && !win.isDestroyed()) win.webContents.send('update-available', check) } catch (e) { }
            }
        } catch (e) {
            console.warn('[updater] check failed:', e && e.message)
        }

        // Expose IPC handlers so renderer can ask for checks and trigger the full updater.
        ipcMain.handle('updater:check', async () => {
            try { return await updater.checkForUpdate({ distDir, remoteBaseUrl: 'https://nintendo-switch-content-ee8d316db220.herokuapp.com' }) }
            catch (e) { return { error: String(e) } }
        })

        ipcMain.handle('updater:run', async () => {
            // create a small progress window (same UI as before)
            let progressWin = null
            try {
                progressWin = new BrowserWindow({
                    width: 420,
                    height: 200,
                    frame: false,
                    resizable: false,
                    show: false,
                    webPreferences: {
                        preload: path.join(__dirname, 'preload-updater.js'),
                        contextIsolation: true,
                        nodeIntegration: false
                    }
                })
                progressWin.loadFile(path.join(__dirname, 'updater-ui.html'))
                await new Promise((resolve) => progressWin.webContents.once('did-finish-load', resolve))
                progressWin.show()

                const onProgress = (p) => {
                    try { if (progressWin && !progressWin.isDestroyed()) progressWin.webContents.send('updater-progress', p) } catch (e) { }
                    try { if (win && !win.isDestroyed()) win.webContents.send('updater-progress', p) } catch (e) { }
                }
                const onStatus = (s) => {
                    try { if (progressWin && !progressWin.isDestroyed()) progressWin.webContents.send('updater-status', s) } catch (e) { }
                    try { if (win && !win.isDestroyed()) win.webContents.send('updater-status', s) } catch (e) { }
                }

                onStatus('Starting update...')
                const res = await updater.runUpdater({ distDir, remoteBaseUrl: 'https://nintendo-switch-content-ee8d316db220.herokuapp.com', onProgress })
                onStatus(res && res.updated ? 'Update applied' : 'No update')

                // If an update was applied, reload the main window so it fetches the
                // new files from the local HTTP server. Also notify the renderer
                // with a dedicated event so UI can react (show toast, close modal, etc.).
                try {
                    if (res && res.updated) {
                        try {
                            if (win && !win.isDestroyed()) {
                                // force reload ignoring cache so the renderer fetches fresh assets
                                win.webContents.reloadIgnoringCache()
                                // inform renderer that update completed
                                win.webContents.send('update-complete', res)
                            }
                        } catch (e) { /* ignore reload errors */ }
                    } else {
                        try { if (win && !win.isDestroyed()) win.webContents.send('update-complete', res) } catch (e) { }
                    }
                } catch (e) { }

                return res
            } catch (e) {
                try { if (progressWin && !progressWin.isDestroyed()) progressWin.webContents.send('updater-status', 'Update failed: ' + (e && e.message)) } catch (e) { }
                throw e
            } finally {
                setTimeout(() => { try { if (progressWin && !progressWin.isDestroyed()) progressWin.close() } catch (e) { } }, 900)
            }
        })
    } catch (e) {
        console.warn('Updater module not available:', e && e.message)
    }

    if (chosenDistIndex) {
        // Serve the dist directory over a small local HTTP server so absolute paths
        // like /assets/... resolve correctly (the build uses leading slashes).
        const http = require('http')
        const url = require('url')

        // If a userData copy exists from a previous run, prefer it so updates persist
        try {
            const userDistCandidate = path.join(app.getPath('userData'), 'dist')
            if (!resolvedDistDir && fs.existsSync(userDistCandidate)) resolvedDistDir = userDistCandidate
        } catch (e) {
            // ignore
        }

        // Use the resolved writable dist if available; otherwise fall back to chosenDistIndex
        const distDir = resolvedDistDir || path.dirname(chosenDistIndex || embeddedDistIndex)

        const server = http.createServer((req, res) => {
            try {
                const parsed = url.parse(req.url)
                let pathname = decodeURIComponent(parsed.pathname)
                if (pathname === '/') pathname = '/index.html'

                // prevent directory traversal
                const safePath = path.normalize(path.join(distDir, pathname))
                if (!safePath.startsWith(distDir)) {
                    res.statusCode = 403
                    res.end('Forbidden')
                    return
                }

                if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
                    res.statusCode = 404
                    res.end('Not found')
                    return
                }

                const ext = path.extname(safePath).toLowerCase()
                const mime = {
                    '.html': 'text/html; charset=utf-8',
                    '.js': 'application/javascript; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.mp4': 'video/mp4',
                    '.webm': 'video/webm',
                    '.ogg': 'video/ogg',
                    '.mp3': 'audio/mpeg',
                    '.svg': 'image/svg+xml',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                    '.ttf': 'font/ttf',
                    '.json': 'application/json',
                    '.map': 'application/octet-stream'
                }[ext] || 'application/octet-stream'

                res.setHeader('Content-Type', mime)
                // Prevent caching of JSON manifests so updated content.json is picked up immediately
                if (ext === '.json') {
                    res.setHeader('Cache-Control', 'no-store, must-revalidate')
                    res.setHeader('Pragma', 'no-cache')
                    res.setHeader('Expires', '0')
                }
                // Add ETag/Last-Modified so clients can conditional GET and detect updates
                try {
                    const stat = fs.statSync(safePath)
                    const etag = `W/"${stat.size}-${stat.mtimeMs}"`
                    res.setHeader('ETag', etag)
                    res.setHeader('Last-Modified', stat.mtime.toUTCString())
                    const ifNoneMatch = req.headers['if-none-match']
                    const ifModifiedSince = req.headers['if-modified-since']
                    if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stat.mtimeMs)) {
                        res.statusCode = 304
                        res.end()
                        return
                    }
                } catch (e) {
                    // ignore stat errors and continue to serve the file
                }
                // Helpful debug: log when serving content.json
                if (path.basename(safePath) === 'content.json') {
                    try { console.log('[server] serving content.json from', safePath) } catch (e) { }
                }
                const stream = fs.createReadStream(safePath)
                stream.pipe(res)
                stream.on('error', () => {
                    res.statusCode = 500
                    res.end('Server error')
                })
            } catch (err) {
                res.statusCode = 500
                res.end('Server error')
            }
        })

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port
            win.loadURL(`http://127.0.0.1:${port}/`)
        })

        // Close server when the window is closed or app quits
        const cleanup = () => {
            try { server.close() } catch (e) { }
        }
        win.on('closed', cleanup)
        app.on('will-quit', cleanup)

    } else if (fs.existsSync(localIndex)) {
        // fallback to the local index.html in this folder
        win.loadFile(localIndex)
    } else {
        // If neither exists, load a simple error page
        const html = `<!doctype html><html><body><h2>App not found</h2><p>Create a build in ../nintendo-switch-web-ui/dist or add an index.html to this folder.</p></body></html>`
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    }
}

app.whenReady().then(async () => {
    // Attempt to create the stable AppImage symlink at startup so systemd or
    // other system integrations can reference a predictable filename.
    try { await tryCreateAppImageSymlink() } catch (e) { /* ignore */ }
    // On Linux, try to set brightness to max on startup so the display is
    // usable immediately (uses brightnessctl if available).
    try {
        if (process.platform === 'linux') {
            try {
                await execPromise('brightnessctl set 100%')
                try { log.info('[startup] brightness set to 100%') } catch (e) { }
            } catch (e) {
                try { log.warn('[startup] brightness set failed:', e && e.message) } catch (ee) { }
            }
        }
    } catch (e) { /* ignore */ }
    createWindow()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// Helper: promisified exec
function execPromise(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, opts, (err, stdout, stderr) => {
            if (err) return reject(err)
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
        })
    })
}

// Brightness control handlers. Uses the `brightnessctl` CLI on Linux. We
// expose get/set via IPC so the renderer can control screen brightness.
ipcMain.handle('brightness:get', async () => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        // Try to read current and max values to compute percent if possible
        let cur = null
        let max = null
        try {
            const r1 = await execPromise('brightnessctl get')
            cur = parseInt(String(r1.stdout || '').trim(), 10)
        } catch (e) { cur = null }
        try {
            const r2 = await execPromise('brightnessctl max')
            max = parseInt(String(r2.stdout || '').trim(), 10)
        } catch (e) { max = null }
        if (cur === null) {
            // Try alternative short commands
            try { const r = await execPromise('brightnessctl g'); cur = parseInt(String(r.stdout || '').trim(), 10) } catch (e) { }
            try { const r = await execPromise('brightnessctl m'); if (!max) max = parseInt(String(r.stdout || '').trim(), 10) } catch (e) { }
        }
        if (cur === null) return { ok: false, supported: true, error: 'could not read current brightness' }
        let percent = null
        if (max && max > 0) percent = Math.round((cur / max) * 100)
        return { ok: true, supported: true, value: percent !== null ? percent : cur, raw: { cur, max } }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

ipcMain.handle('brightness:set', async (_, percent) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        if (typeof percent !== 'number') return { ok: false, error: 'percent must be a number' }
        const clamped = Math.max(0, Math.min(100, Math.round(percent)))
        // brightnessctl accepts percentage arguments like '50%'
        await execPromise(`brightnessctl set ${clamped}%`)
        return { ok: true, supported: true, value: clamped }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// IPC: autostart status / control for systemd --user service (Linux only)
ipcMain.handle('autostart:status', async () => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        // Check is-enabled and is-active
        let enabled = false
        let active = false
        try {
            const r1 = await execPromise('systemctl --user is-enabled gamepad-overlay.service')
            enabled = String(r1.stdout || '').trim() === 'enabled'
        } catch (e) { enabled = false }
        try {
            const r2 = await execPromise('systemctl --user is-active gamepad-overlay.service')
            active = String(r2.stdout || '').trim() === 'active'
        } catch (e) { active = false }
        return { ok: true, supported: true, enabled, active }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

ipcMain.handle('autostart:set', async (_, enabled) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        if (enabled) {
            // enable on boot and start now
            await execPromise('systemctl --user enable --now gamepad-overlay.service')
        } else {
            // disable on boot and stop now
            await execPromise('systemctl --user disable --now gamepad-overlay.service')
        }
        // return updated status
        const status = await ipcMain.invoke ? await ipcMain.invoke('autostart:status') : null
        // ipcMain.invoke usually not available here; instead re-run check inline
        let enabledNow = false
        let activeNow = false
        try { const r1 = await execPromise('systemctl --user is-enabled gamepad-overlay.service'); enabledNow = String(r1.stdout || '').trim() === 'enabled' } catch (e) { enabledNow = false }
        try { const r2 = await execPromise('systemctl --user is-active gamepad-overlay.service'); activeNow = String(r2.stdout || '').trim() === 'active' } catch (e) { activeNow = false }
        return { ok: true, supported: true, enabled: enabledNow, active: activeNow }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// IPC: perform a system power action using sudo. Expects 'poweroff' or 'reboot'.
// WARNING: this will write the provided password to the stdin of sudo. That is
// potentially insecure. The UI currently sends the password 'butterfly'.
ipcMain.handle('system:power', async (_, action) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false, error: 'Unsupported platform' }
        if (!['poweroff', 'reboot'].includes(action)) return { ok: false, error: 'Invalid action' }

        // Execute the system action directly without sudo. The caller should
        // ensure the environment has appropriate privileges (e.g. systemd
        // service or polkit rules). We intentionally do not prompt for sudo
        // here — caller previously passed a password which is now ignored.
        const cmd = action === 'poweroff' ? 'systemctl poweroff' : 'systemctl reboot'
        try {
            const out = await execPromise(cmd)
            return { ok: true, supported: true, stdout: out.stdout }
        } catch (e) {
            // execPromise rejects on non-zero exit; surface stderr where present
            return { ok: false, supported: true, error: String(e), stderr: e.stderr || null }
        }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// IPC: stop the user service and quit the app (Linux only)
ipcMain.handle('system:stop-and-quit', async (_, password) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false, error: 'Unsupported platform' }

        // Require a password to proceed
        if (!password) return { ok: false, error: 'Password required' }

        // Validate sudo by running `sudo -S -p '' -v` and writing the password to stdin.
        const validateSudo = () => new Promise((resolve) => {
            try {
                const v = spawn('sudo', ['-S', '-p', '', '-v'], { stdio: ['pipe', 'pipe', 'pipe'] })
                let stderr = ''
                v.stderr.on('data', (d) => { stderr += String(d || '') })
                v.on('exit', (code) => { resolve({ code, stderr }) })
                try { v.stdin.write(String(password || '') + '\n'); v.stdin.end() } catch (e) { }
            } catch (e) {
                resolve({ code: 1, stderr: String(e) })
            }
        })

        const valid = await validateSudo()
        if (!valid || valid.code !== 0) {
            return { ok: false, error: 'Incorrect sudo password', stderr: valid && valid.stderr }
        }

        // Stop the user service (no sudo expected for --user)
        try {
            await execPromise('systemctl --user stop gamepad-overlay.service')
        } catch (e) {
            console.warn('Failed to stop service:', e && e.message)
        }

        // Quit the Electron app gracefully after a short delay to allow IPC reply
        setTimeout(() => {
            try { app.quit() } catch (e) { try { process.exit(0) } catch (ee) { } }
        }, 300)

        return { ok: true, supported: true }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

// Wi-Fi management via nmcli (Linux only)
ipcMain.handle('wifi:scan', async () => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        // list wifi access points in terse format: SSID:SECURITY:SIGNAL:BARS
        const cmd = 'nmcli -t -f SSID,SECURITY,SIGNAL,BARS device wifi list'
        const out = await execPromise(cmd)
        const lines = String(out.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
        const networks = []
        for (const line of lines) {
            // SSID:SECURITY:SIGNAL:BARS (SSID may contain colons, so split from the end)
            const parts = line.split(':')
            if (parts.length < 4) continue
            const bars = parts.pop()
            const signal = parts.pop()
            const security = parts.pop()
            const ssid = parts.join(':')
            networks.push({ ssid, security, signal: Number(signal || 0), bars })
        }
        return { ok: true, supported: true, networks }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

ipcMain.handle('wifi:list', async () => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        // show known connections
        const out = await execPromise('nmcli -t -f NAME,UUID,TYPE connection show')
        const lines = String(out.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
        const conns = lines.map(l => {
            const [name, uuid, type] = l.split(':')
            return { name, uuid, type }
        })
        return { ok: true, supported: true, connections: conns }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

ipcMain.handle('wifi:connect', async (_, ssid, password) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        if (!ssid) return { ok: false, error: 'SSID required' }
        // Build command: include password only when provided
        const safeSsid = ssid.replace(/"/g, '\\"')
        let cmd = `nmcli device wifi connect "${safeSsid}"`
        if (password) {
            const safePass = String(password).replace(/"/g, '\\"')
            cmd += ` password "${safePass}"`
        }
        const out = await execPromise(cmd)
        return { ok: true, supported: true, stdout: out.stdout }
    } catch (e) {
        return { ok: false, error: String(e), stderr: e.stderr || null }
    }
})

ipcMain.handle('wifi:disconnect', async (_, ssid) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        if (!ssid) return { ok: false, error: 'SSID required' }
        // Try to find an active connection matching the SSID and bring it down by UUID
        try {
            const active = await execPromise('nmcli -t -f NAME,UUID,DEVICE connection show --active')
            const lines = String(active.stdout || '').split('\n').map(l => l.trim()).filter(Boolean)
            for (const l of lines) {
                const [name, uuid, device] = l.split(':')
                if (name === ssid) {
                    await execPromise(`nmcli connection down uuid ${uuid}`)
                    return { ok: true, supported: true }
                }
            }
        } catch (e) {
            // fall through to generic disconnect
        }
        // fallback: try to delete or deactivate by name
        try {
            await execPromise(`nmcli connection down id "${ssid.replace(/"/g, '\\"')}"`)
            return { ok: true, supported: true }
        } catch (e) {
            return { ok: false, error: 'Could not find/stop connection', stderr: String(e) }
        }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})

ipcMain.handle('wifi:status', async (_, ssid) => {
    try {
        if (process.platform !== 'linux') return { ok: false, supported: false }
        // show general network status
        const res = await execPromise('nmcli -t -f STATE general')
        const state = String(res.stdout || '').trim()
        return { ok: true, supported: true, state }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
})