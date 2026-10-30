// Runs Diagnose for every game of this PC's library that has mods, read-only, on a copy of the real data file and
// deployment manifests (.smoke/diagnostics/userdata). The game folders are only read; nothing is deployed or repaired.
// Prints each finding, writes the reports as JSON and Markdown, and screenshots the Diagnose tab.
// Usage: npm run build && node scripts/probe-diagnostics.mjs
import { _electron as electron } from 'playwright-core'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { probeGames } from './local-config.mjs'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'diagnostics')
const shots = join(base, 'shots')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
const real = join(os.homedir(), 'AppData', 'Roaming', 'NexusForge')
const data = join(base, 'userdata')
mkdirSync(data, { recursive: true })
copyFileSync(join(real, 'nexusforge.json'), join(data, 'nexusforge.json'))
if (existsSync(join(real, 'deployments'))) cpSync(join(real, 'deployments'), join(data, 'deployments'), { recursive: true })

const env = { ...process.env, NEXUSFORGE_USER_DATA: data, NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1100 }))
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
await page.waitForTimeout(4000)

const games = await invoke('library:list')
const out = {}
for (const g of games) {
  const mods = await invoke('mods:list', g.id)
  if (!mods.length) continue
  const r = await invoke('diagnostics:run', g.id)
  out[g.name] = r
  console.log(`\n== ${g.name} [${r.integration.name}] ${r.summary.errors}E ${r.summary.warnings}W ${r.summary.infos}I (${r.durationMs} ms)`)
  for (const m of r.mods) console.log(`   mod: ${m.name} | ${m.kind ?? 'files'} | ${m.state} | runtime ${m.runtime.state}${m.runtime.needs ? ` needs ${m.runtime.needs.loaderId} ${m.runtime.needs.version}` : ''}`)
  for (const f of r.findings) console.log(`   ${f.severity.toUpperCase()} ${f.code} (${f.confidence}) ${f.title}${f.fixes.length ? ` [fix: ${f.fixes.map((x) => x.label).join(', ')}]` : ''}`)
}
writeFileSync(join(base, 'reports.json'), JSON.stringify(out, null, 2))

const wanted = probeGames('diagnostics', ['Grand Theft Auto V'])
for (const name of wanted) {
  const g = games.find((x) => x.name === name)
  if (!g) continue
  await invoke('library:update', g.id, { favorite: true })
  await page.waitForTimeout(800)
  try {
    await page.locator('aside button', { hasText: name }).first().click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /^Diagnose/ }).first().click()
    await page.waitForTimeout(3500)
    await page.screenshot({ path: join(shots, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: false })
  } catch (e) {
    console.log(`screenshot ${name}: ${e.message}`)
  }
}
await app.close()
console.log(`\nrenderer errors: ${errors.length}${errors.length ? `: ${errors.join(' | ')}` : ''}. Reports: ${join(base, 'reports.json')}`)
