// Clicks through the Browse page's sort menu on a copy of a real profile and counts the mod cards each order
// shows, with a screenshot per order; then switches orders quickly and checks the last one wins.
// Read-only (nothing is installed). Usage: node scripts/probe-browse-sorts.mjs <userDataCopy> <outDir> [game name]
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const [userDataArg, outArg, gameName = "Garry's Mod"] = process.argv.slice(2)
if (!userDataArg || !outArg) throw new Error('usage: node scripts/probe-browse-sorts.mjs <userDataCopy> <outDir> [game name]')
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const env = { ...process.env, NEXUSFORGE_USER_DATA: resolve(userDataArg), NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const errors = []
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.unmaximize()
  win.setBounds({ x: 40, y: 40, width: 1280, height: 800 })
})
await page.waitForSelector('text=NexusForge')
await page.waitForTimeout(3000)

// Library -> the game -> its Browse button (Nexus Mods is the first source).
await page.locator(`button:has-text(${JSON.stringify(gameName)})`).first().click()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Browse', exact: true }).first().click()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Nexus Mods', exact: true }).first().click()

const cards = () => page.locator('div.grid > button').count()
const settle = async () => {
  // Wait until the skeletons are gone and the grid stops changing.
  let last = -1
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500)
    const skeletons = await page.locator('.skeleton').count()
    const n = await cards()
    if (!skeletons && n === last) return n
    last = n
  }
  return last
}
const sortButton = () => page.locator('button:has(svg.lucide-arrow-down-wide-narrow)').first()
const choose = async (label) => {
  await sortButton().click()
  await page.waitForTimeout(250)
  await page.locator('button', { hasText: label }).last().click()
}

const labels = ['Top rated', 'Most downloaded', 'Popular right now', 'Trending', 'Recently added', 'Recently updated']
const rows = []
for (const label of labels) {
  await choose(label)
  const n = await settle()
  const note = await page.locator('p:has(svg.lucide-info)').first().textContent().catch(() => '')
  rows.push({ label, cards: n, note })
  console.log(`${label}: ${n} cards  ${note ?? ''}`)
  await page.screenshot({ path: join(out, `${label.replace(/\s+/g, '-').toLowerCase()}.png`) })
}

// Quick switching: four orders in a row without waiting; the grid must end up with the last one's list.
for (const label of ['Trending', 'Top rated', 'Popular right now', 'Trending']) await choose(label)
const fast = await settle()
const shown = await sortButton().textContent()
console.log(`fast switching ended on "${shown}" with ${fast} cards`)
await page.screenshot({ path: join(out, 'fast-switch.png') })

writeFileSync(join(out, 'result.json'), JSON.stringify({ game: gameName, rows, fast: { shown, cards: fast }, errors }, null, 1))
console.log(errors.length ? `renderer errors: ${errors.join(' | ')}` : 'no renderer errors')
await app.close()
