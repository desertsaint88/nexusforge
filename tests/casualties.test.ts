import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { casualtiesIntegration } from '../src/main/integrations/casualties'
import { classifyBepInEx, findLoaderRoots, readBepInExLog, unityWithBepInEx } from '../src/main/integrations/bepinex'
import { genericClassify, genericIntegration } from '../src/main/integrations/generic'
import { INTEGRATIONS } from '../src/main/integrations/registry'
import { clearReleaseCache } from '../src/main/integrations/github'
import { engineTargets } from '../src/main/integrations/types'
import { applyDeployment } from '../src/main/mods/deploy'
import { buildPlan } from '../src/main/mods/plan'
import { planFilesFor } from '../src/main/mods/routes'
import { walkFiles } from '../src/main/util/fs'
import type { Game, InstalledMod } from '../src/shared/types'
import { fakeEnv, fakeHost, gameOf, steamApp, write, zip } from './helpers'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-cu-'))
  clearReleaseCache()
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

const BEPINEX_CORE = ['0Harmony.dll', 'BepInEx.dll', 'BepInEx.Preloader.dll', 'BepInEx.Harmony.dll', 'Mono.Cecil.dll', 'MonoMod.Utils.dll']

async function pkg(files: Record<string, string>, name: string) {
  const dir = join(root, 'pkg', name)
  for (const [rel, data] of Object.entries(files)) await write(join(dir, rel), data)
  return { dir, files: await walkFiles(dir), name }
}

function bepinexTree(prefix: string): Record<string, string> {
  const p = prefix ? `${prefix}/` : ''
  const out: Record<string, string> = { [`${p}winhttp.dll`]: 'Doorstop proxy (NeighTools)', [`${p}doorstop_config.ini`]: '[General]\nenabled = true\ntarget_assembly=BepInEx\\core\\BepInEx.Preloader.dll\n', [`${p}.doorstop_version`]: '4.6.0', [`${p}changelog.txt`]: 'changes' }
  for (const f of BEPINEX_CORE) out[`${p}BepInEx/core/${f}`] = f
  return out
}

/** The Alexx_'s Medical Brutalism 4.7.10 archive, as installed yesterday (file names only). */
function medicalBrutalism(): Record<string, string> {
  return {
    'Alexx__sMedicalBrutalism.dll': 'PLUGIN',
    'howtomod.txt': 'step 1: copy modloader',
    'readme.txt': 'hii',
    'downloand this too trust me.url': '[InternetShortcut]',
    ...bepinexTree('modloader'),
    'modloader/BepInEx/LogOutput.log': 'old log',
    'modloader/BepInEx/cache/chainloader_typeloader.dat': 'cache',
    'modloader/BepInEx/config/BepInEx.cfg': 'cfg'
  }
}

async function casualtiesGame(opts: { steam?: boolean; dir?: string } = {}): Promise<{ game: Game; dir: string; steamRoot?: string }> {
  let dir = opts.dir ?? join(root, 'E', 'Games', 'Casualties Unknown')
  let steamRoot: string | undefined
  if (opts.steam) {
    steamRoot = join(root, 'Steam')
    dir = await steamApp(steamRoot, '4576510', 'Casualties: Unknown Demo', 'Casualties Unknown Demo')
  }
  await write(join(dir, 'CasualtiesUnknown.exe'), 'MZ')
  await write(join(dir, 'UnityPlayer.dll'), 'u')
  await write(join(dir, 'CasualtiesUnknown_Data', 'Managed', 'Assembly-CSharp.dll'), 'game')
  const game = gameOf({
    name: opts.steam ? 'Casualties: Unknown Demo' : 'Casualties Unknown',
    installDir: dir,
    exePath: join(dir, 'CasualtiesUnknown.exe'),
    platform: opts.steam ? 'steam' : 'custom',
    platformId: opts.steam ? '4576510' : undefined,
    launch: opts.steam ? { kind: 'url', url: 'steam://rungameid/4576510' } : { kind: 'exe', exe: join(dir, 'CasualtiesUnknown.exe') }
  })
  return { game, dir, steamRoot }
}

describe('BepInEx package layouts', () => {
  it('Medical Brutalism: the DLL goes to BepInEx/plugins, the bundled BepInEx copy and read-mes stay out (yesterday\'s bug)', async () => {
    const p = await pkg(medicalBrutalism(), "Alexx_'s Medical Brutalism")
    const c = classifyBepInEx(p, p.name, { major: 5, name: 'Casualties: Unknown' })
    expect(c.kind).toBe('plugin')
    expect(c.needsLoader).toBe('bepinex')
    expect(c.routes).toEqual([{ from: 'Alexx__sMedicalBrutalism.dll', target: 'game', to: "BepInEx/plugins/Alexx_'s Medical Brutalism/Alexx__sMedicalBrutalism.dll" }])
    expect(c.skipped.map((s) => s.path).sort()).toEqual(['downloand this too trust me.url', 'howtomod.txt', 'modloader', 'readme.txt'])
    expect(c.skipped.find((s) => s.path === 'modloader')?.reason).toMatch(/copy of BepInEx 5 bundled/)
    expect(c.checks.filter((x) => x.level !== 'info')).toEqual([])
  })

  it('unwraps a wrapper folder (Alexx_ModManager/…)', async () => {
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(medicalBrutalism())) files[`Alexx_ModManager/${k}`] = v
    const p = await pkg(files, 'Mod Manager')
    const c = classifyBepInEx(p, 'Mod Manager', { major: 5, name: 'Casualties: Unknown' })
    expect(c.routes.map((r) => r.to)).toEqual(['BepInEx/plugins/Mod Manager/Alexx__sMedicalBrutalism.dll'])
    expect(c.skipped.map((s) => s.path)).toContain('Alexx_ModManager/modloader')
  })

  it('recognizes BepInEx itself (the official release zip)', async () => {
    const p = await pkg(bepinexTree(''), 'BepInEx_win_x64_5.4.23.6')
    expect(findLoaderRoots(p.files)).toEqual([''])
    const c = classifyBepInEx(p, 'BepInEx', { major: 5, name: 'Casualties: Unknown' })
    expect(c.kind).toBe('loader')
    expect(c.loaderId).toBe('bepinex')
    expect(c.routes).toEqual([{ from: '', target: 'game', to: '' }])
    expect(c.skipped.map((s) => s.path)).toEqual(['changelog.txt'])
  })

  it('refuses BepInEx 6 for a BepInEx 5 game', async () => {
    const files = bepinexTree('')
    delete files['BepInEx/core/BepInEx.dll']
    files['BepInEx/core/BepInEx.Core.dll'] = 'v6'
    const c = classifyBepInEx(await pkg(files, 'be6'), 'BepInEx', { major: 5, name: 'Casualties: Unknown' })
    expect(c.checks.find((x) => x.code === 'bepinex_major')?.level).toBe('error')
  })

  it('maps Thunderstore packages (plugins/, config/, manifest.json)', async () => {
    const p = await pkg({ 'manifest.json': '{"name":"Cool","version_number":"1.0.0"}', 'icon.png': 'png', 'README.md': '#', 'plugins/Cool.dll': 'dll', 'config/cool.cfg': 'cfg' }, 'Cool')
    const c = classifyBepInEx(p, 'Cool')
    expect(c.routes).toEqual(expect.arrayContaining([{ from: 'plugins', target: 'game', to: 'BepInEx/plugins/Cool' }, { from: 'config', target: 'game', to: 'BepInEx/config' }]))
    expect(c.skipped.map((s) => s.path).sort()).toEqual(['README.md', 'icon.png', 'manifest.json'])
  })

  it('keeps packages already laid out like the game folder', async () => {
    const p = await pkg({ 'BepInEx/plugins/QoL/QoL.dll': 'dll', 'BepInEx/config/qol.cfg': 'cfg', 'BepInEx/LogOutput.log': 'log' }, 'QoL')
    const c = classifyBepInEx(p, 'QoL')
    expect(c.routes).toEqual([{ from: 'BepInEx', target: 'game', to: 'BepInEx' }])
    expect(c.skipped.map((s) => s.path)).toEqual(['BepInEx/LogOutput.log'])
  })

  it('warns when there is no plugin DLL', async () => {
    // A single top folder is a wrapper; its content goes into the mod's own plugin folder.
    const c = classifyBepInEx(await pkg({ 'sprites/gun.png': 'png', 'sprites/knife.png': 'png' }, 'Sprites'), 'Sprites')
    expect(c.checks.find((x) => x.code === 'no_plugin')?.level).toBe('warning')
    expect(c.routes.map((r) => r.to).sort()).toEqual(['BepInEx/plugins/Sprites/gun.png', 'BepInEx/plugins/Sprites/knife.png'])
  })
})

describe('Casualties: Unknown', () => {
  it('is recognized on Steam (game and demo) and outside Steam', async () => {
    const { game } = await casualtiesGame({ steam: true })
    const env = fakeEnv(root)
    const pick = async (g: Game) => {
      for (const i of INTEGRATIONS) if (await i.matches(g, env)) return i.id
    }
    expect(await pick(game)).toBe('casualties-unknown')
    expect(await pick({ ...game, platformId: '4576490', name: 'Casualties: Unknown' })).toBe('casualties-unknown')
    const { game: drmFree } = await casualtiesGame({ dir: join(root, 'Portable', 'CU') })
    expect(await pick(drmFree)).toBe('casualties-unknown')
  })

  it('a clean install: BepInEx missing but installable (Unity Mono), vanilla start offered once it is in', async () => {
    const { game, steamRoot } = await casualtiesGame({ steam: true })
    const env = fakeEnv(root, { steamRoot })
    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.support).toBe('full')
    expect(info.valid).toBe(true)
    expect(info.version).toBe('Steam build 777')
    expect(info.loaders[0]).toMatchObject({ id: 'bepinex', state: 'missing', canInstall: true })
    expect(info.launchOptions.find((o) => o.id === 'vanilla')?.available).toBe(false)
  })

  it('installs BepInEx from its GitHub release (SHA-256 checked) as a NexusForge-managed loader', async () => {
    const { game } = await casualtiesGame()
    const env = fakeEnv(root)
    const bytes = zip(Object.entries(bepinexTree('')).map(([name, data]) => ({ name, data })))
    const sha = createHash('sha256').update(bytes).digest('hex')
    env.fetchJson = (async () => [
      { tag_name: 'v6.0.0-pre.2', name: '6', prerelease: true, draft: false, published_at: '2026-01-01', html_url: 'x', assets: [{ name: 'BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip', size: 1, browser_download_url: 'https://github.com/BepInEx/BepInEx/releases/download/v6/x.zip' }] },
      { tag_name: 'v5.4.23.6', name: '5', prerelease: false, draft: false, published_at: '2026-06-01', html_url: 'https://github.com/BepInEx/BepInEx/releases/tag/v5.4.23.6', assets: [{ name: 'BepInEx_win_x86_5.4.23.6.zip', size: 1, browser_download_url: 'https://github.com/x86.zip' }, { name: 'BepInEx_win_x64_5.4.23.6.zip', size: bytes.length, browser_download_url: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.6/BepInEx_win_x64_5.4.23.6.zip', digest: `sha256:${sha}` }] }
    ]) as never
    const fetched: Array<{ url: string; sha?: string }> = []
    env.download = async (url, dest, o) => {
      fetched.push({ url, sha: o?.sha256 })
      await fsp.writeFile(dest, bytes)
      return { sha256: sha, size: bytes.length }
    }
    const host = fakeHost()
    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders[0].latest).toBe('5.4.23.6')
    await casualtiesIntegration.loaders[0].install(game, info, env, host, () => {})
    expect(fetched).toEqual([{ url: 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.6/BepInEx_win_x64_5.4.23.6.zip', sha }])
    expect(host.installed[0]).toMatchObject({ name: 'BepInEx', version: '5.4.23.6' })
  })

  it('end to end: BepInEx + Medical Brutalism deployed, plugin where BepInEx loads it, game root clean, verified', async () => {
    const { game, dir } = await casualtiesGame()
    const env = fakeEnv(root)
    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    const bep = await pkg(bepinexTree(''), 'BepInEx')
    const bepCls = await casualtiesIntegration.classify(bep, game, info, env)
    const mb = await pkg(medicalBrutalism(), "Alexx_'s Medical Brutalism")
    const mbCls = await casualtiesIntegration.classify(mb, game, info, env)
    const loaderMod = { id: 'bep', name: 'BepInEx', stagingDir: bep.dir, rootPath: bepCls.rootPath, routes: bepCls.routes, skipped: bepCls.skipped, loaderId: bepCls.loaderId } as InstalledMod
    const plugin = { id: 'mb', name: mb.name, stagingDir: mb.dir, rootPath: mbCls.rootPath, routes: mbCls.routes, skipped: mbCls.skipped, needsLoader: mbCls.needsLoader } as InstalledMod
    const plan = buildPlan(
      [
        { id: 'bep', revision: 1, files: await planFilesFor(loaderMod) },
        { id: 'mb', revision: 1, files: await planFilesFor(plugin) }
      ],
      {}
    )
    const report = await applyDeployment({
      gameId: game.id,
      profileId: 'p',
      targets: engineTargets(info),
      strategy: 'auto',
      plan,
      manifestPath: join(root, 'state', 'm.json'),
      backupDir: join(root, 'state', 'b'),
      overwriteDir: join(root, 'state', 'o'),
      verifyExtra: (m) => casualtiesIntegration.verify!(game, info, m, [loaderMod, plugin], env),
      loadVerifiable: true
    })
    expect(report.problem).toBeUndefined()
    expect(report.outcome).toBe('verified')
    expect(await fsp.readFile(join(dir, 'BepInEx', 'plugins', "Alexx_'s Medical Brutalism", 'Alexx__sMedicalBrutalism.dll'), 'utf8')).toBe('PLUGIN')
    const top = (await fsp.readdir(dir)).sort()
    expect(top).toEqual(['.doorstop_version', 'BepInEx', 'CasualtiesUnknown.exe', 'CasualtiesUnknown_Data', 'UnityPlayer.dll', 'doorstop_config.ini', 'winhttp.dll'])
    expect(report.verification?.checks.every((c) => c.ok)).toBe(true)
    expect(report.verification?.checks.map((c) => c.label)).toContain("Alexx_'s Medical Brutalism: plugin is where BepInEx loads it")

    // After installing, the integration sees BepInEx and offers a start without mods.
    const after = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [loaderMod, plugin])
    expect(after.loaders[0].state).toBe('installed')
    expect(after.launchOptions.find((o) => o.id === 'vanilla')?.available).toBe(true)
    const vanilla = await casualtiesIntegration.launch!(game, after, 'vanilla', env)
    expect(vanilla?.spec).toEqual({ kind: 'exe', exe: game.exePath, args: ['--doorstop-enabled', 'false'], cwd: dir })
  })

  it('flags a plugin that sits outside BepInEx/plugins (what yesterday\'s deployment did)', async () => {
    const { game, dir } = await casualtiesGame()
    for (const [k, v] of Object.entries(bepinexTree(''))) await write(join(dir, k), v)
    const env = fakeEnv(root)
    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    const plugin = { id: 'mb', name: 'Medical Brutalism', needsLoader: 'bepinex' } as InstalledMod
    const checks = await casualtiesIntegration.verify!(game, info, { version: 2, gameId: game.id, profileId: 'p', targets: { game: dir }, strategy: 'auto', deployedAt: 0, planHash: 'x', createdDirs: [], entries: [{ target: 'game', rel: 'Alexx__sMedicalBrutalism.dll', modId: 'mb', source: 'x', method: 'copy', size: 1, mtimeMs: 0 }] }, [plugin], env)
    const bad = checks.find((c) => c.label.includes('plugin is where BepInEx loads it'))
    expect(bad?.ok).toBe(false)
    expect(bad?.level).toBe('error')
  })

  it('reads BepInEx\'s log after a start', async () => {
    const { dir } = await casualtiesGame()
    const since = Date.now()
    await write(
      join(dir, 'BepInEx', 'LogOutput.log'),
      '[Message:   BepInEx] BepInEx 5.4.23.6 - CasualtiesUnknown\n[Info   :   BepInEx] 1 plugins to load\n[Info   :   BepInEx] Loading [Medical Brutalism 4.7.10]\n[Error  : Medical Brutalism] NullReferenceException\n[Message:   BepInEx] Chainloader startup complete\n'
    )
    const check = await readBepInExLog(dir, since)
    expect(check).toMatchObject({ ran: true, loader: 'BepInEx 5.4.23.6', loaded: ['Medical Brutalism 4.7.10'] })
    expect(check.errors).toHaveLength(1)
    expect((await readBepInExLog(dir, Date.now() + 60_000)).ran).toBe(false)
  })

  it('starts a Steam copy without mods through Steam (-applaunch … --doorstop-enabled false)', async () => {
    const { game, dir, steamRoot } = await casualtiesGame({ steam: true })
    for (const [k, v] of Object.entries(bepinexTree(''))) await write(join(dir, k), v)
    const env = fakeEnv(root, { steamRoot })
    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    const l = await casualtiesIntegration.launch!(game, info, 'vanilla', env)
    expect(l?.spec).toEqual({ kind: 'exe', exe: join(steamRoot!, 'steam.exe'), args: ['-applaunch', '4576510', '--doorstop-enabled', 'false'] })
    expect(await casualtiesIntegration.launch!(game, info, 'modded', env)).toBeUndefined()
  })

  it('reports a missing executable', async () => {
    const dir = join(root, 'CU-broken')
    await fsp.mkdir(dir, { recursive: true })
    const game = gameOf({ name: 'Casualties Unknown', installDir: dir, exePath: join(dir, 'CasualtiesUnknown.exe') })
    const info = await casualtiesIntegration.inspect(game, fakeEnv(root), { loaders: {} }, [])
    expect(info.valid).toBe(false)
    expect(info.problems[0]).toMatch(/CasualtiesUnknown\.exe/)
  })

  it('other Unity games only get BepInEx rules when BepInEx is already there', async () => {
    const dir = join(root, 'Games', 'Some Unity Game')
    await write(join(dir, 'Game.exe'), 'MZ')
    await write(join(dir, 'Game_Data', 'Managed', 'Assembly-CSharp.dll'), 'x')
    const game = gameOf({ name: 'Some Unity Game', installDir: dir, exePath: join(dir, 'Game.exe') })
    const env = fakeEnv(root)
    expect(await unityWithBepInEx.matches(game, env)).toBe(false)
    for (const [k, v] of Object.entries(bepinexTree(''))) await write(join(dir, k), v)
    expect(await unityWithBepInEx.matches(game, env)).toBe(true)
  })
})

describe('generic games', () => {
  it('leaves read-me files out and does not dump a save game into the game folder', async () => {
    const dir = join(root, 'Games', 'GTA')
    await write(join(dir, 'GTA5.exe'), 'MZ')
    const game = gameOf({ name: 'Grand Theft Auto V', installDir: dir, exePath: join(dir, 'GTA5.exe') })
    const save = await pkg({ 'Installation.txt': 'copy to Documents', SGTA50015: 'save', 'SGTA50015.bak': 'save' }, 'Grand Theft Auto V 100 percent save')
    const c = await genericClassify(save, game)
    expect(c.kind).toBe('savegame')
    expect(c.routes).toEqual([])
    expect(c.checks[0]).toMatchObject({ level: 'error', code: 'savegame' })
    const mod = await pkg({ 'readme.txt': 'r', 'scripts/mod.asi': 'asi' }, 'Some Script')
    const m = await genericClassify(mod, game)
    expect(m.routes).toEqual([{ from: '', target: 'game', to: '' }])
    expect(m.skipped.map((s) => s.path)).toEqual(['readme.txt'])
    const info = await genericIntegration.inspect(game, fakeEnv(root), { loaders: {} }, [])
    expect(info.support).toBe('basic')
    expect(info.limitations[0]).toMatch(/not that the game loads them/)
  })
})
