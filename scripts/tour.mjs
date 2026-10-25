// Screenshot tour of every page on a copy of a real profile (read-only: it never deploys, installs or downloads).
// Usage: node scripts/tour.mjs <userDataCopy> <outDir> [width] [height] [packaged]
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const [userDataArg, outArg, w = '1278', h = '700', packaged] = process.argv.slice(2)
if (!userDataArg || !outArg) throw new Error('usage: node scripts/tour.mjs <userDataCopy> <outDir> [width] [height] [packaged]')
const userData = resolve(userDataArg)
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const env = { ...process.env, NEXUSFORGE_USER_DATA: userData, NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch(
  packaged ? { executablePath: join(root, 'release', 'win-unpacked', 'NexusForge.exe'), env } : { executablePath: electronPath, args: [root], env, timeout: 60_000 }
)
const errors = []
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }, [width, height]) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.unmaximize()
  win.setBounds({ x: 40, y: 40, width, height })
}, [Number(w), Number(h)])
const shot = async (name, wait = 900) => {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log('shot', name)
}
const nav = (name) => page.getByRole('button', { name, exact: true }).first().click()
const tab = (re) => page.getByRole('button', { name: re }).first().click()

await page.waitForSelector('text=NexusForge')
await shot('01-library', 4000)
await page.mouse.wheel(0, 900)
await shot('01b-library-scrolled')
const games = await page.evaluate(() => window.nexus.invoke('library:list'))
const pick = process.env.TOUR_GAME ?? 'Grand Theft Auto V'
const g = games.find((x) => x.name === pick) ?? games[0]
await page.evaluate((id) => (location.hash = ''), g.id)
await page.locator(`button:has-text(${JSON.stringify(g.name)})`).first().click()
await shot('02-game-mods', 2500)
for (const [re, name] of [
  [/^Conflicts/, '03-game-conflicts'],
  [/^Profiles/, '04-game-profiles'],
  [/^Settings/, '05-game-settings']
]) {
  await page
    .getByRole('button', { name: re })
    .nth(re.source.includes('Settings') ? 1 : 0)
    .click()
    .catch((e) => console.log('tab missing', re, e.message.split('\n')[0]))
  await shot(name)
}
await nav('Browse mods')
await shot('06-browse', 5000)
await nav('Downloads')
await shot('07-downloads')
await nav('Accounts')
await shot('08-accounts')
await nav('Settings')
await shot('09-settings')
for (const t of ['Sources & plugins', 'Mods & deployment', 'Library', 'Appearance', 'About']) {
  const b = page.getByRole('button', { name: t, exact: true })
  if ((await b.count()) > 1) {
    await b.nth(1).click()
    await shot(`09-settings-${t.replace(/\W+/g, '-').toLowerCase()}`)
  }
}
console.log(JSON.stringify({ errors: errors.slice(0, 10), games: games.length }))
await app.close()
