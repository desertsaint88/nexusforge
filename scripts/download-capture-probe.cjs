// Tests NexusForge's page-download capture (Nexus "Slow download") against a local mock of the Nexus file page:
// a big file that arrives slowly, one whose connection drops halfway, and one cancelled mid-way.
// Nexus page addresses are redirected to the mock inside the app's Nexus session; nothing goes to nexusmods.com.
//   NODE_OPTIONS=--require scripts/download-capture-probe.cjs  NEXUSFORGE_USER_DATA=<fresh dir>  electron .
const http = require('http')
const { writeFileSync, mkdirSync, statSync, existsSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const out = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'download-capture.json')
const SIZE = 24 * 1024 * 1024
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

const PAGE = `<!doctype html><title>Mock Nexus file</title><body style="background:#222;color:#eee;font:16px sans-serif;padding:40px">
<h1>Probe mod</h1><p>Files</p><button id="slow" onclick="setTimeout(() => location.href = '/file' + location.search, 300)">Slow download</button></body>`

function serve() {
  const log = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    log.push(`${req.method} ${url.pathname}${url.search} ${req.headers.range ?? ''}`)
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(PAGE)
    }
    if (url.pathname === '/file') {
      const mode = url.searchParams.get('mode') ?? 'slow'
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const headers = { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="Probe ${mode}.zip"`, 'accept-ranges': 'bytes', etag: '"probe-1"', 'cache-control': 'no-store', 'last-modified': 'Sun, 25 Oct 2026 10:00:00 GMT' }
      if (start) res.writeHead(206, { ...headers, 'content-length': SIZE - start, 'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}` })
      else res.writeHead(200, { ...headers, 'content-length': SIZE })
      // ~3 MB/s like a free Nexus account; the "drop" file cuts the first connection at 40 %.
      let sent = start
      const chunk = Buffer.alloc(96 * 1024, 7)
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer)
        if (mode === 'drop' && !start && sent >= SIZE * 0.4) {
          clearInterval(timer)
          return req.socket.destroy()
        }
        const n = Math.min(chunk.length, SIZE - sent)
        res.write(chunk.subarray(0, n))
        sent += n
        if (sent >= SIZE) {
          clearInterval(timer)
          res.end()
        }
      }, 30)
      req.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, log })))
}

async function probe() {
  const { BrowserWindow, session, webContents } = electron
  await wait(5000)
  const { port, log } = await serve()
  // The app's Nexus session sends nexusmods.com file pages to the mock.
  session.fromPartition('persist:nexusmods').webRequest.onBeforeRequest({ urls: ['https://www.nexusmods.com/nfprobe/*'] }, (d, cb) => {
    const mode = /mods\/(\d+)/.exec(d.url)?.[1] === '2' ? 'drop' : 'slow'
    cb({ redirectURL: `http://127.0.0.1:${port}/page?mode=${mode}&n=${/mods\/(\d+)/.exec(d.url)?.[1]}` })
  })
  const win = BrowserWindow.getAllWindows()[0]
  const invoke = (...args) => win.webContents.executeJavaScript(`window.nexus.invoke(${args.map((a) => JSON.stringify(a)).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`)
  const item = async (id) => (await invoke('downloads:list')).r.find((d) => d.id === id)

  const run = async (name, modNum, { cancelAfterMs } = {}) => {
    const started = await invoke('downloads:start', { sourceId: 'nexus', modId: `nfprobe/9999/${modNum}`, versionId: '1', name })
    if (!started.ok) return { name, error: started.error }
    const id = started.r.id
    const states = []
    const note = (s) => states[states.length - 1] !== s && states.push(s)
    // The user's click on "Slow download" in the panel.
    let page
    for (let i = 0; i < 40 && !page; i++) {
      await wait(500)
      note((await item(id))?.state)
      page = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(`http://127.0.0.1:${port}/page`))
    }
    if (!page) return { name, states, error: 'download page never opened' }
    await wait(1500)
    const highlighted = await page.executeJavaScript(`document.getElementById('slow').dataset.nexusforge || ''`).catch(() => '')
    await page.executeJavaScript(`document.getElementById('slow').click()`)
    const t0 = Date.now()
    let d
    let panelClosedAt
    for (let i = 0; i < 120; i++) {
      await wait(500)
      d = await item(id)
      note(d?.state)
      if (panelClosedAt === undefined && d?.state === 'downloading') {
        const st = (await invoke('sitepanel:state')).r
        if (st && !st.open) panelClosedAt = Date.now() - t0
      }
      if (cancelAfterMs && Date.now() - t0 > cancelAfterMs && d?.state === 'downloading') {
        await invoke('downloads:cancel', id)
        cancelAfterMs = undefined
      }
      if (['completed', 'failed', 'cancelled'].includes(d?.state)) break
    }
    await wait(1200)
    const pageAlive = webContents.getAllWebContents().some((w) => !w.isDestroyed() && w.getURL().includes(`127.0.0.1:${port}`))
    const size = d?.filePath && existsSync(d.filePath) ? statSync(d.filePath).size : undefined
    return { name, states, final: d?.state, error: d?.error, received: d?.received, total: d?.total, fileSize: size, complete: size === SIZE, seconds: Math.round((Date.now() - t0) / 1000), highlighted: Boolean(highlighted), panelClosedAfterMs: panelClosedAt, pageClosedAfterwards: !pageAlive }
  }

  const results = []
  results.push(await run('Slow 24 MB file', 1))
  results.push(await run('Connection drops at 40 %', 2))
  results.push(await run('Cancelled after 3 s', 3, { cancelAfterMs: 3000 }))
  finish({ results, requests: log })
}

function finish(result) {
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log('[download-capture-probe] ' + JSON.stringify(result.results ?? result))
  electron.app.exit(0)
}
