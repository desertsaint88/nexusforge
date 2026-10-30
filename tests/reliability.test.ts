// Reliability: packages that must never be "deployed" as plain files, save games that must land where the game
// reads them (without replacing a save the player has), runtime evidence from loader logs mapped to mods, the
// read-only diagnostics, and the redacted report. The fixtures follow real-world cases: a repacked GTA V
// with RUNE's Social Club emulator, Zombies V (needs Script Hook V .NET API 3.7), a NexusTools mod for WATCH_DOGS,
// a ReShade preset for Sky, a NexusTools setup .exe.
//
// These are unit and integration tests on fake folders. They prove the rules and the file operations; they do not
// prove that a real game loads a mod (that needs the game: see docs/INTEGRATIONS.md, "Runtime verification").

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeployManifest, DeployStatus, Game, InstalledMod, IntegrationInfo, LaunchCheck } from '../src/shared/types'
import { classifyPackage, installerKind, reshadeInstalled } from '../src/main/mods/classify'
import { gta5Integration, gtaLaunchCheck, gtaSaveFolder, gtaSaveRoutes, parseShvdnLog, shvdnSpec, classifyGta } from '../src/main/integrations/gta5'
import { genericIntegration } from '../src/main/integrations/generic'
import { capabilitiesOf, engineTargets, type GameIntegration } from '../src/main/integrations/types'
import { clearReleaseCache } from '../src/main/integrations/github'
import { runtimeByMod, runtimeNeeds } from '../src/main/mods/runtime'
import { runChecks, wrapperFolder } from '../src/main/diagnostics/core'
import { redact } from '../src/main/diagnostics/report'
import { applyDeployment, EMPTY_PLAN } from '../src/main/mods/deploy'
import { buildPlan } from '../src/main/mods/plan'
import { planFilesFor } from '../src/main/mods/routes'
import { walkFiles } from '../src/main/util/fs'
import { fakeEnv, gameOf, write, type FakeEnv } from './helpers'

let root: string
beforeEach(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'nexusforge-reliability-'))
  clearReleaseCache()
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

async function pkg(files: Record<string, string | Buffer>, name: string, archiveName?: string) {
  const dir = join(root, 'pkg', name)
  for (const [rel, data] of Object.entries(files)) await write(join(dir, rel), data)
  return { dir, files: await walkFiles(dir), name, archiveName }
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

/** A repacked GTA V: wrapper folder, game one level down, RUNE's Social Club emulator. */
async function gtaRepack(env: FakeEnv, opts: { userId?: string; withSaveDir?: boolean; userSaves?: string[] } = {}) {
  const wrapper = join(root, 'D', 'Games', 'Grand-Theft-Auto-V-Repack')
  const dir = join(wrapper, 'Grand Theft Auto V')
  await write(join(dir, 'GTA5.exe'), 'MZ')
  await write(join(dir, 'RUNE64.dll'), 'MZ rune')
  await write(join(dir, 'version.dll'), 'MZ\0socialclub_emu\0')
  await write(join(dir, 'socialclub_emu.ini'), `[Settings]\nLanguage=en-US\nUserName=Player\nUserId=${opts.userId ?? '123456789012'}\nOffline=true\n`)
  await write(join(wrapper, 'Read_Me_Instructions.txt'), 'read me')
  await write(join(wrapper, '_CommonRedist', 'vcredist.exe'), 'MZ')
  const saveDir = join(env.publicDocuments!, 'Socialclub', 'RUNE', 'GTA V', opts.userId ?? '123456789012')
  if (opts.withSaveDir !== false) {
    await write(join(saveDir, 'pc_settings.bin'), 'settings')
    for (const s of opts.userSaves ?? []) await write(join(saveDir, s), `my own progress ${s}`)
  }
  const game = gameOf({ id: 'test:gta', name: 'Grand Theft Auto V', installDir: wrapper, exePath: join(dir, 'GTA5.exe') })
  return { game, dir, wrapper, saveDir }
}

// ---------------------------------------------------------------------------

describe('shared classification', () => {
  it('never deploys a setup program; it is kept to be run by the user', async () => {
    const env = fakeEnv(root)
    const game = gameOf({ name: 'Watch_Dogs', installDir: join(root, 'WD') })
    const p = await pkg({ 'NexusTools Installer (Recommended) 491 1.1.13.exe': 'MZ\0Inno Setup Setup Data (6.4.3)\0' }, 'NexusTools')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    expect(c.kind).toBe('installer')
    expect(c.routes).toEqual([])
    expect(c.checks[0]).toMatchObject({ level: 'error', code: 'installer' })
    expect(c.checks[0].userAction).toMatch(/Run installer/)
    expect(c.meta?.installer).toMatch(/\.exe$/)
  })

  it('leaves an ordinary program (a trainer or tool) to the game rules', async () => {
    expect(await installerKind(join(root, 'nope.exe'))).toBeUndefined()
    const env = fakeEnv(root)
    const game = gameOf({ name: 'Game', installDir: join(root, 'G') })
    const p = await pkg({ 'Trainer.exe': 'MZ\0just a program\0' }, 'Trainer')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    expect(c.kind).toBe('files')
    expect(c.routes.length).toBe(1)
  })

  it('does not guess a folder for a NexusTools mod (WATCH_DOGS)', async () => {
    const env = fakeEnv(root)
    const game = gameOf({ name: 'Watch_Dogs', installDir: join(root, 'WD') })
    const cfg = { friendlyId: 'HD_UI', name: 'HD_UI', priority: 1, packs: [], enabled: true, version: '1.0.0', minTntVersion: '1.1.0' }
    const p = await pkg({ 'hd_ui/modconfig.json': JSON.stringify(cfg), 'hd_ui/workspace/ui/fire/bin/gh_profiler.feu': 'x' }, 'HD HUD-UI')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    expect(c.kind).toBe('framework-mod')
    expect(c.routes).toEqual([])
    expect(c.checks[0]).toMatchObject({ level: 'error', code: 'needs_framework' })
    expect(c.checks[0].message).toMatch(/NexusTools 1\.1\.0\+/)
  })

  it('makes a ReShade preset need ReShade (and the shader pack it uses); NexusForge installs them', async () => {
    const env = fakeEnv(root)
    const dir = join(root, 'Sky')
    await write(join(dir, 'Sky.exe'), 'MZ')
    const game = gameOf({ name: 'Sky', installDir: dir, exePath: join(dir, 'Sky.exe') })
    const preset = 'KeyPCGI=46,1,0,0\nTechniques=AdaptiveSharpen@AdaptiveSharpen.fx\n\n[AdaptiveFog.fx]\nBloomPower=10.0\n'
    const p = await pkg({ 'Enhanced Graphics.ini': preset }, 'Enhanced Graphics')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    expect(c.kind).toBe('preset')
    expect(c.routes.length).toBe(1)
    expect(c.needsLoader).toBe('reshade')
    expect(c.needsLoaders).toContain('reshade-effects')
    expect(c.meta?.reshadeEffects).toBe('AdaptiveSharpen.fx')
    expect(c.checks.find((x) => x.code === 'needs_reshade')).toMatchObject({ level: 'info', message: expect.stringMatching(/installs ReShade from reshade\.me/) })
    await write(join(dir, 'dxgi.dll'), 'MZ\0ReShade by crosire\0')
    expect(await reshadeInstalled(game)).toBe('dxgi.dll')
    const info = infoOf(game, genericIntegration)
    info.loaders = [{ id: 'reshade', name: 'ReShade', state: 'installed', canInstall: false, canUpdate: false, canRemove: false, required: true, proxy: 'dxgi.dll' }]
    const again = await classifyPackage(p, { game, info, integration: genericIntegration, env })
    expect(again.checks.find((x) => x.code === 'needs_reshade')?.message).toMatch(/ReShade is installed for this game \(dxgi\.dll\)/)
  })

  it('does not deploy a save game when the game has no known save folder', async () => {
    const env = fakeEnv(root)
    const game = gameOf({ name: 'Some Game', installDir: join(root, 'SG') })
    const p = await pkg({ 'savegame01.sav': 'x', 'readme.txt': 'r' }, '100% save')
    const c = await classifyPackage(p, { game, info: infoOf(game, genericIntegration), integration: genericIntegration, env })
    expect(c.kind).toBe('savegame')
    expect(c.routes).toEqual([])
    expect(c.checks[0]).toMatchObject({ level: 'error', code: 'savegame' })
  })
})

// ---------------------------------------------------------------------------

describe('GTA V save games', () => {
  it("finds the save folder of a copy with RUNE's Social Club emulator", async () => {
    const env = fakeEnv(root, { publicDocuments: join(root, 'Public', 'Documents') })
    const { game, saveDir } = await gtaRepack(env)
    const s = await gtaSaveFolder(game, env)
    expect(s.folder?.dir).toBe(saveDir)
    expect(s.folder?.evidence).toMatch(/UserId=123456789012/)
  })

  it('does not guess when the folder does not exist yet, or when several profiles have saves', async () => {
    const env = fakeEnv(root, { publicDocuments: join(root, 'Public', 'Documents') })
    const { game } = await gtaRepack(env, { withSaveDir: false })
    const s = await gtaSaveFolder(game, env)
    expect(s.folder).toBeUndefined()
    expect(s.note).toMatch(/doesn't exist yet/)

    const retailDir = join(root, 'Steam', 'GTAV')
    await write(join(retailDir, 'GTA5.exe'), 'MZ')
    const retail = gameOf({ id: 'test:gta-retail', name: 'GTA V', installDir: retailDir, exePath: join(retailDir, 'GTA5.exe') })
    const profiles = join(env.documents, 'Rockstar Games', 'GTA V', 'Profiles')
    await write(join(profiles, 'AAAA1111', 'SGTA50000'), 'a')
    expect((await gtaSaveFolder(retail, env)).folder?.dir).toBe(join(profiles, 'AAAA1111'))
    await write(join(profiles, 'BBBB2222', 'pc_settings.bin'), 'b')
    const two = await gtaSaveFolder(retail, env)
    expect(two.folder).toBeUndefined()
    expect(two.ambiguous).toHaveLength(2)
  })

  it('puts a save into a free slot and never replaces a save the player has', async () => {
    const env = fakeEnv(root, { publicDocuments: join(root, 'Public', 'Documents') })
    const { saveDir } = await gtaRepack(env, { userSaves: ['SGTA50015', 'SGTA50015.bak', 'SGTA50000'] })
    const r = await gtaSaveRoutes(['SGTA50015', 'SGTA50015.bak'], { dir: saveDir })
    expect(r.routes).toEqual([
      { from: 'SGTA50015', target: 'saves', to: 'SGTA50001' },
      { from: 'SGTA50015.bak', target: 'saves', to: 'SGTA50001.bak' }
    ])
    expect(r.checks[0].message).toMatch(/slot 2.*slot 16 already has one of your saves/)
    // Every slot in use: nothing is deployed.
    for (let n = 0; n <= 15; n++) await write(join(saveDir, `SGTA500${String(n).padStart(2, '0')}`), 'mine')
    const full = await gtaSaveRoutes(['SGTA50015'], { dir: saveDir })
    expect(full.routes).toEqual([])
    expect(full.checks[0].code).toBe('save_slots_full')
  })

  it('deploys the 100% save into the save folder (not next to GTA5.exe), and a purge leaves the player\'s saves alone', async () => {
    const env = fakeEnv(root, { publicDocuments: join(root, 'Public', 'Documents') })
    const { game, dir, saveDir } = await gtaRepack(env, { userSaves: ['SGTA50015', 'SGTA50015.bak'] })
    const info = await gta5Integration.inspect(game, env, { loaders: {} }, [])
    expect(info.targets.find((t) => t.id === 'saves')).toMatchObject({ dir: saveDir, userData: true })
    const p = await pkg({ SGTA50015: 'the 100% save', 'SGTA50015.bak': 'the 100% save', 'Installation.txt': 'copy to Profiles' }, 'Grand Theft Auto V 100 percent save', '100 percent save v6-4-6.rar')
    const c = await classifyPackage(p, { game, info, integration: gta5Integration, env })
    expect(c.kind).toBe('savegame')
    const mod = { id: 'save', name: p.name, stagingDir: p.dir, rootPath: '', routes: c.routes, skipped: c.skipped, checks: c.checks } as InstalledMod
    const plan = buildPlan([{ id: 'save', revision: 1, files: await planFilesFor(mod) }], {})
    const opts = { gameId: game.id, profileId: 'p', targets: engineTargets(info), strategy: 'auto' as const, manifestPath: join(root, 'state', 'm.json'), backupDir: join(root, 'state', 'b'), overwriteDir: join(root, 'state', 'o') }
    const r = await applyDeployment({ ...opts, plan })
    expect(r.outcome).toBe('deployed')
    expect(await fsp.readFile(join(saveDir, 'SGTA50000'), 'utf8')).toBe('the 100% save')
    expect(await fsp.readFile(join(saveDir, 'SGTA50015'), 'utf8')).toBe('my own progress SGTA50015')
    await expect(fsp.access(join(dir, 'SGTA50015'))).rejects.toThrow()
    const purge = await applyDeployment({ ...opts, plan: EMPTY_PLAN })
    expect(purge.outcome).toBe('verified')
    await expect(fsp.access(join(saveDir, 'SGTA50000'))).rejects.toThrow()
    expect(await fsp.readFile(join(saveDir, 'SGTA50015'), 'utf8')).toBe('my own progress SGTA50015')
  })
})

// ---------------------------------------------------------------------------

describe('GTA V script mods and runtime evidence', () => {
  it("puts a script's data folders into scripts\\ and leaves its source code out (Zombies V)", async () => {
    const game = gameOf({ name: 'GTA V', installDir: join(root, 'gta') })
    const p = await pkg(
      {
        'ZombiesV.dll': 'MZ\0ScriptHookVDotNet3\0GTA.Native\0',
        'ZombiesV/Paleto Bay.ini': '[map]',
        'ZombiesVSounds/nuke.wav': 'RIFF',
        '(Source)/ZombiesVCore.cs': 'class Z {}',
        '(Source)/(Optional)/Extra.cs': 'class E {}'
      },
      'Zombies V'
    )
    const c = await classifyGta(p, game)
    expect(c.routes).toEqual(
      expect.arrayContaining([
        { from: 'ZombiesV.dll', target: 'scripts', to: 'ZombiesV.dll' },
        { from: 'ZombiesV', target: 'scripts', to: 'ZombiesV' },
        { from: 'ZombiesVSounds', target: 'scripts', to: 'ZombiesVSounds' }
      ])
    )
    expect(c.routes.some((r) => r.from.includes('Source'))).toBe(false)
    expect(c.skipped.find((s) => s.path === '(Source)')?.reason).toMatch(/source code/)
    expect([c.needsLoader, ...(c.needsLoaders ?? [])]).toEqual(['scripthookv', 'shvdn'])
  })

  // Lines as Script Hook V .NET 3.6.0 writes them (Zombies V built against API 3.7).
  const SHVDN_LOG = [
    '[12:35:15] [DEBUG] Loading API from .\\ScriptHookVDotNet2.dll ...',
    '[12:35:15] [DEBUG] Loading API from .\\ScriptHookVDotNet3.dll ...',
    '[12:35:15] [DEBUG] Loading scripts from D:\\Games\\GTA V\\scripts ...',
    '[12:35:15] [DEBUG] Loading assembly ZombiesV.dll ...',
    '[12:35:15] [WARNING] Unable to resolve API version 3.7.0.',
    '[12:35:15] [WARNING] Unable to resolve API version 3.7.0.',
    '[12:35:16] [DEBUG] Loading assembly Simple Trainer.dll ...',
    "[12:35:16] [INFO] Instantiating script 'SimpleTrainer.Main' in script domain 'ScriptDomain_1' ...",
    '[12:35:16] [DEBUG] Loading assembly Silent.dll ...'
  ].join('\r\n')

  it('reads per script which loaded and which failed, and why', () => {
    const files = parseShvdnLog(SHVDN_LOG)
    expect(files.find((f) => f.file === 'ZombiesV.dll')).toMatchObject({ ok: false, needs: { loaderId: 'shvdn', version: '3.7.0' } })
    expect(files.find((f) => f.file === 'ZombiesV.dll')!.evidence).toHaveLength(2)
    expect(files.find((f) => f.file === 'Simple Trainer.dll')).toMatchObject({ ok: true })
    // No line says whether it ran: no claim either way.
    expect(files.find((f) => f.file === 'Silent.dll')).toBeUndefined()
  })

  it('maps the log to the mods that own the files; old evidence does not count', async () => {
    const dir = join(root, 'gta')
    await write(join(dir, 'ScriptHookV.log'), "[12:34:26] INIT: Registering script 'ScriptHookVDotNet.asi' (0x7FF)\n")
    await write(join(dir, 'ScriptHookVDotNet.log'), SHVDN_LOG)
    const check = await gtaLaunchCheck(dir, 0)
    expect(check.ran).toBe(true)
    expect(check.loaded).toContain('ScriptHookVDotNet.asi')
    const manifest = {
      version: 2,
      gameId: 'g',
      profileId: 'p',
      targets: { game: dir, scripts: join(dir, 'scripts') },
      strategy: 'auto',
      deployedAt: 1,
      planHash: 'h',
      createdDirs: [],
      entries: [
        { target: 'scripts', rel: 'ZombiesV.dll', modId: 'zombies', source: 'x', method: 'copy', size: 1, mtimeMs: 1 },
        { target: 'scripts', rel: 'Simple Trainer.dll', modId: 'trainer', source: 'x', method: 'copy', size: 1, mtimeMs: 1 },
        { target: 'game', rel: 'ScriptHookVDotNet.asi', modId: 'shvdn', source: 'x', method: 'copy', size: 1, mtimeMs: 1 },
        { target: 'scripts', rel: 'Other.dll', modId: 'other', source: 'x', method: 'copy', size: 1, mtimeMs: 1 }
      ]
    } as DeployManifest
    const mods = [
      { id: 'zombies', updatedAt: 0 },
      { id: 'trainer', updatedAt: 0 },
      { id: 'shvdn', updatedAt: 0 },
      { id: 'other', updatedAt: 0 }
    ] as InstalledMod[]
    const rt = runtimeByMod(manifest, mods, check)
    expect(rt.zombies).toMatchObject({ state: 'failed', needs: { loaderId: 'shvdn', version: '3.7.0' } })
    expect(rt.trainer.state).toBe('loaded')
    expect(rt.shvdn.state).toBe('loaded')
    expect(rt.other.state).toBe('unknown')
    expect(runtimeNeeds(check)).toEqual({ shvdn: '3.7.0' })
    // A mod updated after that start: the old log says nothing about it.
    const later = runtimeByMod(manifest, mods.map((m) => (m.id === 'zombies' ? { ...m, updatedAt: (check.at ?? 0) + 1000 } : m)), check)
    expect(later.zombies.state).toBe('unknown')
  })

  it('offers the official Script Hook V .NET nightly only when a script needs a newer API', async () => {
    const env = fakeEnv(root)
    const asset = (name: string) => ({ name, size: 3, browser_download_url: `https://github.com/x/${name}`, digest: `sha256:${createHash('sha256').update(name).digest('hex')}` })
    env.fetchJson = (async (url: string) => {
      if (url.includes('scripthookvdotnet-nightly')) return [{ tag_name: 'v3.7.0-nightly.195', name: 'n', prerelease: false, draft: false, published_at: '2026-10-24T00:00:00Z', html_url: 'https://github.com/n', assets: [asset('ScriptHookVDotNet-v3.7.0-nightly.195.zip')] }]
      if (url.includes('scripthookvdotnet/scripthookvdotnet/')) return [{ tag_name: 'v3.6.0', name: 's', prerelease: false, draft: false, published_at: '2022-01-01T00:00:00Z', html_url: 'https://github.com/s', assets: [asset('ScriptHookVDotNet.zip')] }]
      throw new Error(`offline: ${url}`)
    }) as never
    const game = gameOf({ name: 'GTA V', installDir: join(root, 'gta'), exePath: join(root, 'gta', 'GTA5.exe') })
    const rt = { arch: 'x64' as const }
    const stable = await shvdnSpec.resolve!(env, { game, rt, state: { loaders: {} } })
    expect(stable.version).toBe('3.6.0')
    const needs: LaunchCheck = { ran: true, loaded: [], errors: [], files: [{ file: 'ZombiesV.dll', ok: false, evidence: [], needs: { loaderId: 'shvdn', version: '3.7.0' } }] }
    const nightly = await shvdnSpec.resolve!(env, { game, rt, state: { loaders: {}, lastLaunch: needs } })
    expect(nightly).toMatchObject({ version: '3.7.0-nightly.195', prerelease: true })
    expect(nightly.sha256).toMatch(/^[0-9a-f]{64}$/)
    const tooNew: LaunchCheck = { ...needs, files: [{ ...needs.files![0], needs: { loaderId: 'shvdn', version: '3.9.0' } }] }
    await expect(shvdnSpec.resolve!(env, { game, rt, state: { loaders: {}, lastLaunch: tooNew } })).rejects.toThrow(/No Script Hook V .NET build supports API 3\.9\.0/)
  })
})

// ---------------------------------------------------------------------------

describe('diagnostics (read-only)', () => {
  it('recognizes a repack wrapper folder, but not games that keep their .exe in bin\\', async () => {
    const env = fakeEnv(root, { publicDocuments: join(root, 'Public', 'Documents') })
    const { game, dir } = await gtaRepack(env)
    expect(await wrapperFolder(game)).toBe(dir)
    const wd = join(root, 'Watch Dogs')
    await write(join(wd, 'bin', 'watch_dogs.exe'), 'MZ')
    await write(join(wd, 'data_win64', 'patch.dat'), 'x')
    expect(await wrapperFolder(gameOf({ name: 'Watch_Dogs', installDir: wd, exePath: join(wd, 'bin', 'watch_dogs.exe') }))).toBeUndefined()
  })

  function statusOf(manifest: DeployManifest | undefined, mods: InstalledMod[], check?: LaunchCheck, extra: Partial<DeployStatus> = {}): DeployStatus {
    return { gameId: 'g', deployed: Boolean(manifest), inSync: true, fileCount: manifest?.entries.length ?? 0, methods: { symlink: 0, hardlink: 0, copy: 0 }, targets: [], perMod: {}, runtime: runtimeByMod(manifest, mods, check), ...extra }
  }

  it('finds missing deployed files, undeployable packages, loading failures, and changes nothing', async () => {
    const env = fakeEnv(root)
    const gameDir = join(root, 'G')
    await write(join(gameDir, 'Game.exe'), 'MZ')
    await write(join(gameDir, 'present.dll'), 'abc')
    const game = gameOf({ name: 'Game', installDir: gameDir, exePath: join(gameDir, 'Game.exe') })
    const integration: GameIntegration = { ...genericIntegration, id: 'test', checkLaunch: async () => ({ ran: false, loaded: [], errors: [] }) }
    const info = infoOf(game, integration)
    info.loaders = [{ id: 'shvdn', name: 'Script Hook V .NET', state: 'outdated', version: '3.6.0', latest: '3.7.0-nightly.195', canInstall: false, canUpdate: true, canRemove: true, required: true, warning: 'needs API 3.7.0 (log)' }]
    const manifest = {
      version: 2,
      gameId: game.id,
      profileId: 'p',
      targets: { game: gameDir },
      strategy: 'auto',
      deployedAt: 1,
      planHash: 'h',
      createdDirs: [],
      entries: [
        { target: 'game', rel: 'present.dll', modId: 'a', source: 'x', method: 'copy', size: 3, mtimeMs: 1 },
        { target: 'game', rel: 'gone.dll', modId: 'a', source: 'x', method: 'copy', size: 3, mtimeMs: 1 },
        { target: 'game', rel: 'ZombiesV.dll', modId: 'z', source: 'x', method: 'copy', size: 3, mtimeMs: 1 }
      ]
    } as DeployManifest
    await write(join(gameDir, 'ZombiesV.dll'), 'abc')
    const staging = join(root, 'staging')
    await fsp.mkdir(staging, { recursive: true })
    const mods = [
      { id: 'a', name: 'Mod A', stagingDir: staging, updatedAt: 0, needsLoader: undefined },
      { id: 'z', name: 'Zombies V', stagingDir: staging, updatedAt: 0, needsLoader: 'shvdn' },
      { id: 'i', name: 'NexusTools', stagingDir: staging, updatedAt: 0, kind: 'installer', meta: { installer: 'setup.exe' }, checks: [{ level: 'error', code: 'installer', message: 'a setup program', userAction: 'Run it' }] }
    ] as unknown as InstalledMod[]
    const check: LaunchCheck = { ran: true, loaded: [], errors: [], at: 10, logFile: 'ScriptHookVDotNet.log', files: [{ file: 'ZombiesV.dll', ok: false, evidence: ['Unable to resolve API version 3.7.0.'], needs: { loaderId: 'shvdn', version: '3.7.0' } }] }
    const before = await walkFiles(gameDir)
    const { findings, rows } = await runChecks({ game, info, integration, mods, enabled: new Set(['a', 'z', 'i']), manifest, status: statusOf(manifest, mods, check), lastLaunch: check, verifyChecks: [], env, state: { loaders: {} } })
    const codes = findings.map((f) => f.code)
    expect(codes).toContain('NF-DEP-004')
    expect(findings.find((f) => f.code === 'NF-DEP-004')!.evidence.join('\n')).toMatch(/gone\.dll: missing/)
    const pkgFinding = findings.find((f) => f.code === 'NF-PKG-001')!
    expect(pkgFinding.fixes[0]).toMatchObject({ id: 'run-installer', consequential: true })
    expect(pkgFinding.userAction).toBe('Run it')
    const run = findings.find((f) => f.code === 'NF-RUN-001')!
    expect(run).toMatchObject({ severity: 'error', confidence: 'confirmed', modIds: ['z'] })
    expect(run.fixes[0]).toMatchObject({ id: 'install-loader', params: { loaderId: 'shvdn' } })
    expect(rows.find((r) => r.id === 'z')!.runtime.state).toBe('failed')
    // Errors first.
    expect(findings[0].severity).toBe('error')
    // Read-only: the game folder is exactly as before.
    expect(await walkFiles(gameDir)).toEqual(before)
  })

  it('says plainly when a game has no runtime evidence at all', async () => {
    const env = fakeEnv(root)
    const gameDir = join(root, 'G2')
    await write(join(gameDir, 'a.txt'), 'abc')
    const game = gameOf({ name: 'Plain', installDir: gameDir })
    const info = infoOf(game, genericIntegration)
    const manifest = { version: 2, gameId: game.id, profileId: 'p', targets: { game: gameDir }, strategy: 'auto', deployedAt: 1, planHash: 'h', createdDirs: [], entries: [{ target: 'game', rel: 'a.txt', modId: 'a', source: 'x', method: 'copy', size: 3, mtimeMs: 1 }] } as DeployManifest
    const mods = [{ id: 'a', name: 'A', stagingDir: root, updatedAt: 0 }] as InstalledMod[]
    const { findings, rows } = await runChecks({ game, info, integration: genericIntegration, mods, enabled: new Set(['a']), manifest, status: statusOf(manifest, mods), verifyChecks: [], env, state: { loaders: {} } })
    expect(findings.map((f) => f.code)).toEqual(['NF-RUN-003'])
    expect(rows[0].runtime.state).toBe('unknown')
    expect(capabilitiesOf(genericIntegration)).toMatchObject({ runtimeLog: false, verifyLoad: false, verifyFiles: true, classify: false })
    expect(capabilitiesOf(gta5Integration)).toMatchObject({ runtimeLog: true, saves: true, diagnose: true, loaders: true })
  })

  it('takes personal details out of the exported report', () => {
    const text = [
      'C:\\Users\\alex\\AppData\\Roaming\\NexusForge\\mods\\custom_b53d18058cc8\\x',
      'user alex played',
      'mail me at someone@example.com',
      'key a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0',
      'sha256 7507a56ede91fdbaae0cf90195a81eb31e9f5ea82f586a6e88ca9bf2928eae33'
    ].join('\n')
    const out = redact(text, { home: 'C:\\Users\\alex', user: 'alex' })
    expect(out).toContain('%USERPROFILE%\\AppData\\Roaming\\NexusForge\\mods\\custom_b53d18058cc8\\x')
    expect(out).toContain('user <user> played')
    expect(out).toContain('<e-mail>')
    expect(out).toContain('key <redacted>')
    expect(out).toContain('7507a56ede91fdbaae0cf90195a81eb31e9f5ea82f586a6e88ca9bf2928eae33')
    expect(out).not.toMatch(/alex/i)
  })
})
