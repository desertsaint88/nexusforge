// Screenshots of the setup panel (Mods tab) for real games of this PC's library, read-only: a separate profile
// in .smoke/loaders-ui is used and nothing is installed or deployed.
// Usage: npm run build && node scripts/probe-loaders-ui.mjs   (screenshots in .smoke/loaders-ui/shots)
import { _electron as electron } from 'playwright-core'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'loaders-ui')
const shots = join(base, 'shots')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
// The library from a copy of the real data file (the real profile is never opened by this probe).
mkdirSync(join(base, 'userdata'), { recursive: true })
copyFileSync(join(os.homedir(), 'AppData', 'Roaming', 'NexusForge', 'nexusforge.json'), join(base, 'userdata', 'nexusforge.json'))

const env = { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata'), NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1000 }))
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])

const wanted = (process.env.GAMES ?? 'Ready or Not|Grand Theft Auto V|Cyberpunk2077|Rolla Demo|Backrooms: Escape Together').split('|')
let games = []
for (let i = 0; i < 90; i++) {
  games = await invoke('library:list')
  if (wanted.every((w) => games.some((g) => g.name === w))) break
  await page.waitForTimeout(2000)
}
for (const name of wanted) {
  const g = games.find((x) => x.name === name)
  if (!g) {
    console.log(`MISSING ${name}`)
    continue
  }
  await invoke('library:update', g.id, { favorite: true })
}
await page.waitForTimeout(1500)
for (const name of wanted) {
  try {
    await page.locator('aside button', { hasText: name }).first().click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /^Mods/ }).first().click()
    await page.waitForTimeout(2500)
    const panel = page.locator('[aria-expanded]').first()
    if ((await panel.getAttribute('aria-expanded')) === 'false') await panel.click()
    await page.waitForTimeout(1500)
    const info = await invoke('integration:inspect', games.find((x) => x.name === name).id).catch((e) => ({ error: e.message }))
    console.log(`${name}: ${info?.name ?? info?.error} | ${(info?.loaders ?? []).map((l) => `${l.name}=${l.state}${l.proxy ? '@' + l.proxy : ''}`).join(', ')}`)
    await page.screenshot({ path: join(shots, `${name.replace(/\W+/g, '-')}.png`) })
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`)
    await page.screenshot({ path: join(shots, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  }
}
console.log(`renderer errors: ${errors.length}${errors.length ? ` (${errors[0]})` : ''}. Screenshots: ${shots}`)
await app.close()
