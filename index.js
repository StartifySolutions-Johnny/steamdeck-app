const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const say = require('say');

ipcMain.handle('tts:speak', async (_, text) => {
    say.speak(text);
});

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
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        },
        preload: path.join(__dirname, 'preload.js')
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