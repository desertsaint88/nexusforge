// Checks that NexusForge's sorted mod lists are the sites' own: for every source, game and sort order it asks the
// app (the real "sources:query" IPC, same as the Browse page) and opens the same list on the website, then
// compares the two in order. Loaded into the app's main process like the other probes:
//   NODE_OPTIONS=--require scripts/verify-sorts-probe.cjs  NEXUSFORGE_USER_DATA=<copied profile>  electron .
// Read-only: pages are opened and read, nothing is clicked. Result: .smoke/verify-sorts/result.json
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'verify-sorts')
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => run().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

// How each site names the order in its own URLs.
const NEXUS = { endorsed: 'sort=endorsements', downloads: 'sort=downloads', downloads_recent: 'sort=downloads&timeRange=28', trending: 'sort=endorsements&timeRange=7', newest: 'sort=createdAt', updated: 'sort=updatedAt' }
const STEAM = { endorsed: 'browsesort=toprated&days=-1', downloads: 'browsesort=totaluniquesubscribers&days=-1', downloads_recent: 'browsesort=trend&days=30', trending: 'browsesort=trend&days=7', newest: 'browsesort=mostrecent&days=-1', updated: 'browsesort=lastupdated&days=-1' }
const MODDB = { endorsed: 'sort=rating-desc', downloads: 'sort=downloadstotal-desc', trending: 'sort=ranktoday-asc', newest: 'sort=id-desc', updated: 'sort=dateup-desc' }
const BEAMNG = { endorsed: 'order=rating_weighted', downloads: 'order=download_count', newest: 'order=resource_date', updated: 'order=last_update' }

// Mod ids in the order the page shows them (document order of links to mod pages).
const scrape = (pattern, scope, links = 'a[href]') => `(() => {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)}) || document` : 'document'};
  const re = new RegExp(${JSON.stringify(pattern)});
  const ids = [];
  for (const a of root.querySelectorAll(${JSON.stringify(links)})) {
    const m = (a.getAttribute('href') || '').match(re);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return { ids, title: document.title, url: location.href };
})()`

async function siteIds(win, url, pattern, scope, links) {
  await win.webContents.loadURL(url).catch(() => {})
  let last = { ids: [] }
  // Pages render their lists after load (Nexus, Steam); wait until the list stops changing (an empty list
  // has to stay empty for a while too).
  for (let i = 0; i < 12; i++) {
    await wait(1500)
    const r = await win.webContents.executeJavaScript(scrape(pattern, scope, links)).catch(() => ({ ids: [] }))
    if ((r.ids.length || i >= 4) && r.ids.join() === last.ids.join()) return r
    last = r
  }
  return last
}

function compare(app, site) {
  const n = Math.min(20, app.length, site.length)
  let same = 0
  for (let i = 0; i < n; i++) if (app[i] === site[i]) same++
  const overlap = app.slice(0, n).filter((x) => site.slice(0, n).includes(x)).length
  // Same list = same items in the same places, and neither side has items the other is missing at the top.
  const match = same === n && n === Math.min(20, Math.max(app.length, site.length))
  return { match, compared: n, samePosition: same, overlap, appCount: app.length, siteCount: site.length, app: app.slice(0, n), site: site.slice(0, n) }
}

async function run() {
  const { app, BrowserWindow, session } = electron
  await wait(6000)
  const main = BrowserWindow.getAllWindows()[0]
  main.hide()
  const invoke = (...args) => main.webContents.executeJavaScript(`window.nexus.invoke(${args.map((a) => JSON.stringify(a)).join(',')})`)
  for (const p of ['persist:nexusmods', 'persist:web']) session.fromPartition(p).setUserAgent(app.userAgentFallback)
  const games = await invoke('library:list')
  const byName = (re) => games.find((g) => re.test(g.name))
  const gmod = byName(/garry/i), gta = byName(/grand theft auto v/i), beam = byName(/beamng/i), ppg = byName(/people playground/i)

  const only = (process.env.PROBE_SOURCES || 'nexus,steamworkshop,moddb,beamng').split(',')
  const cases = []
  if (only.includes('nexus')) for (const g of [gta, gmod]) for (const s of Object.keys(NEXUS)) cases.push({ source: 'nexus', game: g, sort: s })
  if (only.includes('steamworkshop')) for (const g of [gmod, ppg, beam]) for (const s of Object.keys(STEAM)) cases.push({ source: 'steamworkshop', game: g, sort: s })
  if (only.includes('moddb')) for (const g of [gmod, beam]) for (const s of Object.keys(MODDB)) cases.push({ source: 'moddb', game: g, sort: s })
  if (only.includes('beamng')) for (const s of Object.keys(BEAMNG)) cases.push({ source: 'beamng', game: beam, sort: s })

  const wins = {}
  const win = (partition) => (wins[partition] ??= new BrowserWindow({ width: 1400, height: 1000, show: true, title: 'NexusForge sort check', webPreferences: { partition, sandbox: true, contextIsolation: true } }))
  const out = []
  for (const c of cases) {
    if (!c.game) continue
    const row = { source: c.source, game: c.game.name, sort: c.sort }
    try {
      let appIds = []
      if (c.sort !== '(default)') {
        const r = await invoke('sources:query', c.source, '', c.game.id, { sort: c.sort })
        row.approximate = Boolean(r.approximate)
        appIds = r.results.map((m) => (c.source === 'nexus' ? m.id.split('/')[2] : m.id))
        row.firstApp = r.results.slice(0, 3).map((m) => `${m.name} (${m.endorsements ?? '-'} end, ${m.downloads ?? '-'} dl, ${m.createdAt ?? m.updatedAt ?? ''})`)
      }
      let site
      if (c.source === 'nexus') {
        const domain = c.game.modding.sources.nexus
        site = await siteIds(win('persist:nexusmods'), `https://www.nexusmods.com/games/${domain}/mods?${NEXUS[c.sort]}`, '/mods/(\\d+)(?:[/?#]|$)', 'main')
      } else if (c.source === 'steamworkshop') {
        const appid = c.game.modding.sources.steamworkshop || (await invoke('sources:bindings', 'steamworkshop', c.game.id))[0]?.value
        // Item tiles have a preview image; the "how to upload" guide link at the top doesn't.
        site = await siteIds(win('persist:web'), `https://steamcommunity.com/workshop/browse/?appid=${appid}&${STEAM[c.sort]}&section=readytouseitems&numperpage=30`, 'filedetails/\\?id=(\\d+)', null, 'a[href*="filedetails"]:has(img)')
      } else if (c.source === 'moddb') {
        const slug = c.game.modding.sources.moddb || (await invoke('sources:bindings', 'moddb', c.game.id))[0]?.value
        // Only the list rows: the page also links "latest" and a popular-mods sidebar.
        site = await siteIds(win('persist:web'), `https://www.moddb.com/games/${slug}/mods${MODDB[c.sort] ? `?${MODDB[c.sort]}` : ''}`, '^(?:https://www\\.moddb\\.com)?/mods/([a-z0-9-]+)$', null, 'div.row.rowcontent h4 a[href]')
      } else {
        site = await siteIds(win('persist:web'), `https://www.beamng.com/resources/?${BEAMNG[c.sort]}`, 'resources/([a-z0-9-]+\\.\\d+)/?$', '.resourceList, ol.resourceList, .mainContent')
      }
      row.siteUrl = site.url
      row.siteIds = site.ids.slice(0, 20)
      Object.assign(row, compare(appIds, site.ids))
    } catch (err) {
      row.error = String(err.message || err)
    }
    out.push(row)
    console.log(`[verify-sorts] ${row.match ? 'MATCH' : 'DIFF '} ${row.source} ${row.game} ${row.sort}: ${row.error ?? `${row.samePosition}/${row.compared} same position (app ${row.appCount}, site ${row.siteCount})`}`)
  }
  for (const w of Object.values(wins)) w.destroy()
  finish(out)
}

function finish(result) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2))
  console.log('[verify-sorts] done')
  electron.app.exit(0)
}
