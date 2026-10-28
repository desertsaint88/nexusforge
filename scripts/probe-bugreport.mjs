// End-to-end check of bug reports and the update check in the built app, with a throwaway data folder
// (.smoke/bugreport/userdata): crash prompt after an unclean last session, a renderer error recorded, the report
// dialog (preview, save), GitHub's issue form opening in the site panel, the About & updates page.
// Usage: npm run build && node scripts/probe-bugreport.mjs
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'bugreport')
const shots = join(base, 'shots')
const data = join(base, 'userdata')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })
mkdirSync(join(data, 'logs'), { recursive: true })
// The last session "crashed": an unclean marker and an error at the end of the log.
writeFileSync(join(data, 'session.json'), JSON.stringify({ startedAt: Date.now() - 3600_000, lastSeen: Date.now() - 600_000, version: '1.6.0', pid: 1, clean: false }))
writeFileSync(join(data, 'logs', 'main.log'), `[2026-10-28 19:00:00.000] [info] NexusForge 1.6.0 starting\n[2026-10-28 19:10:00.000] [error] (deploy) probe: something broke in ${os.homedir()}\\AppData\n`)
writeFileSync(join(data, 'nexusforge.json'), JSON.stringify({ settings: { firstRunComplete: true, scanOnStartup: false, scanAllDrives: false } }))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const env = { ...process.env, NEXUSFORGE_USER_DATA: data, NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1000 }))
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
await page.waitForTimeout(3500)

// 1. Crash prompt
const crashToast = page.getByText('NexusForge did not close properly last time')
check('crash from last session offered as a report', await crashToast.isVisible().catch(() => false))
check('crash toast has a Report button', await page.getByRole('button', { name: 'Report it' }).isVisible().catch(() => false))
await page.screenshot({ path: join(shots, '1-crash-toast.png') })

// 2. A renderer error is recorded
await page.evaluate(() => setTimeout(() => { throw new Error('probe renderer error') }, 0))
await page.waitForTimeout(1200)
const state = await invoke('bugreport:state')
check('renderer error recorded', state.recentErrors.some((e) => e.source === 'renderer' && /probe renderer error/.test(e.message)), `${state.recentErrors.length} recorded`)
check('last session crash known', Boolean(state.lastSessionCrash) && state.lastSessionCrash.lastErrors.some((l) => /something broke/.test(l)))

// 3. Dialog from the crash toast
await page.getByRole('button', { name: 'Report it' }).click()
await page.waitForTimeout(800)
const dialog = page.getByRole('dialog')
check('report dialog opens prefilled', await dialog.isVisible() && (await dialog.locator('input').first().inputValue()) === 'NexusForge closed unexpectedly')
await dialog.locator('textarea').first().fill('Probe: NexusForge closed while deploying.')
await page.screenshot({ path: join(shots, '2-dialog.png') })
await dialog.getByRole('button', { name: /Preview/ }).click()
await page.waitForTimeout(2500)
const previewText = await dialog.locator('pre').first().innerText().catch(() => '')
check('preview shows the crash and the recorded errors', /did not close properly/.test(previewText) && /probe renderer error/.test(previewText) && /something broke/.test(previewText))
check('preview has no user name or user folder', !previewText.toLowerCase().includes(os.userInfo().username.toLowerCase()) && !previewText.includes(os.homedir()), os.userInfo().username)
await page.screenshot({ path: join(shots, '3-preview.png') })

// 4. Save only
await dialog.getByRole('button', { name: 'Save only' }).click()
await page.waitForTimeout(2000)
const reportsDir = join(data, 'bug-reports')
const saved = existsSync(reportsDir) ? readdirSync(reportsDir) : []
const files = saved.length ? readdirSync(join(reportsDir, saved[0])) : []
check('report saved with report.md, log.txt, screenshot.png', ['report.md', 'log.txt', 'screenshot.png'].every((f) => files.includes(f)), files.join(', '))
if (files.includes('report.md')) {
  const md = readFileSync(join(reportsDir, saved[0], 'report.md'), 'utf8')
  check('saved report redacted', !md.includes(os.homedir()) && md.includes('%USERPROFILE%'))
}

// 5. Send via GitHub: the issue form (or GitHub's sign-in, which returns to it) opens in the site panel
await page.getByRole('button', { name: 'Report a bug' }).first().click()
await page.waitForTimeout(800)
await page.getByRole('dialog').locator('input').first().fill('Probe report')
await page.getByRole('dialog').locator('textarea').first().fill('Opened by the probe; not submitted.')
await page.getByRole('dialog').getByRole('button', { name: 'Send via GitHub' }).click()
await page.waitForTimeout(6000)
const panel = await invoke('sitepanel:state')
const url = decodeURIComponent(panel.url ?? '')
check('GitHub issue form opens in the site panel', panel.open && /github\.com/.test(url) && /desertsaint88\/nexusforge\/issues\/new/.test(url), url.slice(0, 120))
await page.screenshot({ path: join(shots, '4-github-panel.png') })
await invoke('sitepanel:cancel')
await page.waitForTimeout(500)

// 6. About & updates
await page.evaluate(() => window.nexus.invoke('updater:check'))
await page.getByRole('button', { name: 'Settings' }).first().click()
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'About & updates' }).click()
await page.waitForTimeout(1500)
const upd = await invoke('updater:state')
check('update check ran', ['none', 'available', 'error'].includes(upd.phase), `${upd.phase}${upd.version ? ` ${upd.version}` : ''}${upd.error ? `: ${upd.error}` : ''} (${upd.mode})`)
await page.screenshot({ path: join(shots, '5-about.png') })

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots}`)
process.exit(failed ? 1 : 0)
