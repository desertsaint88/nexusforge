// Real end-to-end check of the in-app update against the published GitHub release.
//
// Installs an older local build (e.g. 1.6.9, never published) silently into .smoke/update-e2e/app without a desktop
// shortcut, starts it with a throwaway data folder, waits until it finds the newer release on GitHub, clicks
// "Update" in the title bar, and checks that the installed copy became the new version, started again by itself,
// and kept its data. Then uninstalls the test copy (keeping shortcuts) and puts the Start menu shortcut back.
//
// Usage: node scripts/live/update-e2e.mjs <path to NexusForge-Setup-<old>.exe> <expected new version>
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const [setup, expected] = process.argv.slice(2)
if (!setup || !expected) throw new Error('usage: update-e2e.mjs <old setup.exe> <expected version>')
const root = join(import.meta.dirname, '..', '..')
const work = join(root, '.smoke', 'update-e2e')
const installDir = join(work, 'app')
const data = join(work, 'userdata')
const exe = join(installDir, 'NexusForge.exe')
const startLnk = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NexusForge.lnk')
const deskLnk = join(os.homedir(), 'Desktop', 'NexusForge.lnk')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fileVersion = (f) => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${f}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).trim()
const runningFrom = (dir) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process NexusForge -ErrorAction SilentlyContinue | ? { $_.Path -like '${dir}\\*' }).Count`], { encoding: 'utf8' }).trim() !== '0'

rmSync(work, { recursive: true, force: true })
mkdirSync(data, { recursive: true })
const startBackup = join(work, 'startmenu-NexusForge.lnk')
if (existsSync(startLnk)) copyFileSync(startLnk, startBackup)
const deskBefore = existsSync(deskLnk) ? { size: statSync(deskLnk).size, mtime: statSync(deskLnk).mtimeMs, bytes: readFileSync(deskLnk).toString('base64') } : undefined
writeFileSync(join(data, 'nexusforge.json'), JSON.stringify({ settings: { firstRunComplete: true, scanOnStartup: false, scanAllDrives: false, accent: 'ember' } }))

try {
  // 1. Silent install of the old version, no desktop shortcut.
  const inst = spawnSync(setup, ['/S', '--no-desktop-shortcut', `/D=${installDir}`], { stdio: 'inherit', timeout: 300_000 })
  const oldVersion = existsSync(exe) ? fileVersion(exe) : ''
  check('old version installed silently', inst.status === 0 && Boolean(oldVersion), `${oldVersion} in ${installDir}`)
  check('desktop shortcut untouched by the install', deskBefore && readFileSync(deskLnk).toString('base64') === deskBefore.bytes)

  // 2. Start it; it should find the newer release on GitHub.
  const env = { ...process.env, NEXUSFORGE_USER_DATA: data, NEXUSFORGE_NO_CLIPBOARD: '1' }
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ executablePath: exe, env, timeout: 90_000 })
  const page = await app.firstWindow()
  const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
  let status
  for (let i = 0; i < 60; i++) {
    status = await invoke('updater:state')
    if (status.phase === 'available' || status.phase === 'error') break
    await sleep(1000)
  }
  check('installed copy found the release on GitHub', status?.phase === 'available' && status.version === expected, `${status?.mode} ${status?.phase} ${status?.version ?? status?.error ?? ''}`)
  await page.screenshot({ path: join(work, '1-update-available.png') })

  // 3. Click "Update" in the title bar and confirm.
  await page.getByRole('button', { name: new RegExp(`Update ${expected.replace(/\./g, '\\.')}`) }).first().click()
  await sleep(600)
  await page.screenshot({ path: join(work, '2-confirm.png') })
  const closed = new Promise((r) => app.on('close', r))
  await page.getByRole('button', { name: 'Update now' }).last().click()
  const t0 = Date.now()
  let lastPct = -1
  for (;;) {
    const s = await invoke('updater:state').catch(() => undefined)
    if (!s) break
    if (s.phase === 'downloading' && Math.round(s.percent ?? 0) !== lastPct && Math.round(s.percent ?? 0) % 20 === 0) {
      lastPct = Math.round(s.percent ?? 0)
      console.log(`      downloading ${lastPct}%`)
    }
    if (s.phase === 'error') {
      check('update downloaded', false, s.error)
      break
    }
    if (Date.now() - t0 > 600_000) break
    await sleep(500)
  }
  await Promise.race([closed, sleep(30_000)])
  check('the old version closed for the install', true, `${Math.round((Date.now() - t0) / 1000)} s after clicking`)

  // 4. The silent installer replaces it and starts the new version.
  let newVersion = ''
  let restarted = false
  for (let i = 0; i < 180; i++) {
    await sleep(1000)
    try {
      newVersion = fileVersion(exe)
    } catch {
      continue
    }
    restarted = runningFrom(installDir)
    if (newVersion.startsWith(expected) && restarted) break
  }
  check('installed copy is now the new version', newVersion.startsWith(expected), newVersion)
  check('the new version started again by itself', restarted)
  const settings = JSON.parse(readFileSync(join(data, 'nexusforge.json'), 'utf8')).settings
  check('data kept through the update', settings.accent === 'ember' && settings.firstRunComplete === true)
} finally {
  // 5. Clean up: stop it, uninstall the test copy (keeping shortcuts), put the Start menu shortcut back.
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process NexusForge -ErrorAction SilentlyContinue | ? { $_.Path -like '${installDir}\\*' } | Stop-Process -Force`])
  await sleep(1500)
  const uninst = join(installDir, 'Uninstall NexusForge.exe')
  if (existsSync(uninst)) spawnSync(uninst, ['/S', '--keep-shortcuts', `_?=${installDir}`], { stdio: 'inherit', timeout: 120_000 })
  await sleep(1500)
  if (existsSync(startBackup)) copyFileSync(startBackup, startLnk)
  const deskAfter = existsSync(deskLnk) ? readFileSync(deskLnk).toString('base64') : undefined
  check('desktop shortcut unchanged after the test', Boolean(deskBefore) && deskAfter === deskBefore?.bytes)
  const reg = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | ? { $_.DisplayName -like 'NexusForge*' }).Count"], { encoding: 'utf8' }).trim()
  check('test install removed', reg === '0', `uninstall entries: ${reg}`)
}
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed.`)
process.exit(failed ? 1 : 0)
