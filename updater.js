const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const { spawn } = require('child_process')

function fetchText(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http
        const req = client.get(url, (res) => {
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
        const client = url.startsWith('https://') ? https : http
        const req = client.get(url, (res) => {
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

    // Accept either a top-level `books` array (legacy) or `collections` where
    // each collection contains a `books` array. This keeps the updater
    // compatible while the new content model rolls out.
    if (manifest) {
        const handleBook = (b) => {
            if (!b) return
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

        if (Array.isArray(manifest.books)) {
            for (const b of manifest.books) handleBook(b)
        }

        if (Array.isArray(manifest.collections)) {
            for (const col of manifest.collections) {
                if (!col) continue
                if (Array.isArray(col.books)) {
                    for (const b of col.books) handleBook(b)
                }
            }
        }
    }
    // always include the manifest itself
    files.add((new URL('/content.json', baseUrl)).toString())
    return Array.from(files)
}

// Parse HTML content and extract asset URLs (src/href and inline CSS url(...)).
function parseHtmlForAssets(html, baseUrl) {
    const urls = new Set()
    if (!html) return []
    // extract src and href attributes
    const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi
    let m
    while ((m = attrRe.exec(html)) !== null) {
        const v = m[1].trim()
        if (!v) continue
        if (v.startsWith('data:')) continue
        if (v.startsWith('javascript:')) continue
        try {
            const resolved = new URL(v, baseUrl).toString()
            urls.add(resolved)
        } catch (e) {
            // ignore bad urls
        }
    }
    // also look for inline style url(...) occurrences
    const cssUrlRe = /url\((?:\s*['"]?)([^'")]+)(?:['"]?\s*)\)/gi
    while ((m = cssUrlRe.exec(html)) !== null) {
        const v = m[1].trim()
        if (!v) continue
        if (v.startsWith('data:')) continue
        try {
            const resolved = new URL(v, baseUrl).toString()
            urls.add(resolved)
        } catch (e) { }
    }
    return Array.from(urls)
}

// Parse CSS text and return referenced urls via url(...)
function parseCssForAssets(cssText, baseUrl) {
    const urls = new Set()
    if (!cssText) return []
    const cssUrlRe = /url\((?:\s*['"]?)([^'")]+)(?:['"]?\s*)\)/gi
    let m
    while ((m = cssUrlRe.exec(cssText)) !== null) {
        const v = m[1].trim()
        if (!v) continue
        if (v.startsWith('data:')) continue
        try {
            const resolved = new URL(v, baseUrl).toString()
            urls.add(resolved)
        } catch (e) { }
    }
    return Array.from(urls)
}

// Generate TTS WAV files for books that contain a `paragraphs` array.
// Writes files into the temporary update folder (tmpRoot) under /books/{id}/tts.wav
// If a remote TTS URL exists, download it instead of generating locally.
async function generateTtsFiles(manifest, tmpRoot, options, emitProgress, remoteBaseUrl) {
    if (!manifest) return 0

    const books = []
    const collect = (b) => {
        if (!b) return
        if (Array.isArray(b.paragraphs) && b.paragraphs.length > 0) {
            books.push(b)
            return
        }
        if (Array.isArray(b.content)) {
            for (const it of b.content) {
                if (it && it.type === 'paragraph' && typeof it.text === 'string' && it.text.trim() !== '') {
                    books.push(b)
                    return
                }
            }
        }
    }

    if (Array.isArray(manifest.books)) manifest.books.forEach(collect)
    if (Array.isArray(manifest.collections)) {
        for (const col of manifest.collections) {
            if (!col || !Array.isArray(col.books)) continue
            for (const b of col.books) collect(b)
        }
    }

    const total = books.length
    if (total === 0) return 0

    const DOWNLOAD_MAX = 90
    for (let i = 0; i < total; i++) {
        const book = books[i]
        const rel = `/books/${book.id}/tts.wav`
        const outPath = path.join(tmpRoot, rel.replace(/^\//, ''))
        ensureDir(path.dirname(outPath))

        try {
            // Determine remote TTS URL (you can adapt logic, e.g., remoteBaseUrl + /books/{id}/tts.wav)
            const ttsUrl = (remoteBaseUrl ? new URL(`/books/${book.id}/tts.wav`, remoteBaseUrl).toString() : null)
            if (ttsUrl) {
                console.log(`[updater] downloading TTS for book ${book.id} from remote`)
                await downloadToFile(ttsUrl, outPath, 120000, (progress) => {
                    if (emitProgress) {
                        const pct = DOWNLOAD_MAX + ((i + progress.received / (progress.total || 1)) / total) * (100 - DOWNLOAD_MAX)
                        emitProgress(Math.min(100, pct), `Downloading TTS for book ${book.id}`)
                    }
                })
            } else {
                console.warn(`[updater] no remote TTS URL for book ${book.id}, skipping`)
            }
        } catch (e) {
            console.warn('[updater] failed to download TTS for book', book.id, e && e.message)
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath) } catch (e) { }
        }

        // emit progress for this book
        if (typeof emitProgress === 'function') {
            const pct = DOWNLOAD_MAX + ((i + 1) / total) * (100 - DOWNLOAD_MAX)
            emitProgress(Math.min(100, pct), `Processed TTS for book ${book.id}`)
        }
    }
    return total
}

async function runUpdater(options) {
    // options: { distDir, remoteBaseUrl, onProgress }
    const distDir = options.distDir
    const remoteBaseUrl = options.remoteBaseUrl || 'http://127.0.0.1:5173'

    const localContentPath = path.join(distDir, 'content.json')

    // Phase mapping: analyze (0-5%), create folders (5-15%), download (15-90%), tts (90-100%)
    const PHASE = { ANALYZE_MAX: 5, CREATE_MAX: 15, DOWNLOAD_MAX: 90 }

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
    // Support both legacy `books` and new `collections` structures. Log a brief
    // diagnostic about what we found so update traces are clearer.
    try {
        if (Array.isArray(remote.books)) {
            console.log('[updater] remote manifest books:', remote.books.length)
        } else if (Array.isArray(remote.collections)) {
            let totalBooks = 0
            for (const c of remote.collections) if (c && Array.isArray(c.books)) totalBooks += c.books.length
            console.log('[updater] remote manifest collections:', remote.collections.length, 'total books:', totalBooks)
        } else {
            console.log('[updater] remote manifest has no books or collections')
        }
    } catch (e) { console.log('[updater] manifest inspection failed:', e && e.message) }

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
        // infer from manifest
        const inferred = inferFilesFromManifest(remote, remoteBaseUrl)

        // also try to fetch index.html and parse it for assets (scripts, links, imgs, sources)
        let indexAssets = []
        try {
            const indexHtml = await fetchText(remoteBaseUrl + '/index.html', 6000)
            indexAssets = parseHtmlForAssets(indexHtml, remoteBaseUrl)
            // for any linked CSS files, fetch them and extract url(...) references
            const cssFiles = indexAssets.filter(u => u.endsWith('.css'))
            for (const cssUrl of cssFiles) {
                try {
                    const cssText = await fetchText(cssUrl, 5000)
                    const cssAssets = parseCssForAssets(cssText, cssUrl)
                    for (const a of cssAssets) indexAssets.push(a)
                } catch (e) {
                    // ignore CSS fetch errors
                }
            }
        } catch (e) {
            console.warn('[updater] could not fetch/parse index.html:', e && e.message)
        }

        const merged = new Set(inferred.concat(indexAssets))
        // ensure index.html itself is included
        merged.add((new URL('/index.html', remoteBaseUrl)).toString())
        filesToDownload = Array.from(merged).map(u => ({ url: u, path: (new URL(u)).pathname }))
    }

    // Phase 2: create folders in temp area (report progress between 5-15%)
    const tmpRoot = path.join(distDir, '..', '.update_tmp')
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
    ensureDir(tmpRoot)

    emitStatus('Creating folders...')
    console.log('[updater] Phase 2: creating folders')
    // Debug: list files we plan to download
    console.log('[updater] filesToDownload:', filesToDownload.map(f => ({ url: f.url, path: f.path, size: f.size })))

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
            // increase per-file timeout for potentially large video files (120s)
            await downloadToFile(f.url, dest, 120000, (progress) => {
                // progress: compute overall percent mapping (map downloads into CREATE_MAX..DOWNLOAD_MAX)
                const fileFraction = totalFiles > 0 ? (idx + (progress.total ? (progress.received / progress.total) : 0)) / totalFiles : 0
                const overall = PHASE.CREATE_MAX + fileFraction * (PHASE.DOWNLOAD_MAX - PHASE.CREATE_MAX)
                emitProgress(Math.min(PHASE.DOWNLOAD_MAX, overall), `Downloading ${relPath}`)
            })
            downloaded++
            // Verify file size is non-zero
            try {
                const st = fs.statSync(dest)
                if (!st || st.size === 0) throw new Error('Downloaded file size is zero')
            } catch (statErr) {
                try { fs.rmSync(dest, { force: true }) } catch (e) { }
                throw new Error(`Downloaded file invalid for ${f.url}: ${statErr && statErr.message}`)
            }
            const overallAfter = PHASE.CREATE_MAX + (downloaded / totalFiles) * (PHASE.DOWNLOAD_MAX - PHASE.CREATE_MAX)
            emitProgress(Math.min(PHASE.DOWNLOAD_MAX, overallAfter), `Downloaded ${relPath}`)
            console.log(`[updater] Downloaded ${relPath}`)
            // brief pause so you can follow progress
        } catch (e) {
            try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) { }
            throw new Error('Failed to download ' + f.url + ': ' + e.message)
        }
    }

    // Phase 4: generate TTS audio for books that have paragraphs
    emitStatus('Generating TTS audio files...')
    console.log('[updater] Phase 4: generating tts files')
    try {
        // best-effort: generate WAV files under tmpRoot/books/{id}/tts.wav
        await generateTtsFiles(remote, tmpRoot, options, emitProgress, remoteBaseUrl)
    } catch (e) {
        console.warn('[updater] TTS generation failed:', e && e.message)
        // don't abort update; TTS is optional
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
        // write a small marker to help debug and to indicate update time
        try {
            const marker = path.join(distDir, '.updated_at')
            fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
            console.log('[updater] update completed, marker written to', marker)
        } catch (e) { }
    } catch (e) {
        // attempt rollback
        try { if (fs.existsSync(distBak) && !fs.existsSync(distDir)) fs.renameSync(distBak, distDir) } catch (e2) { }
        throw new Error('Failed to swap dist directories: ' + e.message)
    }

    return { updated: true, localVer, remoteVer }
}

// Check-only function: fetch remote content.json and compare versions with local.
// Returns { available: boolean, localVer, remoteVer }
async function checkForUpdate(options) {
    const distDir = options.distDir
    const remoteBaseUrl = options.remoteBaseUrl || 'http://127.0.0.1:5173'
    const localContentPath = path.join(distDir, 'content.json')

    let local = null
    if (fs.existsSync(localContentPath)) {
        try { local = JSON.parse(fs.readFileSync(localContentPath, 'utf8')) } catch (e) { local = null }
    }

    let remoteRaw
    try { remoteRaw = await fetchText(remoteBaseUrl + '/content.json', 8000) } catch (e) {
        throw new Error('Failed to fetch remote content.json: ' + e.message)
    }
    let remote
    try { remote = JSON.parse(remoteRaw) } catch (e) { throw new Error('Remote content.json parse error: ' + e.message) }

    const localVer = local && local.version ? local.version : null
    const remoteVer = remote && remote.version ? remote.version : null
    const available = Boolean(remoteVer && (!localVer || remoteVer !== localVer))
    return { available, localVer, remoteVer }
}

module.exports = { runUpdater, checkForUpdate }
