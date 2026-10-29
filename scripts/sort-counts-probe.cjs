// Counts how many mods every source lists per game and sort order (the Browse page's "sources:query"), first page
// and the next page, and then switches orders quickly the way a user does, to find lists that come back short.
//   PROBE_GAMES='Garry|Grand Theft|BeamNG|People Playground|Watch_Dogs|Ready or Not'
//   NODE_OPTIONS=--require scripts/sort-counts-probe.cjs  NEXUSFORGE_USER_DATA=<profile copy>  electron .
// Read-only. Result: .smoke/sort-counts/result.json
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'sort-counts')
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => run().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

async function run() {
  await wait(Number(process.env.PROBE_WAIT || 6000))
  const win = electron.BrowserWindow.getAllWindows()[0]
  win.hide()
  const invoke = (...args) =>
    win.webContents.executeJavaScript(
      `window.nexus.invoke(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`
    )
  const games = (await invoke('library:list')).r ?? []
  const re = new RegExp(process.env.PROBE_GAMES || "Garry|Grand Theft Auto V|BeamNG|People Playground|Watch_Dogs|Ready or Not")
  const picked = games.filter((g) => re.test(g.name))
  const sources = ((await invoke('sources:list')).r ?? []).filter((s) => s.enabled && (!process.env.PROBE_SOURCES || process.env.PROBE_SOURCES.split(',').includes(s.id)))
  const rows = []
  for (const s of sources) {
    for (const g of picked) {
      for (const sort of (s.sorts ?? ['endorsed']).filter((x) => x !== 'relevance')) {
        const t = Date.now()
        const p0 = await invoke('sources:query', s.id, '', g.id, { sort })
        const row = { source: s.id, game: g.name, sort, ms: Date.now() - t }
        if (!p0.ok) {
          row.error = p0.error
          rows.push(row)
          console.log(`[sort-counts] ${s.id} | ${g.name} | ${sort}: ERROR ${p0.error.slice(0, 120)}`)
          // A game the source doesn't have fails the same way for every order.
          if (/not on|only has|no .*community|choose|api key/i.test(p0.error)) break
          continue
        }
        const r = p0.r
        row.count = r.results.length
        row.more = r.more
        row.windowDays = r.windowDays
        row.widenedFrom = r.widenedFrom
        row.filled = r.filled
        row.uniqueIds = new Set(r.results.map((x) => x.id)).size
        if (r.more) {
          const p1 = await invoke('sources:query', s.id, '', g.id, { sort, page: 1, windowDays: r.windowDays, fillSort: r.filled && r.filled.sort })
          row.page1 = p1.ok ? p1.r.results.length : `ERROR ${p1.error}`
          if (p1.ok) row.page1New = p1.r.results.filter((x) => !r.results.some((y) => y.id === x.id)).length
        }
        rows.push(row)
        const how = [row.windowDays !== undefined && `window ${row.windowDays} d`, row.widenedFrom && `site's ${row.widenedFrom.days} d had ${row.widenedFrom.count}`, row.filled && `${row.filled.count} + rest by ${row.filled.sort}`].filter(Boolean).join(', ')
        console.log(`[sort-counts] ${s.id} | ${g.name} | ${sort}: ${row.count}${how ? ` (${how})` : ''} more=${row.more} page1=${row.page1 ?? '-'}${row.page1New !== undefined ? `/${row.page1New} new` : ''} (${row.ms} ms)`)
      }
    }
  }

  // Quick switching: fire every order without waiting, as clicking through the menu does, and check each answer.
  const burst = []
  for (const s of sources.filter((x) => ['nexus', 'steamworkshop'].includes(x.id))) {
    const g = picked.find((x) => rows.some((r) => r.source === s.id && r.game === x.name && r.count))
    if (!g) continue
    const sorts = (s.sorts ?? []).filter((x) => x !== 'relevance')
    const all = await Promise.all(sorts.map((sort) => invoke('sources:query', s.id, '', g.id, { sort })))
    sorts.forEach((sort, i) => burst.push({ source: s.id, game: g.name, sort, count: all[i].ok ? all[i].r.results.length : `ERROR ${all[i].error}` }))
  }
  finish({ rows, burst })
}

function finish(result) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 1))
  console.log('[sort-counts] done ' + (result.error ?? `${result.rows.length} lists`))
  electron.app.exit(0)
}
