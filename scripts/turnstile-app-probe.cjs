// Checks Cloudflare's bot check on the Nexus login inside the real app, without an automation driver (Playwright's
// DevTools connection itself makes Cloudflare ask for a click). Loaded into the app's main process with
//   NODE_OPTIONS=--require scripts/turnstile-app-probe.cjs  NEXUSFORGE_USER_DATA=<test profile>  electron .
// Starts "Sign in to Nexus Mods" from the renderer, waits for Turnstile's token in the site panel, prints the
// result and quits. Nothing is typed or submitted.
const { writeFileSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const out = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'turnstile-app.txt')
let app, BrowserWindow, webContents

// NODE_OPTIONS reaches Electron's helper processes too, and preloads run before Electron's module is ready:
// only act in the main process, once the module is there.
setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  ;({ app, BrowserWindow, webContents } = e)
  app.whenReady().then(probe)
}, 0)

async function probe() {
  await wait(5000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return finish('no window')
  const register = process.env.PROBE_REGISTER === '1'
  void win.webContents.executeJavaScript(`window.nexus.invoke('accounts:signIn', 'nexus', ${register}).catch((e) => e.message)`)
  let last = ''
  for (let i = 0; i < 45; i++) {
    await wait(1000)
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /nexusmods\.com/.test(w.getURL()))
    if (!wc) continue
    const r = await wc
      .executeJavaScript(`({ token: (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '', webdriver: navigator.webdriver, ua: navigator.userAgent })`)
      .catch(() => undefined)
    if (!r) continue
    last = `webdriver=${r.webdriver} ua=${r.ua}`
    if (r.token) {
      const img = await wc.capturePage().catch(() => undefined)
      if (img) writeFileSync(join(process.cwd(), '.smoke', 'turnstile-app.png'), img.toPNG())
      return finish(`PASSED after ${i + 1}s (token ${r.token.length} chars) ${last}`)
    }
  }
  const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /nexusmods\.com/.test(w.getURL()))
  const img = wc ? await wc.capturePage().catch(() => undefined) : undefined
  if (img) writeFileSync(join(process.cwd(), '.smoke', 'turnstile-app.png'), img.toPNG())
  finish(`NO TOKEN after 45s ${last}`)
}

function finish(result) {
  writeFileSync(out, result)
  console.log(`[app-probe] ${result}`)
  app.exit(0)
}
