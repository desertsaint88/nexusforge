// Runs IPC calls inside the app and prints a short summary of each result (read-only use only).
//   PROBE_CALLS='[["sources:search","beamng","hirochi","@game:BeamNG.drive"]]'
//   NODE_OPTIONS=--require scripts/invoke-probe.cjs  NEXUSFORGE_USER_DATA=<profile copy>  electron .
// "@game:<name>" is replaced by that game's id.
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String((err && err.stack) || err) })))
}, 0)

async function probe() {
  await wait(Number(process.env.PROBE_WAIT || 5000))
  const win = electron.BrowserWindow.getAllWindows()[0]
  const invoke = (...args) =>
    win.webContents.executeJavaScript(
      `window.nexus.invoke(${args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`
    )
  const games = (await invoke('library:list')).r ?? []
  const out = []
  for (const call of JSON.parse(process.env.PROBE_CALLS || '[]')) {
    const args = call.map((a) => (typeof a === 'string' && a.startsWith('@game:') ? games.find((g) => g.name === a.slice(6))?.id : a))
    const t = Date.now()
    const res = await invoke(...args)
    const r = res.r
    const summary = !res.ok ? `ERROR ${res.error}` : Array.isArray(r) ? `${r.length} items: ${r.slice(0, 4).map((x) => x.name ?? x.id ?? JSON.stringify(x).slice(0, 60)).join(' | ')}` : r && r.results ? `${r.results.length} results (more=${r.more}): ${r.results.slice(0, 4).map((x) => x.name).join(' | ')}` : JSON.stringify(r)?.slice(0, 300)
    out.push(`${call[0]} ${JSON.stringify(call.slice(1))} -> ${summary} (${Date.now() - t} ms)`)
  }
  finish({ out })
}

function finish(result) {
  console.log('[invoke-probe] ' + JSON.stringify(result, null, 1))
  electron.app.exit(0)
}
