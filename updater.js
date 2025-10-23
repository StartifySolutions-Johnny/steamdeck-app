const fs = require('fs')
const path = require('path')
const http = require('http')
const { URL } = require('url')

function fetchText(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => data += chunk)
            res.on('end', () => resolve(data))
        })
        req.on('error', reject)
        req.setTimeout(timeout, () => { req.abort(); reject(new Error('Timeout')) })
    })
}

function downloadToFile(url, destPath, timeout = 20000, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath)
        const req = http.get(url, (res) => {
            if (res.statusCode && res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode))
            const total = parseInt(res.headers['content-length'] || '0', 10)
            let received = 0
            res.on('data', (chunk) => {
                received += chunk.length
                if (onProgress && total) onProgress({ url, received, total, percent: (received / total) * 100 })
            })
            res.pipe(file)
            file.on('finish', () => { file.close(() => resolve()) })
        })
        req.on('error', (err) => { fs.unlink(destPath, () => reject(err)) })
        req.setTimeout(timeout, () => { req.abort(); fs.unlink(destPath, () => reject(new Error('Timeout'))) })
    })
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// Collect asset URLs from a content manifest when a detailed files list is absent.
function inferFilesFromManifest(manifest, baseUrl) {
    const files = new Set()

    function resolveAsset(p, book) {
        if (!p) return null
        // absolute URL
        if (p.startsWith('http://') || p.startsWith('https://')) return p
        // absolute path on server
        if (p.startsWith('/')) return (new URL(p, baseUrl)).toString()
        // bare filename -> assume inside book folder if book and id exist
        if (book && (typeof book.id !== 'undefined')) {
            return (new URL(`/books/${book.id}/${p}`, baseUrl)).toString()
        }
        // fallback: relative to base
        return (new URL(p, baseUrl)).toString()
    }

    if (manifest && Array.isArray(manifest.books)) {
        for (const b of manifest.books) {
            const coverUrl = resolveAsset(b.cover, b)
            if (coverUrl) files.add(coverUrl)
            if (Array.isArray(b.content)) {
                for (const it of b.content) {
                    if ((it.type === 'image' || it.type === 'video') && it.src) {
                        const u = resolveAsset(it.src, b)
                        if (u) files.add(u)
                    }
                }
            }
        }
    }
    // always include the manifest itself
    files.add((new URL('/content.json', baseUrl)).toString())
    return Array.from(files)
}

async function runUpdater(options) {
    // options: { distDir, remoteBaseUrl, onProgress }
    const distDir = options.distDir
    const remoteBaseUrl = options.remoteBaseUrl || 'http://127.0.0.1:5173'

    const localContentPath = path.join(distDir, 'content.json')

    // Phase mapping: analyze (0-5%), create folders (5-15%), download (15-100%)
    const PHASE = { ANALYZE_MAX: 5, CREATE_MAX: 15 }

    // helper to emit progress and status
    function emitProgress(percent, message) {
        if (options && typeof options.onProgress === 'function') options.onProgress({ percent, message })
    }
    function emitStatus(message) {
        if (options && typeof options.onProgress === 'function') options.onProgress({ percent: null, message })
    }

    // small sleep helper for pacing
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

    // Phase 1: analyze manifest
    console.log('[updater] Phase 1: analyzing manifest')
    emitProgress(0, 'Analyzing remote manifest...')

    let local = null
    if (fs.existsSync(localContentPath)) {
        try { local = JSON.parse(fs.readFileSync(localContentPath, 'utf8')) } catch (e) { local = null }
    }

    // fetch remote manifest
    let remoteRaw
    try { remoteRaw = await fetchText(remoteBaseUrl + '/content.json', 8000) } catch (e) {
        throw new Error('Failed to fetch remote content.json: ' + e.message)
    }

    let remote
    try { remote = JSON.parse(remoteRaw) } catch (e) { throw new Error('Remote content.json parse error: ' + e.message) }

    const localVer = local && local.version ? local.version : null
    const remoteVer = remote && remote.version ? remote.version : null
    if (remoteVer && localVer && remoteVer === localVer) {
        emitProgress(100, 'Content up-to-date')
        return { updated: false, reason: 'same-version', localVer, remoteVer }
    }

    // determine files to download
    let filesToDownload = []
    if (Array.isArray(remote.files) && remote.files.length > 0) {
        filesToDownload = remote.files.map(f => {
            const url = f.url ? new URL(f.url, remoteBaseUrl).toString() : new URL(f.path || '', remoteBaseUrl).toString()
            return { url, path: f.path || path.basename(url), size: f.size }
        })
    } else {
        const inferred = inferFilesFromManifest(remote, remoteBaseUrl)
        filesToDownload = inferred.map(u => ({ url: u, path: (new URL(u)).pathname }))
    }

    // Phase 2: create folders in temp area (report progress between 5-15%)
    const tmpRoot = path.join(distDir, '..', '.update_tmp')
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
    ensureDir(tmpRoot)

    emitStatus('Creating folders...')
    console.log('[updater] Phase 2: creating folders')
    const totalFiles = filesToDownload.length
    for (let i = 0; i < totalFiles; i++) {
        const f = filesToDownload[i]
        const u = new URL(f.url)
        const relPath = u.pathname.replace(/^\//, '')
        const dest = path.join(tmpRoot, relPath)
        ensureDir(path.dirname(dest))
        // map progress across the create phase
        const createPct = PHASE.ANALYZE_MAX + ((i + 1) / Math.max(1, totalFiles)) * (PHASE.CREATE_MAX - PHASE.ANALYZE_MAX)
        emitProgress(Math.min(PHASE.CREATE_MAX, createPct), `Prepared folder for ${relPath}`)
        console.log(`[updater] Prepared folder for ${relPath}`)
        // brief pause so user can follow folder creation
        await sleep(500)
    }

    // Phase 3: download each file individually (report progress 15-100%)
    emitStatus('Downloading files...')
    console.log('[updater] Phase 3: downloading files')
    let downloaded = 0
    for (let idx = 0; idx < totalFiles; idx++) {
        const f = filesToDownload[idx]
        const u = new URL(f.url)
        const relPath = u.pathname.replace(/^\//, '')
        const dest = path.join(tmpRoot, relPath)
        try {
            await downloadToFile(f.url, dest, 20000, (progress) => {
                // progress: compute overall percent mapping
                const fileFraction = totalFiles > 0 ? (idx + (progress.total ? (progress.received / progress.total) : 0)) / totalFiles : 0
                const overall = PHASE.CREATE_MAX + fileFraction * (100 - PHASE.CREATE_MAX)
                emitProgress(Math.min(100, overall), `Downloading ${relPath}`)
            })
            downloaded++
            const overallAfter = PHASE.CREATE_MAX + (downloaded / totalFiles) * (100 - PHASE.CREATE_MAX)
            emitProgress(Math.min(100, overallAfter), `Downloaded ${relPath}`)
            console.log(`[updater] Downloaded ${relPath}`)
            // brief pause so you can follow progress
            await sleep(500)
        } catch (e) {
            try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) { }
            throw new Error('Failed to download ' + f.url + ': ' + e.message)
        }
    }

    // move tmp files into place: replace distDir/books and distDir/content.json
    // we will move files into a new dist_tmp and rename
    const distTmp = path.join(distDir, '..', '.dist_tmp')
    try { if (fs.existsSync(distTmp)) fs.rmSync(distTmp, { recursive: true, force: true }) } catch (e) { }
    ensureDir(distTmp)

    // copy existing dist contents into distTmp, then overwrite with tmpRoot contents
    function copyRecursive(src, dest) {
        if (!fs.existsSync(src)) return
        const st = fs.statSync(src)
        if (st.isDirectory()) {
            ensureDir(dest)
            for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dest, name))
        } else {
            ensureDir(path.dirname(dest))
            fs.copyFileSync(src, dest)
        }
    }

    // copy original dist into distTmp
    copyRecursive(distDir, distTmp)
    // overlay downloaded files from tmpRoot into distTmp
    copyRecursive(tmpRoot, distTmp)

    // swap: rename dist to dist.bak, distTmp to dist
    const distBak = distDir + '.bak'
    try {
        if (fs.existsSync(distBak)) fs.rmSync(distBak, { recursive: true, force: true })
        fs.renameSync(distDir, distBak)
        fs.renameSync(distTmp, distDir)
        // remove bak
        fs.rmSync(distBak, { recursive: true, force: true })
        // cleanup tmpRoot
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch (e) {
        // attempt rollback
        try { if (fs.existsSync(distBak) && !fs.existsSync(distDir)) fs.renameSync(distBak, distDir) } catch (e2) { }
        throw new Error('Failed to swap dist directories: ' + e.message)
    }

    return { updated: true, localVer, remoteVer }
}

module.exports = { runUpdater }
