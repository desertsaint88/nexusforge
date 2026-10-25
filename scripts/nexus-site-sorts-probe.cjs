// Records how the Nexus Mods website itself lists a game's mods for each sort order: the GraphQL request the
// page sends (filter + sort) and the mod ids it shows, in order. Used to check NexusForge's orders against the
// site. Loaded into the app's main process like the other probes:
//   NODE_OPTIONS=--require scripts/nexus-site-sorts-probe.cjs  NEXUSFORGE_USER_DATA=<profile>  electron .
// Read-only: pages are loaded and read, nothing is clicked except the sort menu.
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'nexus-site-sorts')
const domain = process.env.PROBE_GAME || 'garrysmod'
const sorts = (process.env.PROBE_SORTS || ',endorsements,downloads,createdAt,updatedAt,trending,uniqueDownloads').split(',')
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

const LIST = `(() => {
  const ids = [];
  for (const a of document.querySelectorAll('a[href*="/mods/"]')) {
    const m = a.getAttribute('href').match(/\\/mods\\/(\\d+)/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  const sortUi = [...document.querySelectorAll('select, [role=combobox], button')].map((el) => (el.innerText || el.value || '').trim()).filter((t) => /sort|endorse|download|trend|updated|published|date/i.test(t)).slice(0, 10);
  const options = [...document.querySelectorAll('select option, [role=option]')].map((o) => (o.innerText || '').trim() + (o.value ? ' = ' + o.value : '')).slice(0, 30);
  return { url: location.href, title: document.title, ids: ids.slice(0, 40), sortUi, options };
})()`

async function probe() {
  const { app, BrowserWindow, session } = electron
  await wait(4000)
  for (const w of BrowserWindow.getAllWindows()) w.hide()
  mkdirSync(outDir, { recursive: true })
  const s = session.fromPartition('persist:nexusmods')
  s.setUserAgent(app.userAgentFallback)
  const gql = []
  s.webRequest.onBeforeRequest({ urls: ['*://*.nexusmods.com/*graphql*'] }, (d, cb) => {
    try {
      const raw = d.uploadData && d.uploadData[0] && d.uploadData[0].bytes ? d.uploadData[0].bytes.toString('utf8') : ''
      if (raw) {
        const body = JSON.parse(raw)
        for (const b of Array.isArray(body) ? body : [body]) {
          if (/mods\s*\(|mods\(/i.test(b.query || '') || /mods/i.test(b.operationName || '')) gql.push({ url: d.url, op: b.operationName, variables: b.variables, query: (b.query || '').slice(0, 1500) })
        }
      }
    } catch {}
    cb({})
  })
  const win = new BrowserWindow({ width: 1400, height: 1000, show: true, title: 'NexusForge site-sort probe', webPreferences: { partition: 'persist:nexusmods', sandbox: true, contextIsolation: true } })
  const wc = win.webContents
  const pages = []
  for (const sort of sorts) {
    gql.length = 0
    const url = `https://www.nexusmods.com/games/${domain}/mods${sort ? `?sort=${sort}` : ''}`
    await wc.loadURL(url).catch(() => {})
    await wait(9000)
    const list = await wc.executeJavaScript(LIST).catch((err) => ({ error: err.message }))
    pages.push({ sort, ...list, gql: gql.map((g) => ({ url: g.url, op: g.op, variables: g.variables })), query: gql[0] && gql[0].query })
  }
  win.destroy()
  finish({ domain, pages })
}

function finish(result) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${domain}.json`), JSON.stringify(result, null, 2))
  console.log('[nexus-site-sorts-probe] done')
  electron.app.exit(0)
}
