// Mod loaders installed straight from NexusForge into any game folder (store copies and repacked copies alike):
// Unity (BepInEx / MelonLoader), Unreal (UE4SS + ~mods), GTA V (Script Hook V / .NET), Cyberpunk 2077 (CET,
// RED4ext, redscript, ArchiveXL, …). Every game folder here is fake; DLLs are text files carrying the strings
// NexusForge reads to tell what a DLL is.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTEGRATIONS } from '../src/main/integrations/registry'
import { clearReleaseCache } from '../src/main/integrations/github'
import { chooseProxy, identifyProxy } from '../src/main/integrations/proxy'
import { routesExcept } from '../src/main/integrations/zip-loader'
import { melonLoader, unityIntegration } from '../src/main/integrations/unity'
import { classifyUnreal, parseUeVersion, unrealIntegration, unrealLayout } from '../src/main/integrations/unreal'
import { clearDevcCache, gta5Integration, parseDevcPage, shvLoader } from '../src/main/integrations/gta5'
import { CP_LOADERS, cyberpunkIntegration, cyberpunkNeeds } from '../src/main/integrations/cyberpunk'
import { engineTargets, type GameIntegration } from '../src/main/integrations/types'
import { applyDeployment } from '../src/main/mods/deploy'
import { buildPlan } from '../src/main/mods/plan'
import { planFilesFor } from '../src/main/mods/routes'
import { walkFiles } from '../src/main/util/fs'
import type { DeployManifest, Game, InstalledMod, IntegrationInfo } from '../src/shared/types'
import { fakeEnv, fakeHost, gameOf, write, zip, type FakeEnv } from './helpers'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-loaders-'))
  clearReleaseCache()
  clearDevcCache()
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

const ONLINEFIX = 'MZ fake\0Online-Fix.Me\0DllLoader\0'
const DOORSTOP = 'MZ fake\0Doorstop\0NeighTools\0.NET code preloader for Unity'

async function pkg(files: Record<string, string>, name: string) {
  const dir = join(root, 'pkg', name)
  for (const [rel, data] of Object.entries(files)) await write(join(dir, rel), data)
  return { dir, files: await walkFiles(dir), name }
}

async function pickIntegration(game: Game, env: FakeEnv): Promise<string | undefined> {
  for (const i of INTEGRATIONS) if (await i.matches(game, env)) return i.id
}

type Pkg = Awaited<ReturnType<typeof pkg>>

/** Classifies packages as the manager does and deploys them with the real engine; returns report + mods. */
async function deploy(integration: GameIntegration, game: Game, info: IntegrationInfo, env: FakeEnv, pkgs: Pkg[], host = fakeHost()) {
  const mods: InstalledMod[] = []
  for (const [i, p] of pkgs.entries()) {
    const c = await integration.classify(p, game, info, env)
    mods.push({ id: `m${i}`, name: p.name, stagingDir: p.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, loaderId: c.loaderId, needsLoader: c.needsLoader, needsLoaders: c.needsLoaders, checks: c.checks } as InstalledMod)
  }
  const plan = buildPlan(await Promise.all(mods.map(async (m) => ({ id: m.id, revision: 1, files: await planFilesFor(m) }))), {})
  const report = await applyDeployment({
    gameId: game.id,
    profileId: 'p',
    targets: engineTargets(info),
    strategy: 'auto',
    plan,
    manifestPath: join(root, 'state', 'm.json'),
    backupDir: join(root, 'state', 'b'),
    overwriteDir: join(root, 'state', 'o'),
    configure: integration.configure ? (m) => integration.configure!(game, info, m, mods, env, host) : undefined,
    verifyExtra: integration.verify ? (m) => integration.verify!(game, info, m, mods, env) : undefined,
    loadVerifiable: integration.loadVerifiable
  })
  return { report, mods, host }
}

/** GitHub as the loaders publish it: release lists per repository, downloads served from memory. */
function github(env: FakeEnv, repos: Record<string, Array<{ tag: string; prerelease?: boolean; assets: Record<string, Buffer> }>>) {
  const files = new Map<string, Buffer>()
  const fetched: Array<{ url: string; sha?: string; headers?: Record<string, string>; hosts?: string[] }> = []
  env.fetchJson = (async (url: string) => {
    const m = url.match(/repos\/([^/]+\/[^/]+)\/releases/)
    const list = m && repos[m[1]]
    if (!list) throw new Error(`offline: ${url}`)
    return list.map((r, i) => ({
      tag_name: r.tag,
      name: r.tag,
      prerelease: Boolean(r.prerelease),
      draft: false,
      published_at: `2026-10-${String(20 - i).padStart(2, '0')}T00:00:00Z`,
      html_url: `https://github.com/${m[1]}/releases/tag/${r.tag}`,
      assets: Object.entries(r.assets).map(([name, data]) => {
        const u = `https://github.com/${m[1]}/releases/download/${r.tag}/${name}`
        files.set(u, data)
        return { name, size: data.length, browser_download_url: u, digest: `sha256:${createHash('sha256').update(data).digest('hex')}` }
      })
    }))
  }) as never
  env.download = async (url, dest, o) => {
    fetched.push({ url, sha: o?.sha256, headers: o?.headers, hosts: o?.allowedHosts })
    const data = files.get(url)
    if (!data) throw new Error(`404 ${url}`)
    await fsp.writeFile(dest, data)
    return { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
  }
  return fetched
}

// ---------------------------------------------------------------------------

describe('proxy DLLs', () => {
  it('tells loaders from files that came with the game, and picks a free name', async () => {
    const dir = join(root, 'g')
    await write(join(dir, 'winhttp.dll'), ONLINEFIX)
    await write(join(dir, 'version.dll'), 'MZ\0Take-Two Interactive Software, Inc.\0Social Club\0')
    await write(join(dir, 'winmm.dll'), 'MZ\0SOVEREIGN Steamclient Proxy\0')
    await write(join(dir, 'dinput8.dll'), DOORSTOP)
    expect(await identifyProxy(join(dir, 'winhttp.dll'), 'winhttp.dll')).toMatchObject({ owner: 'game', label: 'OnlineFix' })
    expect((await identifyProxy(join(dir, 'version.dll'), 'version.dll')).label).toBe('Social Club emulator')
    expect((await identifyProxy(join(dir, 'winmm.dll'), 'winmm.dll')).owner).toBe('game')
    // BepInEx only runs as winhttp.dll / version.dll: both are taken here.
    expect((await chooseProxy(dir, ['winhttp.dll', 'version.dll'], 'bepinex')).name).toBeUndefined()
    // MelonLoader has more names; the first free one is used.
    expect((await chooseProxy(dir, ['version.dll', 'winhttp.dll', 'winmm.dll', 'dinput8.dll', 'dsound.dll'], 'melonloader')).name).toBe('dsound.dll')
    // A loader that is already there keeps its name.
    expect(await chooseProxy(dir, ['winhttp.dll', 'version.dll', 'dinput8.dll'], 'bepinex')).toMatchObject({ name: 'dinput8.dll', existing: 'dinput8.dll' })
  })

  it('splits a package route so one file can go in under another name', async () => {
    const p = await pkg({ 'winhttp.dll': 'x', 'doorstop_config.ini': 'x', 'BepInEx/core/BepInEx.dll': 'x' }, 'b')
    expect(routesExcept(p.files, '', 'winhttp.dll', 'game')).toEqual([
      { from: 'BepInEx', target: 'game', to: 'BepInEx' },
      { from: 'doorstop_config.ini', target: 'game', to: 'doorstop_config.ini' }
    ])
  })
})

// ---------------------------------------------------------------------------

async function unityGame(name: string, opts: { il2cpp?: boolean; files?: Record<string, string> } = {}): Promise<{ game: Game; dir: string }> {
  const dir = join(root, 'E', 'Games', name)
  await write(join(dir, `${name}.exe`), 'MZ')
  await write(join(dir, 'UnityPlayer.dll'), 'u')
  if (opts.il2cpp) {
    await write(join(dir, 'GameAssembly.dll'), 'il2cpp')
    await write(join(dir, `${name}_Data`, 'il2cpp_data', 'Metadata', 'global-metadata.dat'), 'm')
  } else await write(join(dir, `${name}_Data`, 'Managed', 'Assembly-CSharp.dll'), 'game')
  for (const [k, v] of Object.entries(opts.files ?? {})) await write(join(dir, k), v)
  return { game: gameOf({ id: `test:${name}`, name, installDir: dir, exePath: join(dir, `${name}.exe`) }), dir }
}

const BEPINEX_PKG = { 'winhttp.dll': DOORSTOP, 'doorstop_config.ini': '[General]\nenabled = true\n', '.doorstop_version': '4.3.0', 'BepInEx/core/BepInEx.dll': 'BepInEx', 'BepInEx/core/BepInEx.Preloader.dll': 'p', 'changelog.txt': 'c' }

describe('any Unity game folder', () => {
  it('a repacked Unity game with OnlineFix in winhttp.dll: BepInEx goes in as version.dll, OnlineFix stays', async () => {
    const { game, dir } = await unityGame('Sniper Hunt', { files: { 'winhttp.dll': ONLINEFIX, 'OnlineFix.ini': '[Main]' } })
    const env = fakeEnv(root)
    expect(await pickIntegration(game, env)).toBe('unity')
    const info = await unityIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.name).toBe('Sniper Hunt · Unity Mono')
    const bep = info.loaders.find((l) => l.id === 'bepinex')!
    expect(bep).toMatchObject({ name: 'BepInEx 5', state: 'missing', canInstall: true, proxy: 'version.dll' })
    expect(bep.detail).toMatch(/winhttp\.dll in the game folder is OnlineFix; it stays as it is\. BepInEx goes in as version\.dll/)
    expect(info.loaders.find((l) => l.id === 'melonloader')).toMatchObject({ canInstall: true, proxy: 'version.dll' })

    const plugin = await pkg({ 'CoolPlugin.dll': 'MZ\0BepInEx\0BepInPlugin\0BaseUnityPlugin\0', 'README.txt': 'hi' }, 'Cool Plugin')
    const { report, mods } = await deploy(unityIntegration, game, info, env, [await pkg(BEPINEX_PKG, 'BepInEx'), plugin])
    expect(report.problem).toBeUndefined()
    expect(report.outcome).toBe('verified')
    expect(await fsp.readFile(join(dir, 'winhttp.dll'), 'utf8')).toBe(ONLINEFIX)
    expect(await fsp.readFile(join(dir, 'version.dll'), 'utf8')).toBe(DOORSTOP)
    expect(await fsp.readFile(join(dir, 'BepInEx', 'plugins', 'Cool Plugin', 'CoolPlugin.dll'), 'utf8')).toMatch(/BepInPlugin/)
    expect(mods[1].needsLoader).toBe('bepinex')

    const after = await unityIntegration.inspect(game, env, { loaders: {} }, mods)
    expect(after.loaders.find((l) => l.id === 'bepinex')).toMatchObject({ state: 'installed', proxy: 'version.dll' })
    expect((await unityIntegration.launch!(game, after, 'vanilla', env))?.spec).toEqual({ kind: 'exe', exe: game.exePath, args: ['--doorstop-enabled', 'false'], cwd: dir })
  })

  it('both Doorstop names taken: BepInEx is not installed and the panel says which files are in the way', async () => {
    const { game } = await unityGame('Taken', { files: { 'winhttp.dll': ONLINEFIX, 'version.dll': 'MZ\0Goldberg SteamEmu\0' } })
    const info = await unityIntegration.inspect(game, fakeEnv(root), { loaders: {} }, [])
    const bep = info.loaders.find((l) => l.id === 'bepinex')!
    expect(bep).toMatchObject({ canInstall: false })
    expect(bep.blocked).toMatch(/winhttp\.dll \(OnlineFix\), version\.dll \(Steam emulator\).*does not replace them/)
    expect(info.loaders.find((l) => l.id === 'melonloader')).toMatchObject({ canInstall: true, proxy: 'winmm.dll' })
  })

  it('IL2CPP game: BepInEx 6 is offered; MelonLoader and a MelonLoader mod deploy with a free proxy name', async () => {
    const { game, dir } = await unityGame('Night Shift', { il2cpp: true, files: { 'version.dll': 'MZ\0Goldberg SteamEmu\0' } })
    const env = fakeEnv(root)
    const info = await unityIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.name).toBe('Night Shift · Unity IL2CPP')
    expect(info.loaders.find((l) => l.id === 'bepinex')?.name).toBe('BepInEx 6')
    expect(info.loaders.find((l) => l.id === 'melonloader')?.proxy).toBe('winhttp.dll')
    const melon = await pkg({ 'version.dll': 'MZ\0MelonLoader\0', 'MelonLoader/net35/MelonLoader.dll': 'm', 'MelonLoader/net6/MelonLoader.dll': 'm', 'MelonLoader/Dependencies/x.dll': 'd' }, 'MelonLoader')
    const mod = await pkg({ 'Flashlight.dll': 'MZ\0MelonLoader\0MelonInfoAttribute\0MelonMod\0', 'Flashlight.cfg': 'x' }, 'Flashlight')
    const { report, mods } = await deploy(unityIntegration, game, info, env, [{ ...melon, source: { sourceId: 'frameworks', modId: 'melonloader' } } as Pkg, mod])
    expect(report.outcome).toBe('verified')
    expect(mods[0]).toMatchObject({ loaderId: 'melonloader' })
    expect(mods[1]).toMatchObject({ needsLoader: 'melonloader' })
    expect(await fsp.readFile(join(dir, 'winhttp.dll'), 'utf8')).toMatch(/MelonLoader/)
    expect(await fsp.readFile(join(dir, 'version.dll'), 'utf8')).toMatch(/Goldberg/)
    expect(await fsp.readFile(join(dir, 'Mods', 'Flashlight.dll'), 'utf8')).toMatch(/MelonMod/)
    const after = await unityIntegration.inspect(game, env, { loaders: {} }, mods)
    expect(after.loaders.find((l) => l.id === 'melonloader')).toMatchObject({ state: 'installed', proxy: 'winhttp.dll' })
    expect((await unityIntegration.launch!(game, after, 'vanilla', env))?.spec).toMatchObject({ args: ['--no-mods'] })
  })

  it('installs MelonLoader from its GitHub release (x64 build, SHA-256 checked)', async () => {
    const { game } = await unityGame('Rolla')
    const env = fakeEnv(root)
    const bytes = zip([{ name: 'version.dll', data: 'MelonLoader' }, { name: 'MelonLoader/net35/MelonLoader.dll', data: 'm' }, { name: 'MelonLoader/net6/MelonLoader.dll', data: 'm' }])
    const fetched = github(env, { 'LavaGang/MelonLoader': [{ tag: 'v0.7.3', assets: { 'MelonLoader.x86.zip': Buffer.from('x'), 'MelonLoader.x64.zip': bytes, 'MelonLoader.Installer.exe': Buffer.from('i') } }] })
    const host = fakeHost()
    const info = await unityIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders.find((l) => l.id === 'melonloader')?.latest).toBe('0.7.3')
    await melonLoader.install(game, info, env, host, () => {})
    expect(fetched).toEqual([{ url: 'https://github.com/LavaGang/MelonLoader/releases/download/v0.7.3/MelonLoader.x64.zip', sha: createHash('sha256').update(bytes).digest('hex'), headers: undefined, hosts: undefined }])
    expect(host.installed[0]).toMatchObject({ name: 'MelonLoader', version: '0.7.3' })
  })

  it('games with their own mods folder keep it (People Playground), and non-Unity games are not Unity', async () => {
    const env = fakeEnv(root)
    const { game } = await unityGame('People Playground')
    expect(await pickIntegration({ ...game, name: 'People Playground' }, env)).toBe('generic')
    const dir = join(root, 'Other')
    await write(join(dir, 'game.exe'), 'MZ')
    expect(await pickIntegration(gameOf({ name: 'Other', installDir: dir, exePath: join(dir, 'game.exe') }), env)).toBe('generic')
  })
})

// ---------------------------------------------------------------------------

async function unrealGame(opts: { winmm?: string; version?: string } = {}) {
  const dir = join(root, 'C', 'Games', 'Backrooms-Repack')
  const bin = join(dir, 'BET', 'Binaries', 'Win64')
  await write(join(dir, 'BET.exe'), 'MZ')
  await write(join(bin, 'BETGameSteam-Win64-Shipping.exe'), 'MZ')
  await write(join(dir, 'BET', 'Content', 'Paks', 'pakchunk0-Windows.pak'), 'base')
  await write(join(dir, 'Engine', 'Binaries', 'ThirdParty', 'x.dll'), 'e')
  if (opts.winmm) await write(join(bin, 'winmm.dll'), opts.winmm)
  const env = fakeEnv(root)
  env.versions[join(bin, 'BETGameSteam-Win64-Shipping.exe').toLowerCase()] = opts.version ?? '++UE5+Release-5.5-CL-40574608'
  return { game: gameOf({ id: 'test:bet', name: 'Backrooms: Escape Together', installDir: dir, exePath: join(dir, 'BET.exe') }), dir, bin, env }
}

describe('any Unreal Engine game folder', () => {
  it('finds the project, reads the engine version, and leaves OnlineFix\'s winmm.dll alone', async () => {
    const { game, dir, bin, env } = await unrealGame({ winmm: ONLINEFIX })
    expect(await pickIntegration(game, env)).toBe('unreal')
    expect(await unrealLayout(game)).toMatchObject({ projectName: 'BET', bin })
    expect(parseUeVersion('++UE5+Release-5.5-CL-40574608')).toEqual({ major: 5, minor: 5 })
    expect(parseUeVersion('UE5-CL-0')).toEqual({ major: 5 })
    const exp = zip([{ name: 'dwmapi.dll', data: 'UE4SS' }, { name: 'ue4ss/UE4SS.dll', data: 'UE4SS' }, { name: 'ue4ss/Mods/mods.txt', data: 'BPModLoaderMod : 1\n' }, { name: 'ue4ss/Mods/BPModLoaderMod/Scripts/main.lua', data: '--' }])
    github(env, {
      'UE4SS-RE/RE-UE4SS': [
        { tag: 'experimental-latest', prerelease: true, assets: { 'UE4SS_v3.0.1-1183-gcdbc0b66.zip': exp, 'zDEV-UE4SS_v3.0.1-1183-gcdbc0b66.zip': Buffer.from('dev') } },
        { tag: 'v3.0.1', assets: { 'UE4SS_v3.0.1.zip': Buffer.from('stable') } }
      ]
    })
    const info = await unrealIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.name).toBe('Backrooms: Escape Together · Unreal Engine 5.5')
    expect(info.targets.find((t) => t.id === 'paks')?.dir).toBe(join(dir, 'BET', 'Content', 'Paks', '~mods'))
    expect(info.targets.find((t) => t.id === 'ue4ss-mods')?.dir).toBe(join(bin, 'ue4ss', 'Mods'))
    // UE 5.5 is newer than UE4SS 3.0.1: the experimental build is the one that fits.
    expect(info.loaders[0]).toMatchObject({ id: 'ue4ss', canInstall: true, latest: '3.0.1-1183-gcdbc0b66' })

    const paks = await pkg({ 'Better Lights/BetterLights_P.pak': 'p', 'Better Lights/BetterLights_P.utoc': 'u', 'Better Lights/BetterLights_P.ucas': 'c', 'Better Lights/readme.txt': 'r' }, 'Better Lights')
    const lua = await pkg({ 'FlashlightTweaks/Scripts/main.lua': 'print(1)', 'FlashlightTweaks/config.json': '{}' }, 'Flashlight Tweaks')
    const logic = await pkg({ 'LogicMods/MoreRooms.pak': 'bp', 'LogicMods/MoreRooms.utoc': 'u', 'LogicMods/MoreRooms.ucas': 'c' }, 'More Rooms')
    const ue4ss = await pkg({ 'dwmapi.dll': 'UE4SS proxy', 'ue4ss/UE4SS.dll': 'UE4SS', 'ue4ss/Mods/mods.txt': 'BPModLoaderMod : 1\n', 'ue4ss/Mods/BPModLoaderMod/Scripts/main.lua': '--' }, 'UE4SS')
    const { report, mods, host } = await deploy(unrealIntegration, game, info, env, [{ ...ue4ss, source: { sourceId: 'frameworks', modId: 'ue4ss' } } as Pkg, paks, lua, logic])
    expect(mods[1]).toMatchObject({ needsLoader: undefined })
    expect(mods[1].skipped?.map((s) => s.path)).toEqual(['Better Lights/readme.txt'])
    expect(mods[2]).toMatchObject({ needsLoader: 'ue4ss' })
    expect(mods[3]).toMatchObject({ needsLoader: 'ue4ss' })
    expect(report.problem).toBeUndefined()
    expect(report.outcome).toBe('verified')
    expect(report.verification?.checks.filter((c) => !c.ok)).toEqual([])
    expect((await fsp.readdir(join(dir, 'BET', 'Content', 'Paks', '~mods'))).sort()).toEqual(['BetterLights_P.pak', 'BetterLights_P.ucas', 'BetterLights_P.utoc'])
    expect(await fsp.readFile(join(dir, 'BET', 'Content', 'Paks', 'LogicMods', 'MoreRooms.pak'), 'utf8')).toBe('bp')
    expect(await fsp.readFile(join(bin, 'ue4ss', 'Mods', 'FlashlightTweaks', 'Scripts', 'main.lua'), 'utf8')).toBe('print(1)')
    // Switched on for UE4SS, and remembered so it is removed again with the mod.
    expect(await fsp.readFile(join(bin, 'ue4ss', 'Mods', 'FlashlightTweaks', 'enabled.txt'), 'utf8')).toBe('')
    expect(host.states[game.id].createdFiles).toHaveLength(1)
    expect(await fsp.readFile(join(bin, 'winmm.dll'), 'utf8')).toBe(ONLINEFIX)

    // Without the Lua mod the enabled.txt NexusForge wrote goes again.
    const manifest = JSON.parse(await fsp.readFile(join(root, 'state', 'm.json'), 'utf8')) as DeployManifest
    await unrealIntegration.configure!(game, info, { ...manifest, entries: manifest.entries.filter((e) => e.target !== 'ue4ss-mods' || !e.rel.startsWith('FlashlightTweaks/')) }, mods, env, host)
    await expect(fsp.access(join(bin, 'ue4ss', 'Mods', 'FlashlightTweaks', 'enabled.txt'))).rejects.toThrow()
  })

  it('UE4 games get the stable UE4SS release; packages laid out like the game folder stay as they are', async () => {
    const { game, env } = await unrealGame({ version: '++UE4+Release-4.27-CL-0' })
    github(env, { 'UE4SS-RE/RE-UE4SS': [{ tag: 'experimental-latest', prerelease: true, assets: { 'UE4SS_v3.0.1-9-gabc.zip': Buffer.from('e') } }, { tag: 'v3.0.1', assets: { 'UE4SS_v3.0.1.zip': Buffer.from('s') } }] })
    const info = await unrealIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders[0].latest).toBe('3.0.1')
    expect(info.targets.find((t) => t.id === 'ue4ss-mods')?.dir).toMatch(/Win64[\\/]Mods$/)
    const mirrored = await pkg({ 'BET/Content/Paks/~mods/Thing.pak': 'p', 'readme.md': 'r' }, 'Thing')
    const c = classifyUnreal(mirrored, { projectName: 'BET' }, 'Thing')
    expect(c.routes).toEqual([{ from: '', target: 'game', to: '' }])
  })

  it('a dwmapi.dll that came with the game blocks UE4SS instead of being replaced', async () => {
    const { game, bin, env } = await unrealGame()
    await write(join(bin, 'dwmapi.dll'), 'MZ\0ReShade\0')
    const info = await unrealIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders[0]).toMatchObject({ canInstall: false })
    expect(info.loaders[0].blocked).toMatch(/dwmapi\.dll \(ReShade\)/)
  })
})

// ---------------------------------------------------------------------------

const DEVC_HTML = `<html><body><h1>Script Hook V</h1><p>Installation ...</p><table><tr><td>Released</td><td>15 Jul 2026</td></tr>
<tr><th>Version</th><td>v3889.0 / 1158.13</td></tr><tr><td>Supported patches</td><td>1.0.3889.0 / 1.0.1158.13</td></tr>
<tr><th>Download</th><td><a href="/files/ScriptHookV_3889.0_1158.13.zip" target="_blank">Download</a></td></tr>
<tr><td><a href="/files/ScriptHookV_SDK_1.0.617.1a.zip" target="_blank">Download SDK</a></td></tr></table></body></html>`

async function gtaGame(version = '1.0.3889.0') {
  const dir = join(root, 'E', 'Games', 'Grand-Theft-Auto-V-Repack')
  await write(join(dir, 'GTA5.exe'), 'MZ')
  await write(join(dir, 'version.dll'), 'MZ\0Take-Two Interactive Software, Inc.\0Social Club\0')
  await write(join(dir, 'socialclub_emu.ini'), '[x]')
  const env = fakeEnv(root)
  env.versions[join(dir, 'GTA5.exe').toLowerCase()] = version
  env.fetchText = async (url) => {
    if (url === 'https://www.dev-c.com/gtav/scripthookv/') return DEVC_HTML
    throw new Error(`offline: ${url}`)
  }
  return { game: gameOf({ id: 'test:gta', name: 'Grand Theft Auto V', installDir: dir, exePath: join(dir, 'GTA5.exe') }), dir, env }
}

describe('GTA V (any copy)', () => {
  it('reads dev-c.com: newest Script Hook V and the patches it supports', () => {
    expect(parseDevcPage(DEVC_HTML)).toEqual({ file: 'ScriptHookV_3889.0_1158.13.zip', url: 'https://www.dev-c.com/files/ScriptHookV_3889.0_1158.13.zip', version: '3889.0/1158.13', patches: ['1.0.3889.0', '1.0.1158.13'], released: '15 Jul 2026' })
  })

  it('Script Hook V installs (Referer as on dev-c.com), the Social Club emulator stays, .asi and .NET scripts land where they load', async () => {
    const { game, dir, env } = await gtaGame()
    expect(await pickIntegration(game, env)).toBe('gta5')
    const info = await gta5Integration.inspect(game, env, { loaders: {} }, [])
    expect(info.name).toBe('GTA V Legacy · Script Hook V')
    expect(info.version).toBe('1.0.3889.0')
    expect(info.loaders[0]).toMatchObject({ id: 'scripthookv', canInstall: true, latest: '3889.0/1158.13' })
    expect(info.loaders[1]).toMatchObject({ id: 'shvdn', requires: ['scripthookv'] })

    const shvZip = zip([{ name: 'bin/ScriptHookV.dll', data: 'SHV' }, { name: 'bin/dinput8.dll', data: 'Alexander Blade asi loader' }, { name: 'bin/NativeTrainer.asi', data: 't' }])
    const fetched: unknown[] = []
    env.download = async (url, dest, o) => {
      fetched.push({ url, referer: o?.headers?.Referer, hosts: o?.allowedHosts })
      await fsp.writeFile(dest, shvZip)
      return { sha256: 'x', size: shvZip.length }
    }
    const host = fakeHost()
    await shvLoader.install(game, info, env, host, () => {})
    expect(fetched).toEqual([{ url: 'https://www.dev-c.com/files/ScriptHookV_3889.0_1158.13.zip', referer: 'https://www.dev-c.com/gtav/scripthookv/', hosts: ['www.dev-c.com', 'dev-c.com'] }])
    expect(host.installed[0]).toMatchObject({ name: 'Script Hook V', version: '3889.0/1158.13' })

    const shv = await pkg({ 'bin/ScriptHookV.dll': 'SHV', 'bin/dinput8.dll': 'Alexander Blade asi loader', 'bin/xinput1_4.dll': 'Alexander Blade', 'bin/NativeTrainer.asi': 't', 'bin/args.txt': '-nobattleye -noBE', 'readme.txt': 'r', 'www.dev-c.com.url': 'u' }, 'Script Hook V')
    const asi = await pkg({ 'Speedometer/Speedometer.asi': 'asi', 'Speedometer/Speedometer.ini': 'ini', 'Speedometer/ScriptHookV.dll': 'old', 'Speedometer/README.txt': 'r' }, 'Speedometer')
    const net = await pkg({ 'scripts/Trainer.dll': 'MZ\0ScriptHookVDotNet3\0GTA.Native\0', 'scripts/Trainer.ini': 'x' }, 'Simple Trainer')
    const { report, mods } = await deploy(gta5Integration, game, info, env, [{ ...shv, source: { sourceId: 'frameworks', modId: 'scripthookv' } } as Pkg, asi])
    expect(mods[0].skipped?.map((s) => s.path)).toContain('bin/NativeTrainer.asi')
    expect(mods[1]).toMatchObject({ needsLoader: 'scripthookv' })
    expect(mods[1].skipped?.map((s) => s.path).sort()).toEqual(['Speedometer/README.txt', 'Speedometer/ScriptHookV.dll'])
    // Every file is checked; whether the game loads them only shows in Script Hook V's log after a start.
    expect(report.outcome).toBe('verified')
    expect(report.verification?.loadVerified).toBe(false)
    expect(report.verification?.checks.filter((c) => !c.ok)).toEqual([])
    expect(await fsp.readFile(join(dir, 'ScriptHookV.dll'), 'utf8')).toBe('SHV')
    expect(await fsp.readFile(join(dir, 'Speedometer.asi'), 'utf8')).toBe('asi')
    expect(await fsp.readFile(join(dir, 'version.dll'), 'utf8')).toMatch(/Social Club/)
    await expect(fsp.access(join(dir, 'NativeTrainer.asi'))).rejects.toThrow()
    const netCls = await gta5Integration.classify(net, game, info, env)
    expect(netCls).toMatchObject({ needsLoader: 'scripthookv', needsLoaders: ['shvdn'], routes: [{ from: 'scripts', target: 'scripts', to: '' }] })
  })

  it('a game patch Script Hook V does not support: install is blocked with the reason; .oiv packages are refused', async () => {
    const { game, env } = await gtaGame('1.0.3725.0')
    const info = await gta5Integration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders[0]).toMatchObject({ state: 'unsupported', canInstall: false })
    expect(info.loaders[0].blocked).toMatch(/supports GTA V 1\.0\.3889\.0 and 1\.0\.1158\.13; this copy is 1\.0\.3725\.0/)
    const oiv = await gta5Integration.classify(await pkg({ 'Car.oiv': 'x' }, 'Car'), game, info, env)
    expect(oiv.checks[0]).toMatchObject({ level: 'error', code: 'oiv' })
  })
})

// ---------------------------------------------------------------------------

async function cyberpunkGame(files: Record<string, string> = {}) {
  const dir = join(root, 'C', 'Games', 'Cyb2077')
  await write(join(dir, 'bin', 'x64', 'Cyberpunk2077.exe'), 'MZ')
  await write(join(dir, 'bin', 'x64', 'steam_emu.ini'), '[x]')
  await write(join(dir, 'archive', 'pc', 'content', 'basegame_1_engine.archive'), 'a')
  for (const [k, v] of Object.entries(files)) await write(join(dir, k), v)
  return { game: gameOf({ id: 'test:cp', name: 'Cyberpunk2077', installDir: dir, exePath: join(dir, 'bin', 'x64', 'Cyberpunk2077.exe') }), dir, env: fakeEnv(root) }
}

describe('Cyberpunk 2077 (any copy)', () => {
  it('reads which frameworks a mod needs from its files and lays it out from the game root', async () => {
    const { game, dir, env } = await cyberpunkGame()
    expect(await pickIntegration(game, env)).toBe('cyberpunk2077')
    const info = await cyberpunkIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders.map((l) => l.id)).toEqual(['cet', 'red4ext', 'redscript', 'archivexl', 'tweakxl', 'codeware'])
    expect(info.loaders.find((l) => l.id === 'archivexl')?.requires).toEqual(['red4ext', 'redscript'])
    expect(cyberpunkNeeds(['bin/x64/plugins/cyber_engine_tweaks/mods/m/init.lua', 'r6/scripts/m/x.reds', 'archive/pc/mod/a.xl'])).toEqual(['cet', 'redscript', 'archivexl'])

    const mod = await pkg({ 'Better Vehicles/archive/pc/mod/bv.archive': 'a', 'Better Vehicles/r6/scripts/bv/bv.reds': 's', 'Better Vehicles/bin/x64/plugins/cyber_engine_tweaks/mods/bv/init.lua': 'l', 'Better Vehicles/preview.png': 'p' }, 'Better Vehicles')
    const loose = await pkg({ 'Jacket.archive': 'a', 'Jacket.archive.xl': 'x', 'readme.txt': 'r' }, 'Jacket')
    const c = await cyberpunkIntegration.classify(mod, game, info, env)
    expect(c).toMatchObject({ needsLoader: 'cet', needsLoaders: ['redscript'] })
    const l = await cyberpunkIntegration.classify(loose, game, info, env)
    expect(l).toMatchObject({ needsLoader: 'archivexl' })
    expect(l.routes).toEqual([
      { from: 'Jacket.archive', target: 'archive-mods', to: 'Jacket.archive' },
      { from: 'Jacket.archive.xl', target: 'archive-mods', to: 'Jacket.archive.xl' }
    ])
    const red4 = await pkg({ 'bin/x64/winmm.dll': 'MZ\0RED4ext\0', 'red4ext/RED4ext.dll': 'r', 'red4ext/LICENSE.txt': 'l' }, 'RED4ext')
    const plain = await pkg({ 'Neon Signs/archive/pc/mod/neon.archive': 'n' }, 'Neon Signs')
    const { report, mods } = await deploy(cyberpunkIntegration, game, info, env, [{ ...red4, source: { sourceId: 'frameworks', modId: 'red4ext' } } as Pkg, plain])
    expect(mods[0].loaderId).toBe('red4ext')
    expect(report.problem).toBeUndefined()
    expect(report.verification?.checks.filter((x) => !x.ok)).toEqual([])
    expect(await fsp.readFile(join(dir, 'bin', 'x64', 'winmm.dll'), 'utf8')).toMatch(/RED4ext/)
    expect(await fsp.readFile(join(dir, 'archive', 'pc', 'mod', 'neon.archive'), 'utf8')).toBe('n')
    expect(await fsp.readFile(join(dir, 'bin', 'x64', 'steam_emu.ini'), 'utf8')).toBe('[x]')
    // A mod whose frameworks are missing fails the check (the manager keeps such mods out until they are installed).
    const needy = { id: 'bv', name: 'Better Vehicles', needsLoader: c.needsLoader, needsLoaders: c.needsLoaders } as InstalledMod
    const checks = await cyberpunkIntegration.verify!(game, info, { version: 2, gameId: game.id, profileId: 'p', targets: {}, strategy: 'auto', deployedAt: 0, planHash: 'x', createdDirs: [], entries: [{ target: 'game', rel: 'r6/scripts/bv/bv.reds', modId: 'bv', source: 'x', method: 'copy', size: 1, mtimeMs: 0 }] }, [needy], env)
    expect(checks.filter((x) => !x.ok).map((x) => x.label)).toEqual(['Cyber Engine Tweaks is in place', 'Cyber Engine Tweaks loads through version.dll', 'redscript is in place'])
  })

  it("an OnlineFix winmm.dll blocks RED4ext (it only loads as winmm.dll); CET still has free names", async () => {
    const { game, env } = await cyberpunkGame({ 'bin/x64/winmm.dll': ONLINEFIX })
    const info = await cyberpunkIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders.find((l) => l.id === 'red4ext')).toMatchObject({ canInstall: false })
    expect(info.loaders.find((l) => l.id === 'red4ext')?.blocked).toMatch(/winmm\.dll \(OnlineFix\)/)
    expect(info.loaders.find((l) => l.id === 'cet')).toMatchObject({ canInstall: true, proxy: 'version.dll' })
    expect(CP_LOADERS.find((s) => s.id === 'cet')?.proxy?.names).toContain('winhttp.dll')
  })
})
