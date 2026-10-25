// Diagnoses Cloudflare Turnstile on the Nexus login inside Electron: loads the page with a given browser
// profile variant, clicks the checkbox like a person would (real screen coordinates) and reports what the
// widget and Turnstile's console output say.
// Usage: electron scripts/turnstile-probe.cjs variant=<ua>[+chrome] [url=...]
//   ua: current (the app's old Chrome/140 UA) | real (Chrome/<major>.0.0.0) | electron (default) | stripped
//   +chrome: fills in window.chrome like Google Chrome has it
const { app, BrowserWindow, session, screen } = require('electron')
const { join } = require('path')
const fs = require('fs')

const arg = (k, d) => process.argv.find((a) => a.startsWith(k + '='))?.slice(k.length + 1) ?? d
const variant = arg('variant', 'current')
const url = arg('url', 'https://users.nexusmods.com/auth/sign_in')
const [uaVariant, ...flags] = variant.split('+')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const shots = join(__dirname, '..', '.smoke')
const timeout = (p, ms, fallback) => Promise.race([p, wait(ms).then(() => fallback)])
const snap = async (wc, file) => {
  const img = await timeout(wc.capturePage(), 4000, null)
  if (img) fs.writeFileSync(join(shots, file), img.toPNG())
}

// A test window behind other windows would otherwise stop painting (and capturePage would never return).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

process.on('uncaughtException', (err) => console.log(`[${variant}] main error: ${err.stack}`))

app.whenReady().then(async () => {
  console.log(`[${variant}] start ${url}`)
  setTimeout(() => {
    console.log(`[${variant}] RESULT: probe timed out`)
    app.exit(2)
  }, 100_000)
  const part = `tsprobe-${variant}-${Date.now()}`
  const s = session.fromPartition(part)
  const major = process.versions.chrome.split('.')[0]
  const uas = {
    current: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    real: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  }
  if (uas[uaVariant]) s.setUserAgent(uas[uaVariant])
  if (uaVariant === 'stripped') s.setUserAgent(s.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*nexusforge\/\S+/i, ''))
  // What the packaged app sends when it leaves the user agent alone.
  if (uaVariant === 'app') s.setUserAgent(s.getUserAgent().replace(/\s*(electron\/\S+\s+)?(?=Chrome\/)/i, ' NexusForge/1.1.0 '))
  const display = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    x: display.x + display.width - 1040,
    y: display.y + 40,
    width: 1000,
    height: 760,
    show: false,
    title: 'NexusForge login test',
    webPreferences: {
      partition: part,
      sandbox: true,
      contextIsolation: true,
      nodeIntegrationInSubFrames: flags.includes('chrome'),
      preload: flags.includes('chrome') ? join(__dirname, 'turnstile-probe-preload.cjs') : undefined
    }
  })
  win.showInactive()
  const wc = win.webContents
  const consoleLines = []
  wc.on('console-message', (e, level, message) => {
    const text = String((typeof message === 'string' ? message : e.message) ?? '')
    if (/turnstile|cloudflare|challenge|error/i.test(text)) consoleLines.push(text.slice(0, 200))
  })
  await wc.loadURL(url).catch(() => {})
  const fp = await wc.executeJavaScript(`(async () => ({
    ua: navigator.userAgent,
    brands: navigator.userAgentData && navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version).join(', '),
    webdriver: navigator.webdriver, chromeKeys: window.chrome ? Object.keys(window.chrome).join(',') : 'none',
    notif: typeof Notification !== 'undefined' ? Notification.permission : 'n/a',
    notifQuery: await navigator.permissions.query({ name: 'notifications' }).then((p) => p.state).catch((e) => 'ERR'),
    langs: navigator.languages.join(',')
  }))()`)
  console.log(`[${variant}] chromium ${process.versions.chrome}`)
  console.log(`[${variant}] ${JSON.stringify(fp)}`)
  if (arg('mode', process.env.PROBE_MODE ?? '') === 'title') {
    // Interstitial bot checks ("Just a moment…"): report where the page ends up.
    for (let i = 0; i < 20; i++) {
      await wait(1000)
      const t = await timeout(wc.executeJavaScript('document.title').catch(() => ''), 3000, '')
      if (t && !/just a moment|attention required|checking/i.test(t)) {
        console.log(`[${variant}] RESULT: PASSED after ${i + 1}s, title "${t}"`)
        return app.exit(0)
      }
    }
    console.log(`[${variant}] RESULT: still challenged`)
    await snap(wc, `turnstile-${variant}-title.png`)
    return app.exit(0)
  }
  let clicked = false
  let clickedAt = 0
  let result = 'no widget'
  for (let i = 0; i < 45; i++) {
    await wait(1000)
    const token = await timeout(wc.executeJavaScript(`(document.querySelector('[name="cf-turnstile-response"]') || {}).value || ''`).catch(() => ''), 3000, '')
    if (token) {
      result = `PASSED after ${i + 1}s${clicked ? ' (clicked)' : ' (no click needed)'}, token ${token.length} chars`
      break
    }
    const frames = wc.mainFrame.framesInSubtree.filter((f) => /challenges\.cloudflare\.com/.test(f.url))
    result = `no token after ${i + 1}s, frames=${frames.length}`
    if (clicked && i === clickedAt + 6) await snap(wc, `turnstile-${variant}-after-click.png`)
    if (clicked && i > clickedAt + 14) break
    if (!clicked && frames.length && i >= 7) {
      const box = await wc.executeJavaScript(`(() => {
        const deep = (root) => { const f = root.querySelector('iframe[src*="challenges.cloudflare.com"]'); if (f) return f; for (const h of root.querySelectorAll('*')) if (h.shadowRoot) { const x = deep(h.shadowRoot); if (x) return x } return null };
        const inp = document.querySelector('[name="cf-turnstile-response"]');
        const el = deep(document) || (inp && inp.parentElement) || document.querySelector('.cf-turnstile, [data-sitekey]');
        if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
      if (box) {
        const cb = win.getContentBounds()
        const x = Math.round(box.x + 28)
        const y = Math.round(box.y + box.h / 2)
        const ev = (type, px, py, extra = {}) => ({ type, x: px, y: py, globalX: cb.x + px, globalY: cb.y + py, ...extra })
        // A curved approach with uneven steps, like a hand on a mouse.
        for (let k = 0; k <= 14; k++) {
          const t = k / 14
          wc.sendInputEvent(ev('mouseMove', Math.round(x - 160 * (1 - t) + 6 * Math.sin(t * 3)), Math.round(y + 90 * (1 - t) * (1 - t))))
          await wait(18 + Math.round(Math.random() * 25))
        }
        await wait(220)
        wc.sendInputEvent(ev('mouseDown', x, y, { button: 'left', clickCount: 1 }))
        await wait(85)
        wc.sendInputEvent(ev('mouseUp', x, y, { button: 'left', clickCount: 1 }))
        clicked = true
        clickedAt = i
        console.log(`[${variant}] clicked checkbox at ${x},${y}`)
      }
    }
  }
  console.log(`[${variant}] RESULT: ${result}`)
  if (consoleLines.length) console.log(`[${variant}] console: ${[...new Set(consoleLines)].join(' | ')}`)
  await snap(wc, `turnstile-${variant}.png`)
  app.exit(0)
})
