const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const say = require('say');
const { spawn } = require('child_process')
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

autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded, will install on quit");
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
function spawnTtsFallback(text, lang = 'en-US') {
    if (currentTtsProcess) {
        try { currentTtsProcess.kill() } catch (e) { }
        currentTtsProcess = null
    }
    try {
        // Prefer spd-say (often available via speech-dispatcher)
        // Pass language flag where supported (-l)
        currentTtsProcess = spawn('spd-say', ['-l', lang, text])
        currentTtsProcess.on('exit', () => { currentTtsProcess = null })
        currentTtsProcess.on('error', () => {
            // fall through to try espeak
            try {
                // espeak accepts -v <voice/lang>
                currentTtsProcess = spawn('espeak', ['-v', lang, text])
                currentTtsProcess.on('exit', () => { currentTtsProcess = null })
            } catch (e) {
                currentTtsProcess = null
            }
        })
        return true
    } catch (e) {
        try {
            currentTtsProcess = spawn('espeak', ['-v', lang, text])
            currentTtsProcess.on('exit', () => { currentTtsProcess = null })
            return true
        } catch (ee) {
            currentTtsProcess = null
            return false
        }
    }
}

// IPC: speak text (primary: say.speak; fallback: spd-say/espeak)
// Accepts (text, opts) where opts may include { lang, voice }
ipcMain.handle('tts:speak', async (_, text, opts = {}) => {
    try {
        // prefer the `say` module which abstracts platform differences
        const lang = opts.lang || 'en-US'
        const voice = opts.voice
        try {
            // say.speak(text, voice, speed, callback)
            say.speak(text, voice, 1.0, (err) => {
                if (err) {
                    // If say failed at runtime, attempt fallback on Linux with language
                    if (process.platform === 'linux') spawnTtsFallback(text, lang)
                }
            })
            return { ok: true }
        } catch (err) {
            // synchronous failure from say -> try fallback
            if (process.platform === 'linux') {
                const spawned = spawnTtsFallback(text, lang)
                return { ok: !!spawned }
            }
            return { ok: false, error: String(err) }
        }
    } catch (e) {
        // last-resort attempt on Linux
        if (process.platform === 'linux') {
            const lang = (opts && opts.lang) || 'en-US'
            const spawned = spawnTtsFallback(text, lang)
            return { ok: !!spawned }
        }
        return { ok: false, error: String(e) }
    }
})

// IPC: stop any current TTS (try say.stop(), then kill spawned process)
ipcMain.handle('tts:stop', async () => {
    try {
        if (typeof say.stop === 'function') {
            try { say.stop() } catch (e) { /* ignore */ }
        }
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
        // If the `say` module is present, assume OK (it will attempt system binaries)
        if (say && typeof say.speak === 'function') return { ok: true }
        // On Linux check common paths for spd-say / espeak
        if (process.platform === 'linux') {
            const candidates = ['/usr/bin/spd-say', '/bin/spd-say', '/usr/bin/espeak', '/bin/espeak']
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
            preload: path.join(__dirname, 'preload.js')
        }
    })

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

    // Run the updater to download remote content and books when available.
    let progressWin = null
    try {
        const { ipcMain } = require('electron')
        const updater = require(path.join(__dirname, 'updater'))

        // Determine the runtime dist directory (where the app currently serves from).
        // This may be inside the mounted AppImage (read-only). If so, copy it to
        // a writable location under app.getPath('userData') and use that for updates.
        const runtimeSourceDir = path.dirname(chosenDistIndex || embeddedDistIndex)
        let distDir = runtimeSourceDir

        // Detect AppImage / mounted runtime on Linux
        const runningOnLinux = process.platform === 'linux'
        const runningAsAppImage = !!process.env.APPIMAGE || (process.resourcesPath && process.resourcesPath.includes('/.mount'))
        if (runningOnLinux && runningAsAppImage) {
            try {
                const userDist = path.join(app.getPath('userData'), 'dist')
                // If userDist doesn't exist, copy the runtimeSourceDir contents into it
                if (runtimeSourceDir && fs.existsSync(runtimeSourceDir) && !fs.existsSync(userDist)) {
                    console.log('[updater] packaging: copying runtime dist to userData:', runtimeSourceDir, '->', userDist)
                    // ensure parent exists
                    fs.mkdirSync(userDist, { recursive: true })
                    // Use fs.cpSync when available (Node 16+). Fallback to manual copy.
                    if (typeof fs.cpSync === 'function') {
                        fs.cpSync(runtimeSourceDir, userDist, { recursive: true })
                    } else {
                        // simple recursive copy
                        const copyRecursiveSync = (src, dest) => {
                            const entries = fs.readdirSync(src, { withFileTypes: true })
                            for (const entry of entries) {
                                const srcPath = path.join(src, entry.name)
                                const destPath = path.join(dest, entry.name)
                                if (entry.isDirectory()) {
                                    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath)
                                    copyRecursiveSync(srcPath, destPath)
                                } else {
                                    fs.copyFileSync(srcPath, destPath)
                                }
                            }
                        }
                        copyRecursiveSync(runtimeSourceDir, userDist)
                    }
                    distDir = userDist
                } else if (fs.existsSync(userDist)) {
                    // already present, prefer it
                    distDir = userDist
                }
            } catch (e) {
                console.warn('[updater] failed to copy runtime dist to userData, falling back to runtime source dir:', e && e.message)
                distDir = runtimeSourceDir
            }
            // record resolved dir for use by the server below
            resolvedDistDir = distDir
        }

        // create a small progress window
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
        // wait for renderer to finish loading so it can receive IPC messages
        await new Promise((resolve) => progressWin.webContents.once('did-finish-load', resolve))
        progressWin.show()

        // forward progress from updater to UI via IPC
        const onProgress = (p) => {
            try { if (progressWin && !progressWin.isDestroyed()) progressWin.webContents.send('updater-progress', p) } catch (e) { }
        }
        const onStatus = (s) => {
            try { if (progressWin && !progressWin.isDestroyed()) progressWin.webContents.send('updater-status', s) } catch (e) { }
        }

        try {
            // notify UI we're starting
            onStatus('Starting update...')
            const res = await updater.runUpdater({ distDir, remoteBaseUrl: 'https://nintendo-switch-content-ee8d316db220.herokuapp.com', onProgress })
            if (res && res.updated) console.log('Updater applied: ', res)
            else console.log('Updater: no update required', res)
            onStatus('Update complete')
        } catch (e) {
            console.warn('Updater failed (continuing):', e && e.message)
            onStatus('Update failed: ' + (e && e.message))
        } finally {
            // close progress window after short delay so user can see the final status
            setTimeout(() => { try { if (progressWin && !progressWin.isDestroyed()) progressWin.close() } catch (e) { } }, 900)
        }
    } catch (e) {
        console.warn('Updater module or UI not available:', e && e.message)
        try { if (progressWin && !progressWin.isDestroyed()) progressWin.close() } catch (e) { }
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

app.whenReady().then(() => createWindow())

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})