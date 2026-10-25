// Checks the 1.3 features on a copy of a real profile, read-only: the update check for every game with mods
// from a source, and "Load more" (page 2 of each site's list differs from page 1 and continues it).
//   NODE_OPTIONS=--require scripts/features-probe.cjs  NEXUSFORGE_USER_DATA=<profile copy>  electron .
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const out = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'features.json')
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

async function probe() {
  const { BrowserWindow } = electron
  await wait(6000)
  const win = BrowserWindow.getAllWindows()[0]
  const invoke = (...args) =>
    win.webContents.executeJavaScript(`window.nexus.invoke(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`)
  const games = (await invoke('library:list')).r
  const result = { updates: [], paging: [] }

  for (const g of games) {
    const mods = (await invoke('mods:list', g.id)).r ?? []
    const sourced = mods.filter((m) => m.source && m.source.sourceId)
    if (!sourced.length) continue
    const t = Date.now()
    const u = await invoke('mods:checkUpdates', g.id, true)
    result.updates.push({
      game: g.name,
      mods: sourced.map((m) => `${m.name} [${m.source.sourceId} ${m.source.versionId ?? ''}] v${m.version ?? '?'}`),
      updates: u.ok ? u.r.map((x) => `${x.name}: ${x.currentVersion ?? '?'} -> ${x.latestVersion ?? x.latestName} (file ${x.latestVersionId})`) : u.error,
      ms: Date.now() - t
    })
  }

  const byName = (n) => games.find((g) => g.name === n)?.id
  const cases = [
    ['nexus', 'Grand Theft Auto V', 'endorsed'],
    ['nexus', 'Grand Theft Auto V', 'newest'],
    ['steamworkshop', "Garry's Mod", 'downloads'],
    ['steamworkshop', 'People Playground', 'newest'],
    ['beamng', 'BeamNG.drive', 'downloads'],
    ['moddb', "Garry's Mod", 'downloads'],
    ['modrinth', undefined, 'downloads']
  ]
  for (const [source, game, sort] of cases) {
    const gid = game ? byName(game) : undefined
    const p0 = await invoke('sources:query', source, '', gid, { sort })
    const p1 = await invoke('sources:query', source, '', gid, { sort, page: 1 })
    const a = p0.ok ? p0.r.results.map((x) => x.id) : []
    const b = p1.ok ? p1.r.results.map((x) => x.id) : []
    const overlap = b.filter((id) => a.includes(id)).length
    result.paging.push({ source, game, sort, page1: a.length, page2: b.length, overlap, more: p0.ok ? p0.r.more : p0.error, error: p1.ok ? undefined : p1.error, firstOfPage2: p1.ok ? p1.r.results[0]?.name : undefined })
  }
  finish(result)
}

function finish(result) {
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log('[features-probe] done ' + out)
  electron.app.exit(0)
}
