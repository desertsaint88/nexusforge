// Screenshots of the ReShade tab for real games of this PC's library, read-only: a separate profile in
// .smoke/reshade-ui is used (a copy of the data file) and nothing is installed or deployed.
// Usage: npm run build && node scripts/probe-reshade-ui.mjs   (screenshots in .smoke/reshade-ui/shots)
import { _electron as electron } from 'playwright-core'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { probeGames } from './local-config.mjs'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'reshade-ui')
const shots = join(base, 'shots')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
mkdirSync(join(base, 'userdata'), { recursive: true })
copyFileSync(join(os.homedir(), 'AppData', 'Roaming', 'NexusForge', 'nexusforge.json'), join(base, 'userdata', 'nexusforge.json'))

const env = { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata'), NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1050 }))
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])

const wanted = probeGames('reshade', ['Grand Theft Auto V'])
let games = []
for (let i = 0; i < 90; i++) {
  games = await invoke('library:list')
  if (wanted.every((w) => games.some((g) => g.name === w))) break
  await page.waitForTimeout(2000)
}
for (const name of wanted) {
  const g = games.find((x) => x.name === name)
  if (g) await invoke('library:update', g.id, { favorite: true })
  else console.log(`MISSING ${name}`)
}
await page.waitForTimeout(1500)
for (const name of wanted) {
  const g = games.find((x) => x.name === name)
  if (!g) continue
  const file = name.replace(/\W+/g, '-')
  try {
    await page.locator('aside button', { hasText: name }).first().click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /^ReShade/ }).first().click()
    await page.waitForTimeout(4000)
    const view = await invoke('reshade:view', g.id).catch((e) => ({ error: e.message }))
    console.log(
      `${name}: ${view.error ?? `${view.status.state}${view.status.proxy ? ` as ${view.status.proxy}` : ''} | api ${view.api.effective ?? '?'} (${view.api.source}) | copies ${view.copies.map((c) => `${c.name} ${c.build}${c.managed ? ' ours' : ''}`).join(', ') || '-'} | presets ${view.presets.length} | packs ${view.packages.length} | last start ${view.lastStart ? (view.lastStart.runtime ? 'attached' : view.lastStart.version ? 'loaded, not attached' : 'never loaded') : '-'}`}`
    )
    if (!view.error) console.log(`   ${view.status.blocked ?? view.status.detail ?? ''}`)
    await page.screenshot({ path: join(shots, `${file}.png`) })
    // The rest of the tab.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY === 'auto')
      if (el) el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(shots, `${file}-2.png`) })
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`)
    await page.screenshot({ path: join(shots, `fail-${file}.png`) }).catch(() => {})
  }
}
console.log(`renderer errors: ${errors.length}${errors.length ? ` (${errors.join(' | ')})` : ''}. Screenshots: ${shots}`)
await app.close()
