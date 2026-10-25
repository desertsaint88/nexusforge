// Checks the packaged app (release/win-unpacked): it starts, the UI renders, and 7z extraction works
// from the unpacked 7za.exe. Usage: npm run dist:dir && node scripts/smoke-packaged.mjs
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'packaged')
rmSync(base, { recursive: true, force: true })
const game = join(base, 'games', 'Packaged Game')
const src = join(base, 'src', 'Cool Mod')
mkdirSync(game, { recursive: true })
mkdirSync(join(src, 'Data'), { recursive: true })
writeFileSync(join(game, 'Packaged.exe'), Buffer.alloc(400 * 1024))
writeFileSync(join(src, 'Data', 'cool.txt'), 'cool')
const archive = join(base, 'Cool Mod.7z')
execFileSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', archive, '-C', join(base, 'src'), 'Cool Mod'])

const app = await electron.launch({
  executablePath: join(root, 'release', 'win-unpacked', 'NexusForge.exe'),
  env: { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata'), NEXUSFORGE_NO_CLIPBOARD: '1' }
})
const page = await app.firstWindow()
await page.waitForSelector('text=NexusForge')
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
await invoke('settings:set', { customFolders: [join(base, 'games')], firstRunComplete: true })
await invoke('library:scan')
const g = (await invoke('library:list')).find((x) => x.name === 'Packaged Game')
const [mod] = await invoke('mods:installFiles', g.id, [archive])
const report = await invoke('deploy:run', g.id)
await page.waitForTimeout(1500)
await page.screenshot({ path: join(base, 'packaged.png') })
const info = await invoke('app:info')
await app.close()
const ok = Boolean(g && mod && mod.fileCount === 1 && report.placed === 1)
console.log(JSON.stringify({ ok, version: info.version, mod: mod && { name: mod.name, root: mod.rootPath, files: mod.fileCount }, placed: report.placed, methods: report.methods }, null, 2))
process.exit(ok ? 0 : 1)
