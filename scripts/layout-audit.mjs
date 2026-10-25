// Layout audit: opens every page at a given window size on a copy of a profile and lists controls that spill out of
// their card or get clipped (text wider than its box). Read-only.  Usage: node scripts/layout-audit.mjs <userDataCopy> <width> <height> [shotsDir]
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const [userDataArg, w = '1100', h = '700', shotsArg] = process.argv.slice(2)
const userData = resolve(userDataArg)
const shots = shotsArg ? resolve(shotsArg) : undefined
if (shots) mkdirSync(shots, { recursive: true })
const env = { ...process.env, NEXUSFORGE_USER_DATA: userData, NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }, [width, height]) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.unmaximize()
  win.setBounds({ x: 40, y: 40, width, height })
}, [Number(w), Number(h)])
await page.waitForSelector('text=NexusForge')
await page.waitForTimeout(2500)

const AUDIT = () => {
  const out = []
  const desc = (el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    return `${el.tagName.toLowerCase()}${t ? ` "${t}"` : ''}`
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  // 1) controls sticking out of the card/panel they sit in
  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, .badge, span[class*="rounded-md border"]')) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    let p = el.parentElement
    while (p && !(p.classList.contains('glass') || p.getAttribute('role') === 'dialog' || p.tagName === 'MAIN')) p = p.parentElement
    if (!p) continue
    const pr = p.getBoundingClientRect()
    const over = Math.max(r.right - pr.right, pr.left - r.left)
    if (over > 1) out.push(`spills ${Math.round(over)}px out of its card: ${desc(el)}`)
  }
  // 2) single-line text cut off (no ellipsis) or wider than its box
  for (const el of document.querySelectorAll('button, a, h1, h2, h3, span, div, p, label')) {
    if (!visible(el) || el.children.length > 3) continue
    const cs = getComputedStyle(el)
    if (el.scrollWidth - el.clientWidth > 2 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0)
      out.push(`text wider than its box by ${el.scrollWidth - el.clientWidth}px: ${desc(el)}`)
  }
  return [...new Set(out)]
}

const report = {}
const run = async (name) => {
  await page.waitForTimeout(1200)
  // Walk the whole scroll height so lazily shown parts are measured too.
  const res = new Set()
  const scroller = await page.evaluateHandle(() => [...document.querySelectorAll('main, main *')].find((e) => e.scrollHeight > e.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(e).overflowY)) ?? document.scrollingElement)
  const height = await scroller.evaluate((e) => e.scrollHeight)
  for (let y = 0, i = 0; y < height && i < 12; y += Number(h) - 200, i++) {
    await scroller.evaluate((e, top) => e.scrollTo({ top }), y)
    await page.waitForTimeout(350)
    for (const x of await page.evaluate(AUDIT)) res.add(x)
    if (shots) await page.screenshot({ path: join(shots, `${name}-${i}.png`) })
  }
  await scroller.evaluate((e) => e.scrollTo({ top: 0 }))
  report[name] = [...res]
}
const nav = (name) => page.getByRole('button', { name, exact: true }).first().click()

await run('library')
const games = await page.evaluate(() => window.nexus.invoke('library:list'))
const g = games.find((x) => x.name === (process.env.TOUR_GAME ?? 'Grand Theft Auto V')) ?? games[0]
await page.locator(`button:has-text(${JSON.stringify(g.name)})`).first().click()
await run('game-mods')
for (const [re, name, nth] of [[/^Conflicts/, 'game-conflicts', 0], [/^Profiles/, 'game-profiles', 0], [/^Settings/, 'game-settings', 1]]) {
  await page.getByRole('button', { name: re }).nth(nth).click().catch(() => {})
  await run(name)
}
await nav('Browse mods')
await page.waitForTimeout(3000)
await run('browse')
await nav('Downloads')
await run('downloads')
await nav('Accounts')
await run('accounts')
await nav('Settings')
await run('settings')
for (const t of ['Library', 'Mods', 'Sources & plugins', 'Advanced']) {
  const b = page.locator('main').getByRole('button', { name: t, exact: true })
  if ((await b.count()) > 0) {
    await b.first().click()
    await run(`settings-${t.replace(/\W+/g, '-').toLowerCase()}`)
  }
}
console.log(JSON.stringify(report, null, 1))
await app.close()
