// Runs NexusForge's real "Sign in to Nexus Mods" (Accounts page) in a profile whose Nexus session is already
// logged in, and reports whether it finished signed in. Loaded into the app's main process like the other probes:
//   NODE_OPTIONS=--require scripts/nexus-signin-probe.cjs  NEXUSFORGE_USER_DATA=<profile>  electron .
// The key itself is never printed; only the account name and status from the Accounts list.
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const out = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'nexus-signin.json')
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
  const invoke = (...args) => win.webContents.executeJavaScript(`window.nexus.invoke(${args.map((a) => JSON.stringify(a)).join(',')}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, error: e.message }))`)
  const pick = (list) => list.r.filter((a) => a.id === 'nexus').map(({ signedIn, user, detail, busy }) => ({ signedIn, user, detail, busy }))[0]
  const before = pick(await invoke('accounts:list'))
  if (before.signedIn && process.env.PROBE_SIGNOUT === '1') await invoke('accounts:signOut', 'nexus')
  const started = Date.now()
  const result = await Promise.race([invoke('accounts:signIn', 'nexus', false), wait(90_000).then(() => ({ ok: false, error: 'no result after 90 s' }))])
  const after = pick(await invoke('accounts:list'))
  const img = await win.webContents.capturePage().catch(() => undefined)
  if (img) writeFileSync(out.replace(/\.json$/, '.png'), img.toPNG())
  finish({ before, signIn: result.ok ? { ok: true, user: result.r.user, detail: result.r.detail } : result, seconds: Math.round((Date.now() - started) / 1000), after })
}

function finish(result) {
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log('[nexus-signin-probe] ' + JSON.stringify(result))
  electron.app.exit(0)
}
