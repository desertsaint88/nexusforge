import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyTerraria, clearTmlVerdicts, findTml, parseTmlVersion, pickTmods, syncEnabled, terrariaIntegration, tmlInstallDir, tmodloaderLoader } from '../src/main/integrations/terraria'
import { buildTmod, readTmod, tmlFamily, tmlNewer } from '../src/main/integrations/tmod'
import { clearReleaseCache } from '../src/main/integrations/github'
import { engineTargets } from '../src/main/integrations/types'
import { applyDeployment } from '../src/main/mods/deploy'
import { buildPlan } from '../src/main/mods/plan'
import { planFilesFor } from '../src/main/mods/routes'
import { walkFiles } from '../src/main/util/fs'
import type { Game, InstalledMod } from '../src/shared/types'
import { fakeEnv, fakeHost, gameOf, steamApp, write, zip, type FakeEnv } from './helpers'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-terraria-'))
  clearReleaseCache()
  clearTmlVerdicts()
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

async function terrariaFolder(dir: string): Promise<void> {
  await write(join(dir, 'Terraria.exe'), 'MZ')
  await write(join(dir, 'Content', 'Images', 'Item_1.xnb'), 'x')
}

async function pkg(files: Record<string, string | Buffer>, name = 'Package') {
  const dir = join(root, 'pkg', name)
  for (const [rel, data] of Object.entries(files)) await write(join(dir, rel), data)
  return { dir, files: await walkFiles(dir), name }
}

function gogGame(dir: string, version = '1.4.5.8'): Game {
  return gameOf({ name: 'Terraria', installDir: dir, exePath: join(dir, 'Terraria.exe'), version, platform: 'custom' })
}

/** A tModLoader.zip like the official one (tModLoader.dll, start-tModLoader.bat, LaunchUtils). */
function tmlZip(opts: { wrap?: string; missingBat?: boolean } = {}): Buffer {
  const p = opts.wrap ? `${opts.wrap}/` : ''
  const entries = [
    { name: `${p}tModLoader.dll`, data: 'TML' },
    { name: `${p}LaunchUtils/ScriptCaller.bat`, data: 'rem' },
    { name: `${p}Libraries/x.dll`, data: 'lib' }
  ]
  if (!opts.missingBat) entries.push({ name: `${p}start-tModLoader.bat`, data: '@echo off' })
  return zip(entries)
}

/** GitHub as tModLoader publishes it: latest release with tModLoader.zip and its SHA-256 digest. */
/** InstallVerifier.cs as tModLoader has it: the Terraria version and the Windows MD5s it accepts in GoG mode. */
function verifierSource(terraria: string, gogHash: string, steamHash = '890f5654041f09607d74596d46249000'): string {
  return `private const string TerrariaVersion = "${terraria}";\n\t\t\tgogHash = ToByteArray("${gogHash}");\n\t\t\tsteamHash = ToByteArray("${steamHash}");\n\t\tif (!HashMatchesFile(vanillaExePath, gogHash) && !HashMatchesFile(vanillaExePath, steamHash)) {`
}
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function githubEnv(env: FakeEnv, zipBytes: Buffer, opts: { tag?: string; terraria?: string; exeHash?: string; older?: Array<{ tag: string; terraria: string; exeHash: string }> } = {}) {
  const tag = opts.tag ?? 'v2026.08.3.0'
  const sha = createHash('sha256').update(zipBytes).digest('hex')
  const downloads: string[] = []
  const rel = (t: string, date: string) => ({ tag_name: t, name: t, prerelease: false, draft: false, published_at: date, html_url: 'https://github.com/tModLoader/tModLoader/releases', assets: [{ name: 'tModLoader.zip', size: zipBytes.length, browser_download_url: `https://github.com/tModLoader/tModLoader/releases/download/${t}/tModLoader.zip`, digest: `sha256:${sha}` }] })
  const verifiers = new Map<string, string>([[tag, verifierSource(opts.terraria ?? '1.4.5.8', opts.exeHash ?? md5('MZ'))]])
  for (const o of opts.older ?? []) verifiers.set(o.tag, verifierSource(o.terraria, o.exeHash))
  env.fetchJson = (async (url: string) => {
    if (url.endsWith('/releases/latest')) return rel(tag, '2026-10-01T00:00:00Z')
    if (url.includes('/releases?per_page=')) return [rel(tag, '2026-10-01T00:00:00Z'), ...(opts.older ?? []).map((o, i) => rel(o.tag, `2026-0${8 - i}-01T00:00:00Z`))]
    throw new Error(`unexpected ${url}`)
  }) as never
  env.fetchText = async (url: string) => {
    const m = url.match(/tModLoader\/tModLoader\/([^/]+)\/patches\/.*InstallVerifier\.cs$/)
    if (m && verifiers.has(decodeURIComponent(m[1]))) return verifiers.get(decodeURIComponent(m[1]))!
    throw new Error(`unexpected ${url}`)
  }
  env.download = async (url, dest, o) => {
    downloads.push(url)
    await fsp.writeFile(dest, zipBytes)
    const got = createHash('sha256').update(zipBytes).digest('hex')
    if (o?.sha256 && o.sha256 !== got) throw new Error('checksum')
    return { sha256: got, size: zipBytes.length }
  }
  return downloads
}

describe('.tmod files', () => {
  it('reads name, version and the tModLoader version, and checks the SHA-1 like tModLoader does', async () => {
    const f = join(root, 'CalamityMod.tmod')
    await fsp.writeFile(f, buildTmod('CalamityMod', '2.0.4.1', '2026.8.3.0'))
    expect(await readTmod(f)).toMatchObject({ name: 'CalamityMod', version: '2.0.4.1', builtFor: '2026.8.3.0', hashOk: true })
    const bytes = await fsp.readFile(f)
    bytes[bytes.length - 1] ^= 0xff
    await fsp.writeFile(f, bytes)
    expect((await readTmod(f)).hashOk).toBe(false)
    await fsp.writeFile(f, bytes.subarray(0, bytes.length - 3))
    await expect(readTmod(f)).rejects.toThrow(/damaged or incomplete/)
  })

  it("reads tModLoader's version out of its DLL's version text (found on the real 2026.08.3.0 release)", () => {
    expect(parseTmlVersion('1.4.4.9+2026.08.3.0|2026.08|stable|Stabl')).toBe('2026.08.3.0')
    expect(parseTmlVersion('2026.8.3.0')).toBe('2026.8.3.0')
    expect(parseTmlVersion('1.4.4.9')).toBeUndefined()
    expect(tmlNewer('2026.08.3.0', parseTmlVersion('1.4.4.9+2026.08.3.0|2026.08|stable')!)).toBe(false)
  })

  it('knows the tModLoader lines', () => {
    expect(tmlFamily('0.11.8.9')).toBe('1.3')
    expect(tmlFamily('2022.9.47.86')).toBe('1.4.3')
    expect(tmlFamily('2026.8.3.0')).toBe('1.4.4')
    expect(tmlNewer('2026.9.1.0', '2026.8.3.0')).toBe(true)
    expect(tmlNewer('2026.8.9.0', '2026.8.3.0')).toBe(false)
  })

  it('picks the Workshop build that fits the installed tModLoader', async () => {
    const files = ['2024.5/Mod.tmod', '2026.8/Mod.tmod', '2026.12/Mod.tmod']
    const infos = new Map(files.map((f) => [f, { name: 'Mod', builtFor: `${f.split('/')[0]}.1.0`, hashOk: true, size: 1 }]))
    expect(pickTmods(files, infos, '2026.8.3.0')).toEqual(['2026.8/Mod.tmod'])
    expect(pickTmods(files, infos, undefined)).toEqual(['2026.12/Mod.tmod'])
  })
})

describe('classifying Terraria packages', () => {
  it('sends a vanilla adventure map to the Worlds folder (the bug: it went into the game folder)', async () => {
    const p = await pkg({ 'A-Link-to-Terraria-4.0.6-Journey.wld': 'WORLD', 'readme.txt': 'how to', 'screens/1.png': 'png' })
    const c = await classifyTerraria(p, undefined, false)
    expect(c.kind).toBe('world')
    expect(c.routes).toEqual([{ from: 'A-Link-to-Terraria-4.0.6-Journey.wld', target: 'worlds', to: 'A-Link-to-Terraria-4.0.6-Journey.wld' }])
    expect(c.needsLoader).toBeUndefined()
    expect(c.skipped.map((s) => s.path).sort()).toEqual(['readme.txt', 'screens/1.png'])
  })

  it('routes .tmod mods to tModLoader, by their real name', async () => {
    const p = await pkg({ 'Calamity Mod v2/CalamityMod.tmod': buildTmod('CalamityMod', '2.0.4.1', '2026.8.3.0'), 'Calamity Mod v2/README.md': '#' })
    const c = await classifyTerraria(p, '2026.8.3.0', true)
    expect(c.kind).toBe('tmod')
    expect(c.needsLoader).toBe('tmodloader')
    expect(c.routes).toEqual([{ from: 'Calamity Mod v2/CalamityMod.tmod', target: 'tml-mods', to: 'CalamityMod.tmod' }])
    expect(c.meta?.tmodNames).toBe('CalamityMod')
    expect(c.checks.filter((x) => x.level === 'error')).toEqual([])
  })

  it('blocks a mod built for another Terraria line, warns for a newer tModLoader', async () => {
    const old = await classifyTerraria(await pkg({ 'Old.tmod': buildTmod('Old', '1.0', '2022.9.47.86') }, 'old'), '2026.8.3.0', true)
    expect(old.checks.find((c) => c.code === 'tml_family')?.level).toBe('error')
    const newer = await classifyTerraria(await pkg({ 'New.tmod': buildTmod('New', '1.0', '2026.12.1.0') }, 'new'), '2026.8.3.0', true)
    expect(newer.checks.find((c) => c.code === 'tml_newer')?.level).toBe('warning')
  })

  it('rejects a damaged .tmod', async () => {
    const bytes = buildTmod('Broken', '1.0', '2026.8.3.0')
    const c = await classifyTerraria(await pkg({ 'Broken.tmod': bytes.subarray(0, bytes.length - 2) }, 'broken'), '2026.8.3.0', true)
    expect(c.checks.some((x) => x.code === 'tmod_damaged' && x.level === 'error')).toBe(true)
  })

  it('keeps modded worlds/characters (with .twld/.tplr) for tModLoader, and character map folders', async () => {
    const c = await classifyTerraria(await pkg({ 'Big.wld': 'w', 'Big.twld': 't', 'Hero.plr': 'p', 'Hero/map.map': 'm', 'Hero.plr.bak': 'b' }, 'saves'), '2026.8.3.0', true)
    expect(c.routes).toEqual(
      expect.arrayContaining([
        { from: 'Big.wld', target: 'tml-worlds', to: 'Big.wld' },
        { from: 'Big.twld', target: 'tml-worlds', to: 'Big.twld' },
        { from: 'Hero.plr', target: 'players', to: 'Hero.plr' },
        { from: 'Hero', target: 'players', to: 'Hero' }
      ])
    )
    expect(c.skipped.find((s) => s.path === 'Hero.plr.bak')?.reason).toMatch(/backup/)
  })

  it('installs resource packs as folders', async () => {
    const c = await classifyTerraria(await pkg({ 'Better Ores/pack.json': '{}', 'Better Ores/Content/Images/Ore.png': 'png' }, 'pack'), undefined, false)
    expect(c.kind).toBe('resourcepack')
    expect(c.routes).toEqual([{ from: 'Better Ores', target: 'resourcepacks', to: 'Better Ores' }])
  })

  it('says so when nothing in the package is Terraria content', async () => {
    const c = await classifyTerraria(await pkg({ 'notes.txt': 'hi', 'tool.exe': 'MZ' }, 'junk'), undefined, false)
    expect(c.checks.some((x) => x.code === 'empty' && x.level === 'error')).toBe(true)
    expect(c.routes).toEqual([])
  })
})

describe('Terraria installs', () => {
  it('Steam Terraria without tModLoader: installs tModLoader through Steam', async () => {
    const steamRoot = join(root, 'Steam')
    const dir = await steamApp(steamRoot, '105600', 'Terraria', 'Terraria')
    await terrariaFolder(dir)
    const env = fakeEnv(root, { steamRoot })
    const game = gameOf({ name: 'Terraria', installDir: dir, exePath: join(dir, 'Terraria.exe'), platform: 'steam', platformId: '105600' })
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(info.distribution.kind).toBe('steam')
    expect(info.support).toBe('full')
    expect(info.loaders[0]).toMatchObject({ id: 'tmodloader', state: 'missing', canInstall: true, via: 'steam' })
    expect(info.launchOptions.find((o) => o.id === 'modded')?.available).toBe(false)
    // Steam installs the app once the user confirms in its window; simulate that.
    env.openUrl = async (u) => {
      env.opened.push(u)
      setTimeout(async () => {
        const tml = await steamApp(steamRoot, '1281930', 'tModLoader', 'tModLoader')
        await write(join(tml, 'tModLoader.dll'), 'TML')
        await write(join(tml, 'start-tModLoader.bat'), '@echo off')
      }, 50)
    }
    const steps: string[] = []
    await tmodloaderLoader.install(game, info, env, host, (d) => steps.push(d))
    expect(env.opened).toEqual(['steam://install/1281930'])
    const after = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(after.loaders[0]).toMatchObject({ state: 'installed', via: 'steam' })
    expect(after.targets.find((t) => t.id === 'tml-mods')?.dir).toBe(join(root, 'Documents', 'My Games', 'Terraria', 'tModLoader', 'Mods'))
    const launch = await terrariaIntegration.launch!(game, after, 'modded', env)
    expect(launch?.spec).toEqual({ kind: 'url', url: 'steam://rungameid/1281930' })
    expect(await terrariaIntegration.launch!(game, after, 'vanilla', env)).toBeUndefined()
    const sc = await terrariaIntegration.shortcut!(game, after, 'modded', env)
    expect(sc).toMatchObject({ name: 'Terraria Modded', args: '-applaunch 1281930' })
  })

  it('reads the save folder of a Steam beta branch', async () => {
    const steamRoot = join(root, 'Steam')
    const dir = await steamApp(steamRoot, '105600', 'Terraria', 'Terraria')
    await terrariaFolder(dir)
    const tml = await steamApp(steamRoot, '1281930', 'tModLoader', 'tModLoader', '\t"UserConfig"\n\t{\n\t\t"BetaKey"\t\t"preview"\n\t}\n')
    await write(join(tml, 'tModLoader.dll'), 'TML')
    const env = fakeEnv(root, { steamRoot })
    const game = gameOf({ name: 'Terraria', installDir: dir, exePath: join(dir, 'Terraria.exe'), platform: 'steam', platformId: '105600' })
    const found = await findTml(game, env, { loaders: {} })
    expect(found?.saveFolder).toBe('tModLoader-preview')
  })

  it('GOG Terraria on another drive: installs the official tModLoader.zip (checksum checked) inside the folder', async () => {
    const dir = join(root, 'E', 'Games', 'Terraria GOG')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), JSON.stringify({ gameId: '1207665503', name: 'Terraria' }))
    const env = fakeEnv(root)
    const downloads = githubEnv(env, tmlZip())
    const game = gogGame(dir)
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(info.distribution.kind).toBe('gog')
    expect(info.loaders[0]).toMatchObject({ state: 'missing', canInstall: true, via: 'github' })
    await tmodloaderLoader.install(game, info, env, host, () => {})
    expect(downloads).toHaveLength(1)
    const dest = join(dir, 'tModLoader')
    expect(await tmlInstallDir(game)).toBe(dest)
    expect(await fsp.readFile(join(dest, 'start-tModLoader.bat'), 'utf8')).toBe('@echo off')
    expect(host.states[game.id].loaders.tmodloader).toMatchObject({ via: 'github', dir: dest, tag: 'v2026.08.3.0' })
    expect(host.states[game.id].loaders.tmodloader.sha256).toMatch(/^[0-9a-f]{64}$/)
    const after = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(after.loaders[0].state).toBe('installed')
    const launch = await terrariaIntegration.launch!(game, after, 'modded', env)
    expect(launch?.spec).toMatchObject({ kind: 'exe', args: ['/d', '/c', 'start-tModLoader.bat'], cwd: dest })
    expect(launch?.followDir).toBe(dest)
    // Vanilla Terraria is untouched apart from the tModLoader folder.
    expect((await fsp.readdir(dir)).sort()).toEqual(['Content', 'Terraria.exe', 'goggame-1207665503.info', 'tModLoader'])
  })

  it('puts tModLoader next to a folder called Terraria, as the wiki shows', async () => {
    const dir = join(root, 'GOG Games', 'Terraria')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    expect(await tmlInstallDir(gogGame(dir))).toBe(join(root, 'GOG Games', 'tModLoader'))
  })

  it('updates a NexusForge tModLoader in place (Build folder flattened, .NET kept) and keeps the old one if the update is broken', async () => {
    const dir = join(root, 'Games', 'Terraria GOG')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    const env = fakeEnv(root)
    const game = gogGame(dir)
    const host = fakeHost()
    githubEnv(env, tmlZip())
    await tmodloaderLoader.install(game, await terrariaIntegration.inspect(game, env, host.state(game.id), []), env, host, () => {})
    const dest = join(dir, 'tModLoader')
    await write(join(dest, 'dotnet', '8.0.0', 'dotnet.exe'), 'runtime')

    clearReleaseCache()
    githubEnv(env, tmlZip({ wrap: 'Build' }), { tag: 'v2026.09.1.0' })
    await tmodloaderLoader.install(game, await terrariaIntegration.inspect(game, env, host.state(game.id), []), env, host, () => {})
    expect(host.states[game.id].loaders.tmodloader.tag).toBe('v2026.09.1.0')
    expect(await fsp.readFile(join(dest, 'tModLoader.dll'), 'utf8')).toBe('TML')
    expect(await fsp.readFile(join(dest, 'dotnet', '8.0.0', 'dotnet.exe'), 'utf8')).toBe('runtime')

    clearReleaseCache()
    githubEnv(env, tmlZip({ missingBat: true }), { tag: 'v2026.10.1.0' })
    await expect(tmodloaderLoader.install(game, await terrariaIntegration.inspect(game, env, host.state(game.id), []), env, host, () => {})).rejects.toThrow(/missing start-tModLoader\.bat/)
    expect(host.states[game.id].loaders.tmodloader.tag).toBe('v2026.09.1.0')
    expect(await fsp.readFile(join(dest, 'start-tModLoader.bat'), 'utf8')).toBe('@echo off')
    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.nf-'))
    expect(leftovers).toEqual([])
  })

  it('refuses before downloading when no tModLoader release accepts this Terraria.exe (wrong version or changed exe)', async () => {
    const dir = join(root, 'Games', 'Terraria')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    const env = fakeEnv(root)
    const downloads = githubEnv(env, tmlZip(), { terraria: '1.4.5.8', exeHash: md5('another exe') })
    const game = gogGame(dir, '1.4.4.9')
    const info = await terrariaIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.loaders[0]).toMatchObject({ state: 'unsupported', canInstall: false })
    expect(info.loaders[0].blocked).toMatch(/newest is made for Terraria 1\.4\.5\.8.*does not patch that check/)
    await expect(tmodloaderLoader.install(game, info, env, fakeHost(), () => {})).rejects.toThrow(/matches none of the last/)
    expect(downloads).toEqual([])
  })

  it('an older Terraria.exe gets the newest tModLoader release made for it', async () => {
    const dir = join(root, 'Games', 'Terraria 1.4.4')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    const env = fakeEnv(root)
    githubEnv(env, tmlZip(), { terraria: '1.4.5.8', exeHash: md5('newer exe'), older: [{ tag: 'v2025.12.3.0', terraria: '1.4.4.9', exeHash: md5('MZ') }] })
    const game = gogGame(dir, '1.4.4.9')
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(info.loaders[0]).toMatchObject({ state: 'missing', canInstall: true, latest: '2025.12.3.0' })
    expect(info.loaders[0].detail).toMatch(/v2025\.12\.3\.0 accepts this Terraria\.exe \(unmodified Terraria 1\.4\.4\.9\).*newest tModLoader \(v2026\.08\.3\.0\)/)
    await tmodloaderLoader.install(game, info, env, host, () => {})
    expect(host.states[game.id].loaders.tmodloader).toMatchObject({ via: 'github', tag: 'v2025.12.3.0' })
  })

  it('a copy outside Steam and GOG with an unmodified Terraria.exe: tModLoader goes inside its folder', async () => {
    const dir = join(root, 'E', 'Games', 'Terraria')
    await terrariaFolder(dir)
    const env = fakeEnv(root)
    githubEnv(env, tmlZip())
    const game = gogGame(dir)
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(info.distribution.kind).toBe('standalone')
    expect(info.loaders[0]).toMatchObject({ state: 'missing', canInstall: true, via: 'github' })
    expect(info.loaders[0].detail).toMatch(/inside this Terraria folder/)
    await tmodloaderLoader.install(game, info, env, host, () => {})
    // Inside, not next to it: no new folder among the other games.
    expect(host.states[game.id].loaders.tmodloader.dir).toBe(join(dir, 'tModLoader'))
    expect((await fsp.readdir(join(root, 'E', 'Games'))).sort()).toEqual(['Terraria'])
    const after = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(after.launchOptions.find((o) => o.id === 'modded')).toMatchObject({ available: true, primary: true })
  })

  it('a copy with steam_api.dll: tModLoader would start in Steam mode, so it is honestly not set up', async () => {
    const dir = join(root, 'E', 'Games', 'Terraria')
    await terrariaFolder(dir)
    await write(join(dir, 'steam_api.dll'), 'x')
    const env = fakeEnv(root)
    githubEnv(env, tmlZip())
    const game = gogGame(dir)
    const info = await terrariaIntegration.inspect(game, env, { loaders: {} }, [])
    expect(info.distribution).toMatchObject({ kind: 'standalone', detail: expect.stringMatching(/Steam's files/) })
    expect(info.support).toBe('partial')
    expect(info.loaders[0]).toMatchObject({ state: 'unsupported', canInstall: false })
    expect(info.loaders[0].blocked).toMatch(/Steam mode.*does not change how tModLoader checks/)
    expect(info.limitations.join(' ')).toMatch(/Worlds, characters and resource packs work/)
    expect(info.targets.map((t) => t.id)).toEqual(['game', 'worlds', 'players', 'resourcepacks'])
    await expect(tmodloaderLoader.install(game, info, env, fakeHost(), () => {})).rejects.toThrow(/Steam mode/)
  })

  it('reports a folder without Terraria.exe', async () => {
    const dir = join(root, 'Broken')
    await fsp.mkdir(dir, { recursive: true })
    const info = await terrariaIntegration.inspect(gameOf({ name: 'Terraria', installDir: dir, exePath: join(dir, 'Terraria.exe') }), fakeEnv(root), { loaders: {} }, [])
    expect(info.valid).toBe(false)
    expect(info.problems[0]).toMatch(/Terraria\.exe was not found/)
  })
})

describe('enabled.json', () => {
  it('adds the deployed mods next to the user\'s own and takes out only what NexusForge added', async () => {
    const mods = join(root, 'Mods')
    await write(join(mods, 'enabled.json'), JSON.stringify(['UserMod']))
    const state = { loaders: {} }
    await syncEnabled(mods, ['CalamityMod', 'MagicStorage'], state, join(root, 'bk'))
    expect(JSON.parse(await fsp.readFile(join(mods, 'enabled.json'), 'utf8'))).toEqual(['UserMod', 'CalamityMod', 'MagicStorage'])
    expect(JSON.parse(await fsp.readFile(join(root, 'bk', 'enabled.json.before-nexusforge'), 'utf8'))).toEqual(['UserMod'])
    await syncEnabled(mods, ['CalamityMod'], state)
    expect(JSON.parse(await fsp.readFile(join(mods, 'enabled.json'), 'utf8'))).toEqual(['UserMod', 'CalamityMod'])
    await syncEnabled(mods, [], state)
    expect(JSON.parse(await fsp.readFile(join(mods, 'enabled.json'), 'utf8'))).toEqual(['UserMod'])
  })
})

describe('tModLoader dependencies', () => {
  it('reads modReferences from the Info file, also when it is deflate-compressed', async () => {
    const f = join(root, 'CalamityModMusic.tmod')
    await fsp.writeFile(f, buildTmod('CalamityModMusic', '2.0.4', '2026.8.3.0', undefined, { refs: ['CalamityMod@2.0', 'Fargowiltas'], displayName: '[c/FF6600:Calamity] Music' }))
    const t = await readTmod(f)
    expect(t.refs).toEqual([{ name: 'CalamityMod', version: '2.0' }, { name: 'Fargowiltas', version: undefined }])
    expect(t.hashOk).toBe(true)
    // Same mod with the Info file compressed the way tModLoader stores bigger files (raw deflate).
    const { deflateRawSync } = await import('node:zlib')
    const s = (x: string) => Buffer.concat([Buffer.from([Buffer.byteLength(x)]), Buffer.from(x)])
    const info = Buffer.concat([s('modReferences'), s('CalamityMod'), s(''), s('version'), s('2.0.4'), s('')])
    const packed = deflateRawSync(info)
    const i32 = (n: number) => {
      const b = Buffer.alloc(4)
      b.writeInt32LE(n)
      return b
    }
    const data = Buffer.concat([s('CalamityModMusic'), s('2.0.4'), i32(2), s('Info'), i32(info.length), i32(packed.length), s('Music.ogg'), i32(3), i32(3), packed, Buffer.from('ogg')])
    const hash = createHash('sha1').update(data).digest()
    const g = join(root, 'Packed.tmod')
    await fsp.writeFile(g, Buffer.concat([Buffer.from('TMOD'), s('2026.8.3.0'), hash, Buffer.alloc(256), i32(data.length), data]))
    expect((await readTmod(g)).refs).toEqual([{ name: 'CalamityMod', version: undefined }])
  })

  it('classifying notes what a mod needs (and takes the display name without chat tags)', async () => {
    const p = await pkg({ 'CalamityModMusic.tmod': buildTmod('CalamityModMusic', '2.0.4', '2026.8.3.0', undefined, { refs: ['CalamityMod'], displayName: '[c/FF6600:Calamity] Music' }) }, 'Music')
    const c = await classifyTerraria(p, '2026.8.3.0', true)
    expect(c.meta?.tmodNeeds).toBe('CalamityMod')
    expect(c.name).toBe('Calamity Music')
    expect(c.checks.some((x) => x.code === 'tmod_refs')).toBe(true)
  })

  async function setupGog() {
    const dir = join(root, 'Games', 'Terraria')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    const tmlDir = join(root, 'Games', 'tModLoader')
    await write(join(tmlDir, 'tModLoader.dll'), 'TML')
    await write(join(tmlDir, 'start-tModLoader.bat'), '@echo off')
    const env = fakeEnv(root)
    env.versions[join(tmlDir, 'tModLoader.dll').toLowerCase()] = '2026.8.3.0'
    const game = gogGame(dir)
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    return { game, env, host, info, saves: join(root, 'Documents', 'My Games', 'Terraria', 'tModLoader') }
  }

  async function modFrom(id: string, files: Record<string, Buffer>, ctx: Awaited<ReturnType<typeof setupGog>>): Promise<InstalledMod> {
    const p = await pkg(files, id)
    const c = await terrariaIntegration.classify(p, ctx.game, ctx.info, ctx.env)
    return { id, name: c.name ?? id, gameId: ctx.game.id, stagingDir: p.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, needsLoader: c.needsLoader, meta: c.meta } as InstalledMod
  }

  async function deploy(ctx: Awaited<ReturnType<typeof setupGog>>, mods: InstalledMod[]) {
    const plan = buildPlan(await Promise.all(mods.map(async (m) => ({ id: m.id, revision: 1, files: await planFilesFor(m) }))), {})
    return applyDeployment({
      gameId: ctx.game.id,
      profileId: 'p',
      targets: engineTargets(ctx.info),
      strategy: 'auto',
      plan,
      manifestPath: join(root, 'state', 'manifest.json'),
      backupDir: join(root, 'state', 'backups'),
      overwriteDir: join(root, 'state', 'overwrite'),
      configure: (m) => terrariaIntegration.configure!(ctx.game, ctx.info, m, mods, ctx.env, ctx.host),
      verifyExtra: (m) => terrariaIntegration.verify!(ctx.game, ctx.info, m, mods, ctx.env),
      loadVerifiable: true
    })
  }

  it('a mod with several dependencies, all installed through NexusForge: every one is switched on, all checks pass', async () => {
    const ctx = await setupGog()
    const addon = await modFrom('addon', { 'InfernumMode.tmod': buildTmod('InfernumMode', '1.0', '2026.8.3.0', undefined, { refs: ['CalamityMod', 'Luminance'] }) }, ctx)
    const calamity = await modFrom('calamity', { 'CalamityMod.tmod': buildTmod('CalamityMod', '2.0', '2026.8.3.0') }, ctx)
    const lib = await modFrom('lib', { 'Luminance.tmod': buildTmod('Luminance', '1.0', '2026.8.3.0') }, ctx)
    const report = await deploy(ctx, [calamity, lib, addon])
    expect(report.outcome).toBe('verified')
    expect(JSON.parse(await fsp.readFile(join(ctx.saves, 'Mods', 'enabled.json'), 'utf8')).sort()).toEqual(['CalamityMod', 'InfernumMode', 'Luminance'])
    expect(report.verification?.checks.filter((c) => !c.ok)).toEqual([])
  })

  it("switches on a dependency the user already has in tModLoader's Mods folder, and warns about a missing one", async () => {
    const ctx = await setupGog()
    await write(join(ctx.saves, 'Mods', 'CalamityMod.tmod'), buildTmod('CalamityMod', '2.0', '2026.8.3.0'))
    await write(join(ctx.saves, 'Mods', 'enabled.json'), '[]')
    const addon = await modFrom('addon', { 'InfernumMode.tmod': buildTmod('InfernumMode', '1.0', '2026.8.3.0', undefined, { refs: ['CalamityMod', 'Luminance'] }) }, ctx)
    const report = await deploy(ctx, [addon])
    expect(report.outcome).toBe('verified')
    expect(JSON.parse(await fsp.readFile(join(ctx.saves, 'Mods', 'enabled.json'), 'utf8')).sort()).toEqual(['CalamityMod', 'InfernumMode'])
    const missing = report.verification?.checks.filter((c) => !c.ok) ?? []
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ level: 'warning', label: expect.stringMatching(/needs Luminance/) })
    // The user's own CalamityMod.tmod is still theirs: purging leaves it and takes only NexusForge's names out.
    const purge = await deploy(ctx, [])
    expect(purge.outcome).toBe('verified')
    expect(await fsp.readFile(join(ctx.saves, 'Mods', 'CalamityMod.tmod'))).toBeTruthy()
    expect(JSON.parse(await fsp.readFile(join(ctx.saves, 'Mods', 'enabled.json'), 'utf8'))).toEqual([])
  })
})

describe('end to end (isolated folders)', () => {
  it('GOG Terraria with tModLoader: a .tmod and an adventure map land where they load, enabled.json lists the mod, all verified', async () => {
    const dir = join(root, 'Games', 'Terraria')
    await terrariaFolder(dir)
    await write(join(dir, 'goggame-1207665503.info'), '{}')
    const tmlDir = join(root, 'Games', 'tModLoader')
    await write(join(tmlDir, 'tModLoader.dll'), 'TML')
    await write(join(tmlDir, 'start-tModLoader.bat'), '@echo off')
    const env = fakeEnv(root)
    env.versions[join(tmlDir, 'tModLoader.dll').toLowerCase()] = '2026.8.3.0'
    const game = gogGame(dir)
    const host = fakeHost()
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    expect(info.loaders[0]).toMatchObject({ state: 'installed', version: '2026.8.3.0' })

    const p = await pkg({ 'CalamityMod.tmod': buildTmod('CalamityMod', '2.0.4.1', '2026.8.3.0'), 'Calamity World/Abyss.wld': 'WORLD', 'Calamity World/Abyss.twld': 'TWLD', 'readme.txt': 'x' }, 'Calamity')
    const c = await terrariaIntegration.classify(p, game, info, env)
    const mod = { id: 'm1', name: 'Calamity', gameId: game.id, stagingDir: p.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, needsLoader: c.needsLoader } as InstalledMod
    const plan = buildPlan([{ id: 'm1', revision: 1, files: await planFilesFor(mod) }], {})
    const report = await applyDeployment({
      gameId: game.id,
      profileId: 'p',
      targets: engineTargets(info),
      strategy: 'auto',
      plan,
      manifestPath: join(root, 'state', 'manifest.json'),
      backupDir: join(root, 'state', 'backups'),
      overwriteDir: join(root, 'state', 'overwrite'),
      configure: (m) => terrariaIntegration.configure!(game, info, m, [mod], env, host),
      verifyExtra: (m) => terrariaIntegration.verify!(game, info, m, [mod], env),
      loadVerifiable: true
    })
    expect(report.problem).toBeUndefined()
    expect(report.outcome).toBe('verified')
    expect(report.verification?.loadVerified).toBe(true)
    const saves = join(root, 'Documents', 'My Games', 'Terraria', 'tModLoader')
    expect((await readTmod(join(saves, 'Mods', 'CalamityMod.tmod'))).name).toBe('CalamityMod')
    expect(JSON.parse(await fsp.readFile(join(saves, 'Mods', 'enabled.json'), 'utf8'))).toEqual(['CalamityMod'])
    expect(await fsp.readFile(join(saves, 'Worlds', 'Abyss.wld'), 'utf8')).toBe('WORLD')
    expect(report.verification?.checks.filter((x) => !x.ok)).toEqual([])
    // Nothing went into the Terraria folder.
    expect((await fsp.readdir(dir)).sort()).toEqual(['Content', 'Terraria.exe', 'goggame-1207665503.info'])

    // Purge: the mod leaves, enabled.json loses only that name.
    const purge = await applyDeployment({
      gameId: game.id,
      profileId: 'p',
      targets: engineTargets(info),
      strategy: 'auto',
      plan: { entries: new Map(), conflicts: [], hash: 'empty' },
      manifestPath: join(root, 'state', 'manifest.json'),
      backupDir: join(root, 'state', 'backups'),
      overwriteDir: join(root, 'state', 'overwrite'),
      configure: (m) => terrariaIntegration.configure!(game, info, m, [mod], env, host)
    })
    expect(purge.outcome).toBe('verified')
    await expect(fsp.access(join(saves, 'Mods', 'CalamityMod.tmod'))).rejects.toThrow()
    expect(JSON.parse(await fsp.readFile(join(saves, 'Mods', 'enabled.json'), 'utf8'))).toEqual([])
  })
})
