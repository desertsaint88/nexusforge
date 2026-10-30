// End-to-end check of the ReShade flow in the real app, on a stand-in GTA V folder (never the real game):
//   A. a ReShade installed by hand as dxgi.dll that GTA V never loads -> "Fix it" -> NexusForge's
//      ReShade64.asi (add-on build kept), dxgi.dll moved to the backup folder, ReShade.ini and shaders kept
//   B. Remove -> ReShade64.asi gone, dxgi.dll back where it was
//   C. the GTA V x Minecraft archive (real files from MC_PACK) installed and "set up" in one click:
//      only the GTA V half deployed, ReShade added as the add-on build, the old dxgi.dll moved out on request
// Uses a fresh profile in .smoke/reshade-e2e and real downloads from reshade.me.
// Usage: npm run build && node scripts/e2e-reshade.mjs
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { local } from './local-config.mjs'

const root = join(import.meta.dirname, '..')
const base = join(root, '.smoke', 'reshade-e2e')
const shots = join(base, 'shots')
const MC_PACK = process.env.MC_PACK ?? local.mcPack
const ADDON_DLL = process.env.RESHADE_ADDON_DLL ?? join(root, '.smoke', 'live', 'reshade-bins', 'nf-work', 'reshade', '6.8.0', 'addon', 'ReShade64.dll')
rmSync(base, { recursive: true, force: true })
mkdirSync(shots, { recursive: true })

// --- the stand-in game folder ---------------------------------------------------------------------------
function fakePe(imports) {
  const optSize = 240, peOff = 64, raw = 0x400, va = 0x1000
  const descs = Buffer.alloc((imports.length + 1) * 20)
  const names = []
  let nameOff = descs.length
  imports.forEach((n, i) => {
    descs.writeUInt32LE(va + nameOff, i * 20 + 12)
    const b = Buffer.from(`${n}\0`, 'latin1')
    names.push(b)
    nameOff += b.length
  })
  const section = Buffer.concat([descs, ...names])
  const f = Buffer.alloc(raw + section.length + 16)
  f.write('MZ', 0, 'ascii'); f.writeUInt32LE(peOff, 0x3c); f.write('PE\0\0', peOff, 'ascii')
  f.writeUInt16LE(0x8664, peOff + 4); f.writeUInt16LE(1, peOff + 6); f.writeUInt16LE(optSize, peOff + 20)
  const opt = peOff + 24
  f.writeUInt16LE(0x20b, opt); f.writeUInt32LE(va, opt + 112 + 8); f.writeUInt32LE(descs.length, opt + 112 + 12)
  const st = opt + optSize
  f.write('.idata', st, 'ascii'); f.writeUInt32LE(section.length, st + 8); f.writeUInt32LE(va, st + 12); f.writeUInt32LE(section.length, st + 16); f.writeUInt32LE(raw, st + 20)
  section.copy(f, raw)
  return f
}
const wrapper = join(base, 'Games', 'Grand-Theft-Auto-V-Stand-in')
const dir = join(wrapper, 'Grand Theft Auto V')
mkdirSync(join(dir, 'reshade-shaders', 'Shaders', 'SweetFX'), { recursive: true })
writeFileSync(join(dir, 'GTA5.exe'), fakePe(['kernel32.dll', 'd3d11.dll', 'dxgi.dll']))
writeFileSync(join(dir, 'version.dll'), 'MZ\0socialclub_emu\0')
writeFileSync(join(dir, 'dinput8.dll'), 'MZ\0Alexander Blade\0')
writeFileSync(join(dir, 'ScriptHookV.dll'), 'MZ\0ScriptHookV\0')
if (!existsSync(ADDON_DLL)) throw new Error(`Run scripts/live/reshade.live.ts first (needs ${ADDON_DLL})`)
if (!MC_PACK || !existsSync(MC_PACK)) throw new Error('Set MC_PACK (or mcPack in scripts/local.json) to the GTA V folder of the GTA V X Minecraft download')
cpSync(ADDON_DLL, join(dir, 'dxgi.dll'))
writeFileSync(join(dir, 'ReShade.ini'), '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\r\nPreprocessorDefinitions=RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000.0,RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=0,RESHADE_DEPTH_INPUT_IS_REVERSED=1,RESHADE_DEPTH_INPUT_IS_LOGARITHMIC=0\r\nTextureSearchPaths=.\\reshade-shaders\\Textures\\**\r\n\r\n[INPUT]\r\nGamepadNavigation=0\r\nKeyOverlay=36,0,0,0\r\n\r\n[PROXY]\r\nEnableProxyLibrary=0\r\nProxyLibrary=\r\n')
writeFileSync(join(dir, 'ReShade.log'), '\r\nIf you are reading this after launching the game at least once, it likely means ReShade was not loaded by the game.\r\n')
const old = new Date(Date.now() - 13 * 3600_000)
utimesSync(join(dir, 'ReShade.log'), old, old)
writeFileSync(join(dir, 'ScriptHookV.log'), '[12:11:54] INIT: Started')
writeFileSync(join(dir, 'reshade-shaders', 'Shaders', 'SweetFX', 'SMAA.fx'), 'technique SMAA {}')
writeFileSync(join(dir, 'ReShadePreset.ini'), '')
const iniBefore = readFileSync(join(dir, 'ReShade.ini'), 'utf8')

// --- the app ------------------------------------------------------------------------------------------------
const env = { ...process.env, NEXUSFORGE_USER_DATA: join(base, 'userdata'), NEXUSFORGE_NO_CLIPBOARD: '1' }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60_000 })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1050 }))
const invoke = (c, ...a) => page.evaluate(([c, a]) => window.nexus.invoke(c, ...a), [c, a])
let failed = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed++
}
const ls = () => readdirSync(dir).sort()
const shot = async (name) => {
  await page.getByRole('button', { name: /^ReShade/ }).first().click().catch(() => {})
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

// Skip onboarding if shown, then add the stand-in game.
await page.waitForTimeout(3000)
await page.getByRole('button', { name: /skip|later|not now|get started/i }).first().click({ timeout: 3000 }).catch(() => {})
const game = await invoke('library:addManual', { name: 'Grand Theft Auto V', exePath: join(dir, 'GTA5.exe'), installDir: wrapper })
await invoke('library:update', game.id, { favorite: true })
await page.waitForTimeout(1500)
await page.locator('aside button', { hasText: 'Grand Theft Auto V' }).first().click()
await page.waitForTimeout(1500)

// A. Fix the copy GTA V never loads.
let v = await invoke('reshade:view', game.id)
check(v.status.state === 'broken' && v.status.canInstall, 'hand-installed dxgi.dll is reported as never loaded', `${v.status.state} ${v.status.detail}`)
check(v.build.effective === 'addon', 'the fix keeps the add-on build', v.build.effective)
check(v.lastStart?.placeholder === true, 'ReShade.log is recognized as the setup placeholder')
await shot('A1-broken')
const fix = await invoke('reshade:setup', game.id, { install: true })
console.log(`     setup: ${fix?.outcome} ${fix?.title}`)
v = await invoke('reshade:view', game.id)
check(v.status.state === 'installed' && v.status.proxy === 'ReShade64.asi', 'NexusForge ReShade installed as ReShade64.asi', `${v.status.state} ${v.status.proxy} ${v.status.detail}`)
check(v.copies.length === 1 && v.copies[0].managed && v.copies[0].build === 'addon', 'one copy, managed, add-on build', JSON.stringify(v.copies))
check(!ls().includes('dxgi.dll'), 'dxgi.dll moved out of the game folder', ls().join(', '))
const ini = readFileSync(join(dir, 'ReShade.ini'), 'utf8')
check(ini.startsWith(iniBefore.trimEnd().split('\r\n').slice(0, 1).join('')) && /PresetPath=\.\\ReShadePreset\.ini/.test(ini) && /KeyOverlay=36,0,0,0/.test(ini), 'ReShade.ini kept (PresetPath added)', ini.replace(/\r\n/g, ' | '))
check(!readdirSync(join(base, 'userdata', 'mods')).some((d) => /shader packs/i.test(d)), 'no second set of shader packs next to the setup-installed ones')
await shot('A2-fixed')

// B. Remove: dxgi.dll comes back.
await invoke('reshade:remove', game.id)
check(!ls().includes('ReShade64.asi') && ls().includes('dxgi.dll'), 'Remove takes ReShade64.asi out and puts dxgi.dll back', ls().join(', '))
check(existsSync(join(dir, 'ReShade.ini')), 'the ReShade.ini that was there before stays')

// C. GTA V x Minecraft in one click.
const pack = join(base, 'download', 'GTA V X Minecraft')
cpSync(MC_PACK, join(pack, 'GTA V'), { recursive: true })
mkdirSync(join(pack, 'Minecraft'), { recursive: true })
writeFileSync(join(pack, 'Minecraft', 'passthrough-0.1.0.jar'), 'PK stand-in')
const [mod] = await invoke('mods:installFiles', game.id, [join(base, 'download')])
console.log(`     installed ${mod.name}: needs ${[mod.needsLoader, ...(mod.needsLoaders ?? [])].join(', ')}`)
const report = await invoke('deploy:setup', game.id)
console.log(`     setup: ${report.outcome} ${report.title}`)
for (const n of report.notes ?? []) console.log(`       note: ${n}`)
const top = ls()
check(['MCPassthrough.asi', 'ReShade64.asi', 'ReShadePreset.ini'].every((f) => top.includes(f)) && !top.includes('GTA V') && !top.includes('Minecraft'), 'only the GTA V half deployed, with ReShade64.asi', top.join(', '))
v = await invoke('reshade:view', game.id)
check(v.copies.find((c) => c.name === 'ReShade64.asi')?.build === 'addon', 'ReShade went in as the add-on build (MCPassthrough is an add-on)', JSON.stringify(v.copies))
check(/never loaded by the game/.test(v.status.detail ?? ''), 'the leftover dxgi.dll is noted as unused', v.status.detail)
await shot('C1-minecraft')
await invoke('reshade:setup', game.id, { cleanup: true })
check(!ls().includes('dxgi.dll'), 'Move dxgi.dll out works', ls().join(', '))
const diag = await invoke('diagnostics:run', game.id)
console.log(`     diagnose: ${diag.findings.map((f) => `${f.code} ${f.title}`).join(' | ') || 'no findings'}`)
check(!diag.findings.some((f) => /^NF-RSH-00[1478]$/.test(f.code)), 'no ReShade problems left in Diagnose')
await shot('C2-clean')

console.log(`renderer errors: ${errors.length}${errors.length ? ` (${errors.join(' | ')})` : ''}`)
await app.close()
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed')
process.exit(failed ? 1 : 0)
