const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')

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
        }
    })

    // Prefer an embedded dist folder inside this Electron app first
    const embeddedDistIndex = path.join(__dirname, 'dist', 'index.html')
    // Fallback to the sibling project build
    const siblingDistIndex = path.join(__dirname, '..', 'nintendo-switch-web-ui', 'dist', 'index.html')
    const localIndex = path.join(__dirname, 'index.html')

    const chosenDistIndex = fs.existsSync(embeddedDistIndex) ? embeddedDistIndex : (fs.existsSync(siblingDistIndex) ? siblingDistIndex : null)

    // Run the updater to download remote content and books when available.
    let progressWin = null
    try {
        const { ipcMain } = require('electron')
        const updater = require(path.join(__dirname, 'updater'))
        const distDir = path.dirname(chosenDistIndex || embeddedDistIndex)

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
            const res = await updater.runUpdater({ distDir, remoteBaseUrl: 'http://localhost:5173', onProgress })
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

        const distDir = path.dirname(chosenDistIndex)

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
                    '.svg': 'image/svg+xml',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                    '.ttf': 'font/ttf',
                    '.json': 'application/json',
                    '.map': 'application/octet-stream'
                }[ext] || 'application/octet-stream'

                res.setHeader('Content-Type', mime)
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