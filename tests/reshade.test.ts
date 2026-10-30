// ReShade for every game: release lookup and the signed setup, the graphics API, the DLL name next to files that
// came with the game, the per-game folder archive from a real case (GTA V x Minecraft: "GTA V/" with a bundled
// ReShade add-on build and Script Hook V copies, next to "Minecraft/" with a .jar), ReShade.ini, presets, the
// log, shader packs. Everything runs against fake folders and a fake network: no real game folder is touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { deflateRawSync, crc32 } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeployManifest, Game, InstalledMod, IntegrationInfo } from '../src/shared/types'
import { classifyPackage, nameForms, perGameFolder } from '../src/main/mods/classify'
import { gta5Integration, gtaSaveRoutes } from '../src/main/integrations/gta5'
import { genericIntegration } from '../src/main/integrations/generic'
import { capabilitiesOf, type GameIntegration, type IntegrationState, type LoaderInstallHost } from '../src/main/integrations/types'
import { planFilesFor } from '../src/main/mods/routes'
import { walkFiles } from '../src/main/util/fs'
import { IniDoc } from '../src/main/reshade/ini'
import { readPe } from '../src/main/reshade/pe'
import { clearListCache, LIST_BASE, parseCompatibility, parseEffectPackages } from '../src/main/reshade/lists'
import { clearReshadeCache, embeddedFile, embeddedZip, parseReshadePage, RESHADE_THUMBPRINT, reshadeBinaries } from '../src/main/reshade/release'
import { parseReshadeLog } from '../src/main/reshade/log'
import { isPresetText, parsePreset } from '../src/main/reshade/presets'
import {
  apiFromImports,
  applyIniDefaults,
  chooseModule,
  configureReshade,
  detectApi,
  diagnoseReshade,
  EFFECTS_ID,
  effectsLoader,
  findReshade,
  layoutEffectPackage,
  moduleNames,
  packagesFor,
  presetViews,
  renderTarget,
  RESHADE_ID,
  RESHADE_MARKER,
  reshadeLoader,
  withReshade
} from '../src/main/reshade/core'
import { fakeEnv, fakePe, gameOf, write, type FakeEnv } from './helpers'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-reshade-'))
  clearListCache()
  clearReshadeCache()
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures

/** A setup program as reshade.me ships it: program bytes, then a zip archive, then a signature blob. */
function fakeSetup(entries: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(entries)) {
    const comp = deflateRawSync(data)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    locals.push(local, n, comp)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc32(data), 16)
    c.writeUInt32LE(comp.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    centrals.push(c, n)
    offset += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  const program = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4094, 7)])
  return Buffer.concat([program, ...locals, cd, end, Buffer.alloc(7966, 0x30)])
}

const PAGE = `<h1>Download</h1> <div class="sample-description"><p><strong>Version 6.8.0</strong> was <a href="/releases">released</a> on August 2nd 2026.</p>
<p><a href="/downloads/ReShade_Setup_6.8.0.exe" class="button">Download ReShade 6.8.0</a></p>
<a href="/downloads/ReShade_Setup_6.8.0_Addon.exe" class="button">Download ReShade 6.8.0 with full add-on support</a> </p>
<p><strong>X.509 Digital Signature Thumbprint: \u200e589690208A5E52FB96980C4A6698F50ACD47C49F</strong></p></div>`

const COMPAT = `# Apex Legends
[r5apex.exe]
Banned=1
RenderApi=D3D11

# Grand Theft Auto V
[GTA5.exe]
RenderApi=D3D11
DepthReversed=1

# Half Life 2
[hl2.exe]
RenderApi=D3D9
InstallTarget=bin
DepthReversed=0
DepthCopyBeforeClears=1
`

const PACKAGES = `[00]
Enabled=1
Required=1
PackageName=Standard effects
PackageDescription=A small set of utility effects (DisplayDepth, UIMask, ...)
InstallPath=.\\reshade-shaders\\Shaders
TextureInstallPath=.\\reshade-shaders\\Textures
DownloadUrl=https://github.com/crosire/reshade-shaders/archive/slim.zip
RepositoryUrl=https://github.com/crosire/reshade-shaders/tree/slim
EffectFiles=Daltonize.fx,Deband.fx,DisplayDepth.fx,LUT.fx,UIMask.fx

[01]
Enabled=1
PackageName=SweetFX by CeeJay.dk
PackageDescription=The original SweetFX shader collection (LumaSharpen, SMAA, ...)
InstallPath=.\\reshade-shaders\\Shaders
TextureInstallPath=.\\reshade-shaders\\Textures
DownloadUrl=https://github.com/CeeJayDK/SweetFX/archive/master.zip
RepositoryUrl=https://github.com/CeeJayDK/SweetFX
EffectFiles=CAS.fx,LumaSharpen.fx,SMAA.fx,Vibrance.fx
DenyEffectFiles=Template.fx

[03]
PackageName=OtisFX by Otis_Inf
PackageDescription=A set of effects for virtual photographers (Cinematic DOF, ...)
InstallPath=.\\reshade-shaders\\Shaders\\OtisFX
TextureInstallPath=.\\reshade-shaders\\Textures\\OtisFX
DownloadUrl=https://github.com/FransBouma/OtisFX/archive/master.zip
RepositoryUrl=https://github.com/FransBouma/OtisFX
EffectFiles=AdaptiveFog.fx,CinematicDOF.fx
`

function onlineEnv(over: Partial<FakeEnv> = {}): FakeEnv {
  return fakeEnv(root, {
    async fetchText(url: string) {
      if (url === 'https://reshade.me/') return PAGE
      if (url === `${LIST_BASE}/Compatibility.ini`) return COMPAT
      if (url === `${LIST_BASE}/EffectPackages.ini`) return PACKAGES
      throw new Error(`offline: ${url}`)
    },
    ...over
  })
}

function infoOf(game: Game, integration: GameIntegration, targets = [{ id: 'game', label: 'Game folder', dir: game.modding.targetDir }]): IntegrationInfo {
  return {
    gameId: game.id,
    integrationId: integration.id,
    name: integration.id,
    support: 'basic',
    distribution: { kind: 'standalone', label: 'Standalone folder' },
    valid: true,
    problems: [],
    targets,
    loaders: [],
    launchOptions: [],
    capabilities: [],
    warnings: [],
    limitations: [],
    inspectedAt: 0,
    supports: capabilitiesOf(integration)
  }
}

async function pkg(files: Record<string, string | Buffer>, name: string) {
  const dir = join(root, 'pkg', name)
  for (const [rel, data] of Object.entries(files)) await write(join(dir, rel), data)
  return { dir, files: await walkFiles(dir), name }
}

/** A repacked GTA V (wrapper folder, RUNE's Social Club emulator, Script Hook V). */
async function gtaGame() {
  const wrapper = join(root, 'D', 'Games', 'Grand-Theft-Auto-V-Repack')
  const dir = join(wrapper, 'Grand Theft Auto V')
  await write(join(dir, 'GTA5.exe'), fakePe({ imports: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll', 'xinput1_4.dll'] }))
  await write(join(dir, 'version.dll'), 'MZ\0socialclub_emu\0')
  await write(join(dir, 'dinput8.dll'), 'MZ\0Alexander Blade\0')
  const game = gameOf({ id: 'test:gta', name: 'Grand Theft Auto V', installDir: wrapper, exePath: join(dir, 'GTA5.exe') })
  game.modding.targetDir = dir
  return { game, dir, wrapper }
}

function host(states: Record<string, IntegrationState> = {}, mods: InstalledMod[] = []): LoaderInstallHost & { packages: Array<{ name: string; version?: string; files: string[] }> } {
  const packages: Array<{ name: string; version?: string; files: string[] }> = []
  return {
    packages,
    async installModFile(_g, file, meta) {
      packages.push({ name: meta.name, version: meta.version, files: (await walkFiles(file)).map((f) => f.rel).sort() })
      return { id: 'm', name: meta.name } as InstalledMod
    },
    state: (g) => states[g] ?? { loaders: {} },
    saveState: (g, s) => {
      states[g] = s
    },
    mods: () => mods
  }
}

// ---------------------------------------------------------------------------

describe('ReShade release and setup', () => {
  it("reads the version, both builds and the signing certificate from reshade.me's download section", () => {
    const r = parseReshadePage(PAGE)!
    expect(r.version).toBe('6.8.0')
    expect(r.url).toBe('https://reshade.me/downloads/ReShade_Setup_6.8.0.exe')
    expect(r.addonUrl).toBe('https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe')
    expect(r.thumbprint).toBe(RESHADE_THUMBPRINT)
    expect(parseReshadePage('<html>nothing</html>')).toBeUndefined()
  })

  it('finds the archive appended to the setup (before its signature) and checks every file', () => {
    const dll = Buffer.from('MZ fake ReShade64 '.repeat(500))
    const setup = fakeSetup({ 'ReShade32.dll': Buffer.from('MZ 32'), 'ReShade64.dll': dll, 'ReShade64.json': Buffer.from('{}') })
    const entries = embeddedZip(setup)
    expect(entries.map((e) => e.name)).toEqual(['ReShade32.dll', 'ReShade64.dll', 'ReShade64.json'])
    expect(embeddedFile(setup, entries[1]).equals(dll)).toBe(true)
    const broken = Buffer.from(setup)
    broken[entries[1].local + 60] ^= 0xff
    expect(() => embeddedFile(broken, entries[1])).toThrow(/checksum|invalid|incorrect/i)
    expect(() => embeddedZip(Buffer.alloc(5000))).toThrow(/no archive/)
  })

  it('downloads from reshade.me, insists on ReShade\'s signature, unpacks once and reuses the checked copy', async () => {
    let downloads = 0
    const setup = fakeSetup({ 'ReShade32.dll': Buffer.from('MZ 32-bit'), 'ReShade64.dll': Buffer.from('MZ 64-bit') })
    const env = onlineEnv({
      async download(url, dest, opts) {
        downloads++
        expect(url).toBe('https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe')
        expect(opts?.allowedHosts).toEqual(['reshade.me', 'www.reshade.me'])
        await write(dest, setup)
        return { sha256: '', size: setup.length }
      },
      verifySignature: async () => ({ status: 'UnknownError', thumbprint: RESHADE_THUMBPRINT }),
      fileVersion: async () => '6.8.0.2155'
    })
    const bins = await reshadeBinaries(env, 'addon')
    expect(bins.version).toBe('6.8.0')
    expect(await fsp.readFile(join(bins.dir, 'ReShade64.dll'), 'utf8')).toBe('MZ 64-bit')
    expect((await fsp.readdir(bins.dir)).sort()).toEqual(['ReShade32.dll', 'ReShade64.dll', 'verified.json'])
    await reshadeBinaries(env, 'addon')
    expect(downloads).toBe(1)
  })

  it('refuses a setup signed by anyone else, or not signed at all', async () => {
    const setup = fakeSetup({ 'ReShade32.dll': Buffer.from('a'), 'ReShade64.dll': Buffer.from('b') })
    const download = async (_u: string, dest: string) => {
      await write(dest, setup)
      return { sha256: '', size: setup.length }
    }
    await expect(reshadeBinaries(onlineEnv({ download, verifySignature: async () => ({ status: 'UnknownError', thumbprint: 'AAAA' }) }), 'standard')).rejects.toThrow(/not signed with ReShade's certificate/)
    await expect(reshadeBinaries(onlineEnv({ download, verifySignature: async () => ({ status: 'HashMismatch', thumbprint: RESHADE_THUMBPRINT }) }), 'standard')).rejects.toThrow(/HashMismatch/)
    await expect(reshadeBinaries(onlineEnv({ download }), 'standard')).rejects.toThrow(/cannot check digital signatures/)
  })
})

describe('graphics API and DLL name', () => {
  it("reads machine type, imports and signature from an executable's headers", async () => {
    await write(join(root, 'a.exe'), fakePe({ imports: ['KERNEL32.dll', 'd3d11.dll', 'dxgi.dll'], signed: true }))
    await write(join(root, 'b.exe'), fakePe({ machine: 'x86', imports: ['d3d9.dll'] }))
    expect(await readPe(join(root, 'a.exe'))).toMatchObject({ machine: 'x64', imports: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll'], signed: true })
    expect(await readPe(join(root, 'b.exe'))).toMatchObject({ machine: 'x86', imports: ['d3d9.dll'], signed: false })
    expect(await readPe(join(root, 'nope.exe'))).toBeUndefined()
  })

  it("picks the API the way ReShade's setup does", () => {
    expect(apiFromImports(['d3d11.dll', 'dxgi.dll'])).toMatchObject({ api: 'dxgi', dx: '11' })
    expect(apiFromImports(['d3d12.dll', 'dxgi.dll'])).toMatchObject({ api: 'dxgi', dx: '12' })
    expect(apiFromImports(['d3d9.dll'])).toMatchObject({ api: 'd3d9' })
    expect(apiFromImports(['d3d9.dll', 'd3d11.dll'])).toMatchObject({ api: 'dxgi' })
    expect(apiFromImports(['vulkan-1.dll', 'd3d12.dll'])).toMatchObject({ api: 'vulkan' })
    expect(apiFromImports(['opengl32.dll'])).toMatchObject({ api: 'opengl' })
    expect(apiFromImports(['opengl32.dll', 'd3d9.dll'])).toMatchObject({ api: 'd3d9' })
    expect(apiFromImports(['d3d8.dll'])).toMatchObject({ api: 'd3d9', d3d8: true })
    expect(apiFromImports(['kernel32.dll'])).toEqual({})
  })

  it("trusts ReShade's compatibility list first, then the imports, then a render DLL next to the exe", async () => {
    const env = onlineEnv()
    const { game } = await gtaGame()
    const t = (await renderTarget(game, env))!
    expect(t.compat?.renderApi).toBe('D3D11')
    expect(await detectApi(t)).toMatchObject({ api: 'dxgi', dx: '11', source: 'compat' })
    const unity = join(root, 'Unity')
    await write(join(unity, 'Game.exe'), fakePe({ imports: ['kernel32.dll'] }))
    await write(join(unity, 'UnityPlayer.dll'), fakePe({ imports: ['d3d11.dll', 'dxgi.dll'] }))
    const u = (await renderTarget(gameOf({ name: 'Some Unity Game', installDir: unity, exePath: join(unity, 'Game.exe') }), env))!
    expect(await detectApi(u)).toMatchObject({ api: 'dxgi', source: 'dll', evidence: expect.stringMatching(/Unity renders with Direct3D 11/) })
    // Another engine: what its DLLs import together, DirectX before OpenGL.
    const eng = join(root, 'Engine')
    await write(join(eng, 'Game.exe'), fakePe({ imports: ['kernel32.dll'] }))
    await write(join(eng, 'gl.dll'), fakePe({ imports: ['opengl32.dll'] }))
    await write(join(eng, 'renderer.dll'), fakePe({ imports: ['d3d9.dll'] }))
    const e = (await renderTarget(gameOf({ name: 'Engine Game', installDir: eng, exePath: join(eng, 'Game.exe') }), env))!
    expect(await detectApi(e)).toMatchObject({ api: 'd3d9', source: 'dll', evidence: expect.stringMatching(/d3d9\.dll \(renderer\.dll\)/) })
  })

  it('never takes a name a file of the game uses: falls back to d3d11.dll, or to an .asi when an ASI loader is there', async () => {
    const dir = join(root, 'G')
    await write(join(dir, 'dxgi.dll'), 'MZ\0ENBSeries by Boris Vorontsov\0')
    expect(await moduleNames('dxgi', '11', dir, 'x64')).toEqual(['dxgi.dll', 'd3d11.dll'])
    const c = await chooseModule(dir, await moduleNames('dxgi', '11', dir, 'x64'))
    expect(c).toMatchObject({ name: 'd3d11.dll', fallback: 'dxgi.dll', taken: [{ name: 'dxgi.dll', label: 'ENBSeries' }] })
    await write(join(dir, 'd3d11.dll'), 'MZ\0Special K\0')
    await write(join(dir, 'dinput8.dll'), 'MZ\0Alexander Blade\0')
    const names = await moduleNames('dxgi', '11', dir, 'x64')
    expect(names).toEqual(['dxgi.dll', 'd3d11.dll', 'ReShade64.asi'])
    expect((await chooseModule(dir, names)).name).toBe('ReShade64.asi')
    // A ReShade already there keeps its name; one NexusForge deployed is ours to replace.
    await write(join(dir, 'ReShade64.asi'), "MZ\0crosire's ReShade\0")
    expect((await chooseModule(dir, names)).name).toBe('ReShade64.asi')
  })
})

describe('ReShade status per game', () => {
  it("GTA V: goes in as ReShade64.asi through Script Hook V's ASI loader (the game loads dxgi.dll from System32)", async () => {
    const env = onlineEnv()
    const { game } = await gtaGame()
    const s = await reshadeLoader.status(game, infoOf(game, gta5Integration), env, { loaders: {} }, [])
    expect(s).toMatchObject({ state: 'missing', canInstall: true, proxy: 'ReShade64.asi', latest: '6.8.0', requires: ['scripthookv'] })
    expect(s.detail).toMatch(/as ReShade64\.asi \(DirectX 10\/11\/12, from ReShade's compatibility list\)/)
    expect(s.detail).toMatch(/straight from Windows' System32 folder/)
  })

  it('GTA V: a ReShade installed by hand as dxgi.dll is never loaded; NexusForge says so and offers the fix', async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    await write(join(dir, 'dxgi.dll'), "MZ\0crosire's ReShade post-processing injector for 64-bit\0")
    await write(join(dir, 'ReShade.log'), "\r\nIf you are reading this after launching the game at least once, it likely means ReShade was not loaded by the game.\r\n")
    const old = new Date(Date.now() - 3600_000)
    await fsp.utimes(join(dir, 'ReShade.log'), old, old)
    await write(join(dir, 'ScriptHookV.log'), '[12:11:54] INIT: Started')
    const s = await reshadeLoader.status(game, infoOf(game, gta5Integration), env, { loaders: {} }, [])
    expect(s).toMatchObject({ state: 'broken', canInstall: true, via: 'manual', proxy: 'dxgi.dll' })
    expect(s.detail).toMatch(/as dxgi\.dll, but GTA V loads dxgi\.dll and d3d11\.dll straight from Windows' System32 folder.*ReShade64\.asi/)
    const findings = await diagnoseReshade({ game, mods: [], enabled: new Set(), env, state: { loaders: {} } })
    expect(findings.map((f) => f.code).sort()).toEqual(['NF-RSH-007', 'NF-RSH-008'])
    expect(findings.find((f) => f.code === 'NF-RSH-007')?.fixes[0]).toMatchObject({ id: 'reshade-setup', label: 'Install ReShade as an ASI plugin' })
    // Once NexusForge's ReShade64.asi is there, the old dxgi.dll is only an unused leftover (no "two copies").
    await write(join(dir, 'ReShade64.asi'), "MZ\0crosire's ReShade\0")
    const managed = { id: 'rs', name: 'ReShade', loaderId: RESHADE_ID, version: '6.8.0', meta: { build: 'addon' }, routes: [{ from: 'ReShade64.dll', target: 'game', to: 'ReShade64.asi' }] } as unknown as InstalledMod
    const after = await reshadeLoader.status(game, infoOf(game, gta5Integration), env, { loaders: {} }, [managed])
    expect(after).toMatchObject({ state: 'installed', proxy: 'ReShade64.asi', detail: expect.stringMatching(/dxgi\.dll \(also ReShade\) is never loaded/) })
    const later = await diagnoseReshade({ game, mods: [managed], enabled: new Set(['rs']), env, state: { loaders: {} } })
    expect(later.find((f) => f.code === 'NF-RSH-008')).toMatchObject({ severity: 'info', fixes: [{ params: { cleanup: '1' } }] })
    expect(later.some((f) => f.code === 'NF-RSH-001')).toBe(false)
  })

  it("refuses games ReShade's list marks as banning it, and Vulkan games", async () => {
    const env = onlineEnv()
    const apex = join(root, 'Apex')
    await write(join(apex, 'r5apex.exe'), fakePe({ imports: ['d3d11.dll'] }))
    const a = gameOf({ name: 'Apex Legends', installDir: apex, exePath: join(apex, 'r5apex.exe') })
    expect(await reshadeLoader.status(a, infoOf(a, genericIntegration), env, { loaders: {} }, [])).toMatchObject({ state: 'unsupported', canInstall: false, blocked: expect.stringMatching(/bans ReShade/) })
    const vk = join(root, 'Vk')
    await write(join(vk, 'game.exe'), fakePe({ imports: ['vulkan-1.dll'] }))
    const v = gameOf({ name: 'Vulkan Game', installDir: vk, exePath: join(vk, 'game.exe') })
    expect(await reshadeLoader.status(v, infoOf(v, genericIntegration), env, { loaders: {} }, [])).toMatchObject({ state: 'missing', canInstall: false, blocked: expect.stringMatching(/system-wide Vulkan layer/) })
    // The user can pick DirectX when the game also runs with it.
    expect(await reshadeLoader.status(v, infoOf(v, genericIntegration), env, { loaders: {}, reshade: { api: 'dxgi' } }, [])).toMatchObject({ state: 'missing', canInstall: true, proxy: 'dxgi.dll' })
  })

  it('asks for the API when the executable shows none, and reports two copies of ReShade', async () => {
    const env = onlineEnv()
    const dir = join(root, 'Odd')
    await write(join(dir, 'odd.exe'), fakePe({ imports: ['kernel32.dll'] }))
    const g = gameOf({ name: 'Odd', installDir: dir, exePath: join(dir, 'odd.exe') })
    expect(await reshadeLoader.status(g, infoOf(g, genericIntegration), env, { loaders: {} }, [])).toMatchObject({ state: 'missing', canInstall: false, blocked: expect.stringMatching(/Pick the graphics API/) })
    await write(join(dir, 'dxgi.dll'), "MZ\0crosire's ReShade\0")
    await write(join(dir, 'dinput8.dll'), 'MZ\0Ultimate ASI Loader\0')
    await write(join(dir, 'ReShade64.asi'), "MZ\0crosire's ReShade\0")
    expect((await findReshade(dir)).map((c) => c.name).sort()).toEqual(['ReShade64.asi', 'dxgi.dll'])
    expect(await reshadeLoader.status(g, infoOf(g, genericIntegration), env, { loaders: {} }, [])).toMatchObject({ state: 'broken', detail: expect.stringMatching(/twice/) })
  })

  it("switches NexusForge's ReShade to the add-on build when a mod is a ReShade add-on", async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    await write(join(dir, 'dxgi.dll'), "MZ\0crosire's ReShade\0")
    const managed = { id: 'rs', name: 'ReShade', loaderId: RESHADE_ID, version: '6.8.0', meta: { build: 'standard' }, routes: [{ from: 'ReShade64.dll', target: 'game', to: 'dxgi.dll' }] } as unknown as InstalledMod
    const addon = { id: 'mc', name: 'GTA V X Minecraft', needsLoader: 'scripthookv', needsLoaders: [RESHADE_ID], meta: { reshadeAddon: '1' } } as unknown as InstalledMod
    const s = await reshadeLoader.status(game, infoOf(game, gta5Integration), env, { loaders: {} }, [managed, addon])
    expect(s).toMatchObject({ state: 'outdated', canUpdate: true, refresh: true, required: true })
    expect(s.detail).toMatch(/GTA V X Minecraft needs ReShade with add-on support/)
    expect(s.warning).toMatch(/single-player/)
  })
})

describe('installing ReShade', () => {
  it('puts the checked DLL and a note of build and API into a package for the deploy engine', async () => {
    const setup = fakeSetup({ 'ReShade32.dll': Buffer.from('MZ 32'), 'ReShade64.dll': Buffer.from('MZ 64') })
    const env = onlineEnv({
      async download(_u, dest) {
        await write(dest, setup)
        return { sha256: '', size: setup.length }
      },
      verifySignature: async () => ({ status: 'UnknownError', thumbprint: RESHADE_THUMBPRINT })
    })
    const { game } = await gtaGame()
    const addon = { id: 'mc', name: 'GTA V X Minecraft', meta: { reshadeAddon: '1' } } as unknown as InstalledMod
    const h = host({}, [addon])
    await reshadeLoader.install(game, infoOf(game, gta5Integration), env, h, () => {})
    expect(h.packages).toEqual([{ name: 'ReShade', version: '6.8.0', files: ['ReShade64.dll', RESHADE_MARKER] }])
    // The package classifies as ReShade: in GTA V as ReShade64.asi, in an ordinary Direct3D 11 game as dxgi.dll.
    const p = await pkg({ 'ReShade64.dll': 'MZ 64', [RESHADE_MARKER]: JSON.stringify({ version: '6.8.0', build: 'addon', arch: 'x64', api: 'dxgi' }) }, 'ReShade')
    const c = await classifyPackage(p, { game, info: infoOf(game, gta5Integration), integration: gta5Integration, env })
    expect(c).toMatchObject({ kind: 'loader', loaderId: RESHADE_ID, routes: [{ from: 'ReShade64.dll', target: 'game', to: 'ReShade64.asi' }], meta: { build: 'addon', api: 'dxgi', strategy: 'reshade' } })
    const other = join(root, 'Other')
    await write(join(other, 'game.exe'), fakePe({ imports: ['d3d11.dll'] }))
    const g2 = gameOf({ name: 'Other', installDir: other, exePath: join(other, 'game.exe') })
    const c2 = await classifyPackage(p, { game: g2, info: infoOf(g2, genericIntegration), integration: genericIntegration, env })
    expect(c2.routes).toEqual([{ from: 'ReShade64.dll', target: 'game', to: 'dxgi.dll' }])
  })

  it("lays shader packs out like ReShade's setup: Shaders and Textures folders, denied effects left out", async () => {
    const packs = parseEffectPackages(PACKAGES)
    const sweet = join(root, 'x', 'sweet')
    await write(join(sweet, 'SweetFX-master', 'Shaders', 'SMAA.fx'), 'smaa')
    await write(join(sweet, 'SweetFX-master', 'Shaders', 'Template.fx'), 'template')
    await write(join(sweet, 'SweetFX-master', 'Shaders', 'ReShade.fxh'), 'old header')
    await write(join(sweet, 'SweetFX-master', 'Textures', 'SMAA_area.png'), 'png')
    await write(join(sweet, 'SweetFX-master', 'README.md'), 'readme')
    const otis = join(root, 'x', 'otis')
    await write(join(otis, 'OtisFX-master', 'Shaders', 'CinematicDOF.fx'), 'dof')
    const out = join(root, 'out')
    await write(join(out, 'reshade-shaders', 'Shaders', 'ReShade.fxh'), 'standard header')
    expect(await layoutEffectPackage(sweet, packs[1], out, true)).toBe(2)
    expect(await layoutEffectPackage(otis, packs[2], out, true)).toBe(1)
    const files = (await walkFiles(out)).map((f) => f.rel).sort()
    expect(files).toEqual(['reshade-shaders/Shaders/OtisFX/CinematicDOF.fx', 'reshade-shaders/Shaders/ReShade.fxh', 'reshade-shaders/Shaders/SMAA.fx', 'reshade-shaders/Textures/SMAA_area.png'])
    expect(await fsp.readFile(join(out, 'reshade-shaders', 'Shaders', 'ReShade.fxh'), 'utf8')).toBe('standard header')
  })

  it('picks the default packs plus the ones that have the effects a preset uses', () => {
    const packs = parseEffectPackages(PACKAGES)
    expect(packs.map((p) => [p.name, p.required, p.enabled])).toEqual([
      ['Standard effects', true, true],
      ['SweetFX by CeeJay.dk', false, true],
      ['OtisFX by Otis_Inf', false, false]
    ])
    expect(packagesFor(packs, ['CinematicDOF.fx', 'Mystery.fx']).packages.map((p) => p.name)).toEqual(['Standard effects', 'SweetFX by CeeJay.dk', 'OtisFX by Otis_Inf'])
    expect(packagesFor(packs, ['CinematicDOF.fx', 'Mystery.fx']).unknown).toEqual(['Mystery.fx'])
    expect(packagesFor(packs, [], ['OtisFX by Otis_Inf']).packages.map((p) => p.name)).toEqual(['Standard effects', 'OtisFX by Otis_Inf'])
  })

  it('shader packs are needed again when a new preset uses effects they lack', async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    const staging = join(root, 'staging', 'fx')
    await write(join(staging, 'reshade-shaders', 'Shaders', 'SMAA.fx'), 'smaa')
    const fx = { id: 'fx', name: 'ReShade shader packs', loaderId: EFFECTS_ID, stagingDir: staging, updatedAt: 1, version: '2026.10.30', meta: { packages: 'Standard effects|SweetFX by CeeJay.dk' } } as unknown as InstalledMod
    const preset = { id: 'p', name: 'Cinematic', needsLoader: RESHADE_ID, needsLoaders: [EFFECTS_ID], meta: { reshadeEffects: 'SMAA.fx,CinematicDOF.fx' } } as unknown as InstalledMod
    void dir
    const s = await effectsLoader.status(game, infoOf(game, gta5Integration), env, { loaders: {} }, [fx, preset])
    expect(s).toMatchObject({ state: 'outdated', refresh: true, canUpdate: true, required: true, detail: expect.stringMatching(/CinematicDOF\.fx/) })
  })
})

describe('GTA V x Minecraft: one folder per game', () => {
  async function minecraftPack() {
    return pkg(
      {
        'GTA V X Minecraft/GTA V/dinput8.dll': 'MZ\0Alexander Blade\0',
        'GTA V X Minecraft/GTA V/ScriptHookV.dll': 'MZ\0ScriptHookV\0',
        'GTA V X Minecraft/GTA V/args.txt': '-nobattleye -noBE',
        'GTA V X Minecraft/GTA V/ReShade64.asi': "MZ\0crosire's ReShade post-processing injector for 64-bit\0ReShadeRegisterAddon\0",
        'GTA V X Minecraft/GTA V/ReShade.ini':
          '[GENERAL]\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\\nTextureSearchPaths=.\\reshade-shaders\\Textures\\\nPresetPath=.\\ReShadePreset.ini\nPreprocessorDefinitions=RESHADE_DEPTH_INPUT_IS_REVERSED=1,RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=0,RESHADE_DEPTH_INPUT_IS_LOGARITHMIC=0,RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000\n\n[OVERLAY]\nTutorialProgress=4\n',
        'GTA V X Minecraft/GTA V/ReShadePreset.ini': 'Techniques=MCPassthrough@MCPassthrough.fx\nTechniqueSorting=MCPassthrough@MCPassthrough.fx\n',
        'GTA V X Minecraft/GTA V/MCPassthrough.asi': 'MZ\0ReShadeRegisterAddon\0?scriptRegister@@YAXPEAUHINSTANCE__@@P6AXXZ@Z\0',
        'GTA V X Minecraft/GTA V/reshade-shaders/Shaders/MCPassthrough.fx': 'technique MCPassthrough {}',
        'GTA V X Minecraft/GTA V/reshade-shaders/Shaders/ReShade.fxh': '// header',
        'GTA V X Minecraft/GTA V/reshade-shaders/Shaders/ReShadeUI.fxh': '// ui header',
        'GTA V X Minecraft/Minecraft/passthrough-0.1.0.jar': 'PK jar'
      },
      'GTA V X Minecraft'
    )
  }

  it('matches folder names to the game', () => {
    const gta = nameForms('Grand Theft Auto V')
    expect([...nameForms('GTA V')].some((f) => gta.has(f))).toBe(true)
    expect([...nameForms('GTA5')].some((f) => gta.has(f))).toBe(true)
    expect([...nameForms('Minecraft')].some((f) => gta.has(f))).toBe(false)
  })

  it('installs only the GTA V folder; Minecraft, the bundled ReShade and the Script Hook V copies stay out', async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    const p = await minecraftPack()
    const info = infoOf(game, gta5Integration, [
      { id: 'game', label: 'Game folder', dir },
      { id: 'scripts', label: 'scripts', dir: join(dir, 'scripts') }
    ])
    const c = await classifyPackage(p, { game, info, integration: gta5Integration, env })
    const skip = (path: string) => c.skipped.find((s) => s.path === path)?.reason
    expect(skip('GTA V X Minecraft/Minecraft')).toMatch(/another game or program \(it holds passthrough-0\.1\.0\.jar, a Java mod\); only the "GTA V" folder is for Grand Theft Auto V/)
    expect(skip('GTA V X Minecraft/GTA V/dinput8.dll')).toMatch(/ASI loader/)
    expect(skip('GTA V X Minecraft/GTA V/ScriptHookV.dll')).toMatch(/copy of Script Hook V/)
    expect(skip('GTA V X Minecraft/GTA V/args.txt')).toMatch(/Script Hook V's args\.txt/)
    expect(skip('GTA V X Minecraft/GTA V/ReShade64.asi')).toMatch(/a copy of ReShade/)
    expect(skip('GTA V X Minecraft/GTA V/ReShade.ini')).toMatch(/NexusForge writes ReShade\.ini/)
    expect(c.needsLoader).toBe('scripthookv')
    expect(c.needsLoaders).toEqual([RESHADE_ID])
    expect(c.meta?.reshadeAddon).toBe('1')
    expect(c.meta?.reshadeEffects).toBeUndefined()
    expect(c.meta?.reshadeDefines).toMatch(/RESHADE_DEPTH_INPUT_IS_REVERSED=1/)
    expect(c.checks.map((x) => x.code)).toEqual(expect.arrayContaining(['game_folder', 'needs_reshade']))
    const files = await planFilesFor({ stagingDir: p.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped })
    expect(files.map((f) => `${f.target}:${f.rel}`).sort()).toEqual([
      'game:MCPassthrough.asi',
      'game:ReShadePreset.ini',
      'game:reshade-shaders/Shaders/MCPassthrough.fx',
      'game:reshade-shaders/Shaders/ReShade.fxh',
      'game:reshade-shaders/Shaders/ReShadeUI.fxh'
    ])
  })

  it('leaves ordinary packages to the game rules', () => {
    const game = gameOf({ name: 'Grand Theft Auto V', installDir: join(root, 'GTA') })
    const f = (rels: string[]) => ({ files: rels.map((rel) => ({ rel, abs: rel, size: 1 })) })
    expect(perGameFolder(f(['Mod/scripts/a.dll', 'Mod/GTA V/readme.txt']), game)).toBeUndefined()
    expect(perGameFolder(f(['Mod v1/Data/a.esp', 'Mod v1/Other/b.txt']), game)).toBeUndefined()
    expect(perGameFolder(f(['GTA V/a.asi', 'install.bat', 'Minecraft/b.jar']), game)).toBeUndefined()
    expect(perGameFolder(f(['GTA V/a.asi', 'Screenshots/1.png']), game)?.others[0].reason).toMatch(/pictures or documentation/)
  })
})

describe('ReShade content of other games', () => {
  it('moves presets and shaders next to ReShade when the game keeps mods elsewhere', async () => {
    const env = onlineEnv()
    const exeDir = join(root, 'Game', 'bin')
    await write(join(exeDir, 'game.exe'), fakePe({ imports: ['d3d11.dll'] }))
    const game = gameOf({ name: 'Some Game', installDir: join(root, 'Game'), exePath: join(exeDir, 'game.exe') })
    game.modding.targetDir = join(root, 'Game', 'mods')
    const p = await pkg({ 'Pretty.ini': 'Techniques=SMAA@SMAA.fx,Bloom@MyBloom.fx\n\n[SMAA.fx]\nEdgeDetectionType=1\n', 'Shaders/MyBloom.fx': 'bloom', 'Textures/lens.png': 'png' }, 'Pretty preset')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    const files = await planFilesFor({ stagingDir: p.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped })
    expect(files.map((f) => `${f.target}:${f.rel}`).sort()).toEqual(['reshade:Pretty.ini', 'reshade:reshade-shaders/Shaders/MyBloom.fx', 'reshade:reshade-shaders/Textures/lens.png'])
    expect(c.meta?.reshadeEffects).toBe('SMAA.fx')
    expect(c.needsLoaders).toEqual([RESHADE_ID, EFFECTS_ID].filter((x) => x !== c.needsLoader))
  })

  it('every integration gets the ReShade loaders, and a reshade target only when a mod uses one', async () => {
    const env = onlineEnv()
    const exeDir = join(root, 'Game', 'bin')
    await write(join(exeDir, 'game.exe'), fakePe({ imports: ['d3d9.dll'] }))
    const game = gameOf({ name: 'Old Game', installDir: join(root, 'Game'), exePath: join(exeDir, 'game.exe') })
    const w = withReshade(genericIntegration)
    expect(w.loaders.map((l) => l.id)).toEqual([RESHADE_ID, EFFECTS_ID])
    const plain = await w.inspect(game, env, { loaders: {} }, [])
    expect(plain.targets.map((t) => t.id)).toEqual(['game'])
    expect(plain.loaders.find((l) => l.id === RESHADE_ID)).toMatchObject({ state: 'missing', canInstall: true, proxy: 'd3d9.dll' })
    const preset = { id: 'p', name: 'Preset', routes: [{ from: 'p.ini', target: 'reshade', to: 'p.ini' }] } as unknown as InstalledMod
    const withPreset = await w.inspect(game, env, { loaders: {} }, [preset])
    expect(withPreset.targets.find((t) => t.id === 'reshade')?.dir).toBe(exeDir)
  })
})

describe('ReShade.ini', () => {
  it('edits values in place and keeps everything else', () => {
    const doc = IniDoc.parse('; comment\n[GENERAL]\nPresetPath=.\\A.ini\nFoo=bar\n\n[OVERLAY]\nShowFPS=1\n')
    expect(doc.set('GENERAL', 'PresetPath', '.\\B.ini')).toBe(true)
    expect(doc.set('GENERAL', 'PresetPath', '.\\B.ini')).toBe(false)
    doc.set('INPUT', 'KeyOverlay', '36,0,0,0')
    doc.set('OVERLAY', 'ShowClock', '0')
    expect(doc.serialize()).toBe('; comment\r\n[GENERAL]\r\nPresetPath=.\\B.ini\r\nFoo=bar\r\n\r\n[OVERLAY]\r\nShowFPS=1\r\nShowClock=0\r\n\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\n')
    expect(doc.getList('GENERAL', 'Foo')).toEqual(['bar'])
  })

  it("writes the setup's defaults once, with the depth settings from the compatibility list", () => {
    const compat = parseCompatibility(COMPAT).get('gta5.exe')
    const doc = new IniDoc()
    expect(applyIniDefaults(doc, compat)).toBe(true)
    expect(doc.get('GENERAL', 'PreprocessorDefinitions')).toBe('RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=1000.0,RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=0,RESHADE_DEPTH_INPUT_IS_REVERSED=1,RESHADE_DEPTH_INPUT_IS_LOGARITHMIC=0')
    expect(doc.get('GENERAL', 'EffectSearchPaths')).toBe('.\\reshade-shaders\\Shaders\\**')
    expect(doc.get('INPUT', 'KeyOverlay')).toBe('36,0,0,0')
    expect(applyIniDefaults(doc, compat)).toBe(false)
    // An existing ReShade.ini that only searches the top folder gets the shader folder added.
    const own = IniDoc.parse('[GENERAL]\nEffectSearchPaths=.\\MyShaders\\\n[INPUT]\nKeyOverlay=45,0,0,0\n')
    applyIniDefaults(own, compat)
    expect(own.getList('GENERAL', 'EffectSearchPaths')).toEqual(['.\\MyShaders\\', '.\\reshade-shaders\\Shaders\\**'])
    expect(own.get('INPUT', 'KeyOverlay')).toBe('45,0,0,0')
    const hl2 = parseCompatibility(COMPAT).get('hl2.exe')!
    expect(hl2).toMatchObject({ renderApi: 'D3D9', installTarget: 'bin' })
    const d = new IniDoc()
    applyIniDefaults(d, hl2)
    expect(d.get('DEPTH', 'DepthCopyBeforeClears')).toBe('1')
  })

  it('creates ReShade.ini after a deployment, makes a mod preset active until the user picks one, and cleans up after ReShade', async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    await write(join(dir, 'dxgi.dll'), "MZ\0crosire's ReShade\0")
    await write(join(dir, 'Cinematic.ini'), 'Techniques=SMAA@SMAA.fx\n\n[SMAA.fx]\nA=1\n')
    await write(join(dir, 'Mine.ini'), 'Techniques=Vibrance@Vibrance.fx\n\n[Vibrance.fx]\nB=1\n')
    const info = infoOf(game, gta5Integration, [{ id: 'game', label: 'Game folder', dir }])
    const rs = { id: 'rs', name: 'ReShade', loaderId: RESHADE_ID, installedAt: 1, routes: [{ from: 'ReShade64.dll', target: 'game', to: 'dxgi.dll' }] } as unknown as InstalledMod
    const preset = { id: 'pre', name: 'Cinematic', installedAt: 2 } as unknown as InstalledMod
    const manifest = { entries: [{ modId: 'rs', target: 'game', rel: 'dxgi.dll' }, { modId: 'pre', target: 'game', rel: 'Cinematic.ini' }] } as unknown as DeployManifest
    const states: Record<string, IntegrationState> = {}
    const h = host(states)
    const r1 = await configureReshade(game, info, manifest, [rs, preset], env, h)
    expect(r1).toMatchObject({ created: true, changed: true, preset: '.\\Cinematic.ini' })
    const ini = IniDoc.parse(await fsp.readFile(join(dir, 'ReShade.ini'), 'utf8'))
    expect(ini.get('GENERAL', 'PresetPath')).toBe('.\\Cinematic.ini')
    expect(ini.get('GENERAL', 'PreprocessorDefinitions')).toMatch(/IS_REVERSED=1/)
    expect(states['test:gta'].reshade).toMatchObject({ createdIni: true, autoPreset: '.\\Cinematic.ini' })
    // Nothing changes on the next run.
    expect((await configureReshade(game, info, manifest, [rs, preset], env, h)).changed).toBe(false)
    // The user picks their own preset in ReShade's overlay: NexusForge never changes it again.
    ini.set('GENERAL', 'PresetPath', '.\\Mine.ini')
    await fsp.writeFile(join(dir, 'ReShade.ini'), ini.serialize())
    await configureReshade(game, info, manifest, [rs, preset], env, h)
    expect(states['test:gta'].reshade?.presetPicked).toBe(true)
    expect(IniDoc.parse(await fsp.readFile(join(dir, 'ReShade.ini'), 'utf8')).get('GENERAL', 'PresetPath')).toBe('.\\Mine.ini')
    // ReShade taken out (purge): the ReShade.ini NexusForge created goes out of the game folder too.
    await fsp.rm(join(dir, 'dxgi.dll'))
    expect((await configureReshade(game, info, { entries: [] } as unknown as DeployManifest, [rs, preset], env, h)).removed).toBe(true)
    expect(await fsp.access(join(dir, 'ReShade.ini')).then(() => true, () => false)).toBe(false)
    expect(states['test:gta'].reshade?.createdIni).toBe(false)
  })

  it('never touches a ReShade.ini the user had before', async () => {
    const env = onlineEnv()
    const { game, dir } = await gtaGame()
    await write(join(dir, 'dxgi.dll'), "MZ\0crosire's ReShade\0")
    await write(join(dir, 'ReShade.ini'), '[GENERAL]\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\reshade-shaders\\Textures\\**\nPresetPath=.\\Mine.ini\nPreprocessorDefinitions=X=1\n[INPUT]\nKeyOverlay=45,0,0,0\n[PROXY]\nEnableProxyLibrary=0\n')
    await write(join(dir, 'Mine.ini'), 'Techniques=Vibrance@Vibrance.fx\n')
    const before = await fsp.readFile(join(dir, 'ReShade.ini'), 'utf8')
    const states: Record<string, IntegrationState> = {}
    await configureReshade(game, infoOf(game, gta5Integration), { entries: [] } as unknown as DeployManifest, [], env, host(states))
    expect(await fsp.readFile(join(dir, 'ReShade.ini'), 'utf8')).toBe(before)
    expect(states['test:gta'].reshade?.createdIni).toBeFalsy()
  })
})

describe("ReShade's log and presets", () => {
  it('reads what the last start did (from a real GTA V log)', () => {
    const text = [
      "08:24:23:773 [25320] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) loaded from 'D:\\Games\\GTA V\\ReShade64.asi' into 'D:\\Games\\GTA V\\GTA5.exe' (0x9CC5C8E0) ...",
      '08:24:24:034 [25320] | INFO  | Redirecting D3D11CreateDevice(pAdapter = 0000000000000000, DriverType = 1) ...',
      '08:24:24:115 [23680] | INFO  | Running on NVIDIA GeForce RTX 3060 Driver 560.94.',
      "08:24:24:526 [23680] | INFO  | Recreated runtime environment on runtime 000002167ED10870 ('D:\\Games\\GTA V\\ReShade.ini').",
      "08:24:25:281 [13944] | INFO  | Successfully compiled 'D:\\Games\\GTA V\\reshade-shaders\\Shaders\\MCPassthrough.fx' in 0.002000 s.",
      "08:24:25:300 [13944] | ERROR | Failed to compile 'D:\\Games\\GTA V\\reshade-shaders\\Shaders\\Broken.fx':",
      "D:\\Games\\GTA V\\reshade-shaders\\Shaders\\Broken.fx(12, 5): error X3004: undeclared identifier 'foo'",
      '08:25:14:467 [25320] | INFO  | Registered add-on "MCPassthrough" v0.0.0.0 using ReShade API version 20.',
      '08:35:50:559 [25320] | INFO  | Exiting ...',
      '08:35:50:559 [25320] | WARN  | Add-ons are still loaded! Application may crash on exit.'
    ].join('\r\n')
    const log = parseReshadeLog(text, 5)
    expect(log).toMatchObject({ at: 5, version: '6.8.0.2155', bits: 64, module: 'ReShade64.asi', exe: 'GTA5.exe', runtime: true, api: 'Direct3D 11', gpu: 'NVIDIA GeForce RTX 3060 Driver 560.94', compiled: ['MCPassthrough.fx'], addons: [{ name: 'MCPassthrough', version: '0.0.0.0' }], exited: true })
    expect(log.failed).toEqual([{ file: 'Broken.fx', errors: ["D:\\Games\\GTA V\\reshade-shaders\\Shaders\\Broken.fx(12, 5): error X3004: undeclared identifier 'foo'"] }])
    expect(log.warnings).toEqual(['Add-ons are still loaded! Application may crash on exit.'])
  })

  it('tells presets from other .ini files and lists the effects they need', () => {
    expect(isPresetText('Techniques=MCPassthrough@MCPassthrough.fx\nTechniqueSorting=MCPassthrough@MCPassthrough.fx\n')).toBe(true)
    expect(isPresetText('[Settings]\nLanguage=en-US\n')).toBe(false)
    expect(parsePreset('Techniques=SMAA@SMAA.fx,LumaSharpen@LumaSharpen.fx,SMAA2@SMAA.fx\n').effects).toEqual(['SMAA.fx', 'LumaSharpen.fx'])
  })

  it("shows ReShadePreset.ini as active while ReShade.ini names no preset (ReShade's own default)", async () => {
    const dir = join(root, 'Presets')
    await write(join(dir, 'ReShadePreset.ini'), '')
    await write(join(dir, 'Vivid.ini'), 'Techniques=LumaSharpen@LumaSharpen.fx\n')
    const active = async (ini: string) => (await presetViews(dir, IniDoc.parse(ini), [])).filter((p) => p.active).map((p) => p.name)
    expect(await active('[INPUT]\nKeyOverlay=36,0,0,0\n')).toEqual(['ReShadePreset'])
    expect(await active('[GENERAL]\nPresetPath=.\\Vivid.ini\n')).toEqual(['Vivid'])
  })
})

describe('save slots when mods are laid out again', () => {
  it("keeps a save in the slot NexusForge gave it instead of treating its own copy as the player's", async () => {
    const saves = join(root, 'saves')
    await write(join(saves, 'SGTA50000'), 'the 100% save, deployed by NexusForge')
    await write(join(saves, 'SGTA50015'), "the player's own autosave")
    const again = await gtaSaveRoutes(['SGTA50015', 'SGTA50015.bak'], { dir: saves }, ['SGTA50000', 'SGTA50000.bak'])
    expect(again.routes).toEqual([
      { from: 'SGTA50015', target: 'saves', to: 'SGTA50000' },
      { from: 'SGTA50015.bak', target: 'saves', to: 'SGTA50000.bak' }
    ])
    // Without the record it would have taken a new slot.
    expect((await gtaSaveRoutes(['SGTA50015'], { dir: saves })).routes[0].to).toBe('SGTA50001')
  })
})
