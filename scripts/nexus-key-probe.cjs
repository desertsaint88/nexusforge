// Looks at what the Nexus Mods API key page shows in NexusForge's own Nexus session (a copy of the user's profile),
// to see why the sign-in never finds the key. Loaded into the app's main process with
//   NODE_OPTIONS=--require scripts/nexus-key-probe.cjs  NEXUSFORGE_USER_DATA=<copied profile>  NexusForge.exe
// Keys are never written out: anything key-shaped is replaced by its shape ("<key 24--12--12>"), and inputs and
// code blocks are blurred before the screenshot. Nothing is clicked, typed or submitted.
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = process.env.PROBE_OUT || join(process.cwd(), '.smoke', 'nexus-key-probe')
const pages = (process.env.PROBE_URLS || 'https://www.nexusmods.com/settings/api-keys,https://next.nexusmods.com/settings/api-keys,https://users.nexusmods.com/account/profile').split(',')
let electron

setTimeout(() => {
  const e = require('electron')
  if (typeof e !== 'object' || !e.app || process.type !== 'browser') return
  electron = e
  e.app.whenReady().then(() => probe().catch((err) => finish({ error: String(err && err.stack || err) })))
}, 0)

const redactUrl = (u) => {
  try {
    const x = new URL(u)
    for (const k of [...x.searchParams.keys()]) x.searchParams.set(k, '…')
    return x.toString()
  } catch {
    return u
  }
}

const PAGE_DUMP = `(() => {
  const shape = (s) => s.split('--').map((p) => p.length).join('--');
  const KEYISH = /[A-Za-z0-9+/=_\\-.$]{20,}/g;
  const red = (s) => String(s || '').replace(KEYISH, (m) => '<key ' + shape(m) + '>');
  const all = (sel) => {
    const out = [];
    const walk = (root) => { for (const el of root.querySelectorAll(sel)) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); };
    walk(document);
    return out;
  };
  const inputs = all('input, textarea').map((el) => ({ tag: el.tagName, type: el.type, name: el.name, id: el.id, placeholder: el.placeholder, readOnly: el.readOnly, valueShape: el.value ? red(el.value) : '' }));
  const buttons = all('button, a[role=button], [role=button]').map((el) => red((el.innerText || el.getAttribute('aria-label') || '').trim()).slice(0, 80)).filter(Boolean);
  const attrs = all('[value], [data-key], [data-value], [data-clipboard-text]').map((el) => el.tagName + ':' + red(el.getAttribute('value') || el.getAttribute('data-key') || el.getAttribute('data-value') || el.getAttribute('data-clipboard-text'))).slice(0, 30);
  const shadowHosts = all('*').filter((el) => el.shadowRoot).map((el) => el.tagName).slice(0, 20);
  const iframes = all('iframe').map((f) => f.src).slice(0, 10);
  const body = red((document.body && document.body.innerText) || '');
  const personal = body.search(/personal/i);
  const sections = all('h1, h2, h3, h4, [role=heading]').map((h) => (h.innerText || '').trim()).filter(Boolean).slice(0, 60);
  const personalHtml = (() => {
    const h = all('h1, h2, h3, h4, h5, p, span, div').find((el) => !el.children.length && /personal api key/i.test(el.textContent || ''));
    let box = h;
    for (let i = 0; box && i < 4; i++) box = box.parentElement;
    return box ? red(box.outerHTML).slice(0, 5000) : '';
  })();
  return { url: location.href, title: document.title, text: body.slice(0, 1500), personalText: personal >= 0 ? body.slice(Math.max(0, personal - 300), personal + 2500) : '', tail: body.slice(-2500), sections, personalHtml, inputs, buttons: [...new Set(buttons)].slice(0, 80), attrs, shadowHosts, iframes: iframes.length };
})()`

async function probe() {
  const { app, BrowserWindow, session } = electron
  await wait(4000)
  for (const w of BrowserWindow.getAllWindows()) w.hide()
  mkdirSync(outDir, { recursive: true })
  const s = session.fromPartition('persist:nexusmods')
  s.setUserAgent(app.userAgentFallback)
  const cookies = (await s.cookies.get({}))
    .filter((c) => /nexusmods/i.test(c.domain || ''))
    .map((c) => ({ domain: c.domain, name: c.name, httpOnly: c.httpOnly, session: c.session, expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : undefined, len: (c.value || '').length }))
  const result = { ua: app.userAgentFallback, cookies, pages: [] }

  const win = new BrowserWindow({ width: 1280, height: 900, show: true, title: 'NexusForge key-page probe', webPreferences: { partition: 'persist:nexusmods', sandbox: true, contextIsolation: true } })
  const wc = win.webContents
  const nav = []
  wc.on('did-redirect-navigation', (_e, url) => nav.push('redirect ' + redactUrl(url)))
  wc.on('did-navigate', (_e, url, code) => nav.push(`navigate ${code} ${redactUrl(url)}`))
  wc.on('did-navigate-in-page', (_e, url) => nav.push('in-page ' + redactUrl(url)))
  wc.on('console-message', (d) => { if (/turnstile|error/i.test(String(d.message))) nav.push('console ' + String(d.message).slice(0, 160)) })

  for (const [i, url] of pages.entries()) {
    nav.length = 0
    await wc.loadURL(url).catch((err) => nav.push('load error ' + err.message))
    await wait(Number(process.env.PROBE_WAIT || 14000))
    const dump = await wc.executeJavaScript(PAGE_DUMP).catch((err) => ({ error: err.message }))
    await wc.insertCSS('input, textarea, code, pre, kbd, samp { filter: blur(8px) !important; }').catch(() => {})
    await wait(300)
    const img = await wc.capturePage().catch(() => undefined)
    if (img) writeFileSync(join(outDir, `page-${i}.png`), img.toPNG())
    result.pages.push({ requested: url, nav: [...nav], ...dump })
  }
  win.destroy()
  finish(result)
}

function finish(result) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2))
  console.log('[nexus-key-probe] done')
  electron.app.exit(0)
}
