// Live checks of the one-click mod loaders against this PC and the real release channels.
//
// 1. Every game in NexusForge's library (read from its data file) is inspected read-only: which integration
//    handles it, which loaders it offers, and which DLL names are taken by files that came with the game.
// 2. MelonLoader: the real MelonLoader.x64.zip from GitHub (SHA-256 checked) into a copy of the installed
//    Casualties: Unknown demo, deployed and verified, then a real start (batch mode) must write MelonLoader's log.
// 3. UE4SS, Script Hook V (dev-c.com) and the Cyberpunk frameworks: real downloads laid out in stand-in game
//    folders and deployed with the real engine (no start; the games are too big to copy).
//
// Only LIVE_DIR is written; real game folders are only read.
//   npx vitest run --config scripts/live/vitest.live.config.ts scripts/live/loaders.live.ts

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import type { Game, InstalledMod, IntegrationInfo } from '../../src/shared/types'
import type { GameIntegration, IntegrationEnv, LoaderAdapter, LoaderInstallHost, StagedPackage } from '../../src/main/integrations/types'
import { engineTargets } from '../../src/main/integrations/types'
import { INTEGRATIONS } from '../../src/main/integrations/registry'
import { unityIntegration, readMelonLog } from '../../src/main/integrations/unity'
import { unrealIntegration } from '../../src/main/integrations/unreal'
import { gta5Integration } from '../../src/main/integrations/gta5'
import { cyberpunkIntegration } from '../../src/main/integrations/cyberpunk'
import { createSteamEnv } from '../../src/main/integrations/steam-apps'
import { GITHUB_HOSTS } from '../../src/main/integrations/github'
import { downloadVerified } from '../../src/main/util/download'
import { extractArchive } from '../../src/main/mods/archive'
import { readExeVersion } from '../../src/main/library/exe-version'
import { applyDeployment } from '../../src/main/mods/deploy'
import { buildPlan } from '../../src/main/mods/plan'
import { planFilesFor } from '../../src/main/mods/routes'
import { walkFiles } from '../../src/main/util/fs'

const LIVE = resolve(process.env.LIVE_DIR ?? join(import.meta.dirname, '..', '..', '.smoke', 'live'))
const DEMO = process.env.CU_DEMO ?? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Casualties Unknown Demo'
const NF_DATA = process.env.NF_DATA ?? join(os.homedir(), 'AppData', 'Roaming', 'NexusForge')
const UA = 'NexusForge/1.0'
const say = (...a: unknown[]) => console.log('[live]', ...a)

function realEnv(work: string, overrides: Partial<IntegrationEnv> = {}): IntegrationEnv {
  return {
    documents: join(work, 'Documents'),
    workDir: join(work, 'nf-work'),
    steam: createSteamEnv(),
    log: { info: say, warn: say, error: say },
    async fetchJson<T>(url: string) {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } })
      if (!r.ok) throw new Error(`${url}: ${r.status}`)
      return (await r.json()) as T
    },
    async fetchText(url: string) {
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!r.ok) throw new Error(`${url}: ${r.status}`)
      return r.text()
    },
    download: (url, dest, opts) => downloadVerified(url, dest, { ...opts, allowedHosts: opts?.allowedHosts ?? GITHUB_HOSTS, userAgent: UA }),
    async openUrl(url) {
      throw new Error(`live check does not open ${url}`)
    },
    fileVersion: readExeVersion,
    extract: (a, d) => extractArchive(a, d),
    ...overrides
  }
}

function gameAt(id: string, name: string, installDir: string, exePath: string): Game {
  return { id, name, platform: 'custom', installDir, exePath, launch: { kind: 'exe', exe: exePath }, art: { capsule: [], hero: [], header: [], logo: [] }, playtimeMinutes: 0, addedAt: 0, modding: { targetDir: installDir, strategy: 'auto', sources: {} } } as Game
}

/** Installs loaders the way NexusForge does (download -> unpack into storage -> the integration lays it out), then deploys. */
async function installAndDeploy(integration: GameIntegration, game: Game, env: IntegrationEnv, work: string, loaders: LoaderAdapter[], extra: StagedPackage[] = []) {
  const storage = join(work, 'mods')
  const mods: InstalledMod[] = []
  let seq = 0
  const stage = async (pkg: StagedPackage, info: IntegrationInfo, meta: { name: string; version?: string }) => {
    const c = await integration.classify(pkg, game, info, env)
    const m = { id: `m${++seq}`, gameId: game.id, name: meta.name, version: meta.version, stagingDir: pkg.dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, checks: c.checks, kind: c.kind, loaderId: c.loaderId, needsLoader: c.needsLoader, needsLoaders: c.needsLoaders } as InstalledMod
    mods.push(m)
    return m
  }
  const host: LoaderInstallHost = {
    async installModFile(_g, file, meta) {
      const dir = join(storage, `${meta.name.replace(/[^\w]+/g, '_')}_${seq + 1}`)
      await extractArchive(file, dir)
      const info = await integration.inspect(game, env, { loaders: {} }, mods)
      return stage({ dir, files: await walkFiles(dir), name: meta.name, source: meta.source }, info, meta)
    },
    state: () => ({ loaders: {} }),
    saveState: () => {}
  }
  for (const l of loaders) {
    const info = await integration.inspect(game, env, { loaders: {} }, mods)
    const st = info.loaders.find((x) => x.id === l.id)
    say(`${l.name}: before ${st?.state} canInstall=${st?.canInstall} latest=${st?.latest} proxy=${st?.proxy ?? '-'} ${st?.blocked ?? ''}`)
    const steps: string[] = []
    await l.install(game, info, env, host, (d) => steps.push(d))
    say(`${l.name}: ${[...new Set(steps)].filter((s) => !/Downloading/.test(s)).join(' | ')}`)
  }
  for (const p of extra) await stage(p, await integration.inspect(game, env, { loaders: {} }, mods), { name: p.name })
  const info = await integration.inspect(game, env, { loaders: {} }, mods)
  const plan = buildPlan(await Promise.all(mods.map(async (m) => ({ id: m.id, revision: 1, files: await planFilesFor(m) }))), {})
  const report = await applyDeployment({
    gameId: game.id,
    profileId: 'live',
    targets: engineTargets(info),
    strategy: 'auto',
    plan,
    manifestPath: join(work, 'state', 'manifest.json'),
    backupDir: join(work, 'state', 'backups'),
    overwriteDir: join(work, 'state', 'overwrite'),
    configure: integration.configure ? (m) => integration.configure!(game, info, m, mods, env, { ...host, state: () => ({ loaders: {} }) }) : undefined,
    verifyExtra: integration.verify ? (m) => integration.verify!(game, info, m, mods, env) : undefined,
    loadVerifiable: integration.loadVerifiable,
    log: { info: () => {}, warn: say, error: say }
  })
  say(`deploy: ${report.outcome} — ${report.title} ${JSON.stringify(report.methods)}`)
  for (const c of report.verification?.checks ?? []) if (!/is intact|deployed file/i.test(c.label)) say(`  check ${c.ok ? 'ok ' : 'NO '} ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
  const after = await integration.inspect(game, env, { loaders: {} }, mods)
  return { report, mods, after }
}

describe('the library on this PC (read-only)', () => {
  it('every game: integration, loaders, and DLL names taken by files that came with the game', async () => {
    const data = JSON.parse(await fsp.readFile(join(NF_DATA, 'nexusforge.json'), 'utf8')) as { games: Record<string, Game> }
    const env = realEnv(join(LIVE, 'library'))
    const rows: string[] = []
    for (const game of Object.values(data.games)) {
      if (!(await fsp.access(game.installDir).then(() => true, () => false))) {
        rows.push(`${game.name}: (folder missing)`)
        continue
      }
      let integration: GameIntegration | undefined
      for (const i of INTEGRATIONS) if (await i.matches(game, env).catch(() => false)) {
        integration = i
        break
      }
      const info = await integration!.inspect(game, env, { loaders: {} }, [])
      const loaders = info.loaders.map((l) => `${l.name}=${l.state}${l.canInstall ? '+install' : ''}${l.proxy ? `@${l.proxy}` : ''}${l.blocked ? ` [blocked: ${l.blocked.slice(0, 110)}]` : ''}`).join('; ')
      rows.push(`${game.name} -> ${integration!.id} "${info.name}" ${info.distribution.label}${info.version ? ` ${info.version}` : ''} | ${loaders || 'no loaders'}${info.warnings.length ? ` | warn: ${info.warnings.map((w) => w.slice(0, 90)).join(' / ')}` : ''}`)
    }
    say('\n' + rows.join('\n'))
    expect(rows.length).toBeGreaterThan(10)
  })
})

describe('MelonLoader (real GitHub release, copy of the installed demo, real start)', () => {
  it('installs through version.dll, deploys, verifies, and MelonLoader writes its log when the game starts', async () => {
    const work = join(LIVE, 'melon')
    const dir = join(work, 'Unity Copy')
    await fsp.rm(work, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    for (const k of ['CasualtiesUnknown_Data', 'MonoBleedingEdge', 'CasualtiesUnknown.exe', 'UnityCrashHandler64.exe', 'UnityPlayer.dll']) await fsp.cp(join(DEMO, k), join(dir, k), { recursive: true })
    const game = gameAt('live:melon', 'Unity Copy', dir, join(dir, 'CasualtiesUnknown.exe'))
    const env = realEnv(work)
    const { report, after } = await installAndDeploy(unityIntegration, game, env, work, [unityIntegration.loaders.find((l) => l.id === 'melonloader')!])
    expect(report.outcome).toBe('verified')
    expect(after.loaders.find((l) => l.id === 'melonloader')?.state).toBe('installed')
    const since = Date.now()
    const log = join(dir, 'MelonLoader', 'Latest.log')
    await new Promise<void>((done) => {
      const child = spawn(game.exePath!, ['-batchmode', '-nographics', '-logFile', join(dir, 'player-live.log')], { cwd: dir, stdio: 'ignore', windowsHide: true })
      const started = Date.now()
      const t = setInterval(async () => {
        const text = await fsp.readFile(log, 'utf8').catch(() => '')
        if (/Loaded|Melon|Support Module/i.test(text) && /Mods? Loaded|0 Mods|Plugins? Loaded|Initializ/i.test(text) || Date.now() - started > 120_000) {
          clearInterval(t)
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          setTimeout(done, 2000)
        }
      }, 1000)
    })
    const check = await readMelonLog(dir, since)
    const text = await fsp.readFile(log, 'utf8').catch(() => '')
    say(`start: ran=${check.ran} loader=${check.loader} errors=${check.errors.length}\n${text.split(/\r?\n/).slice(0, 25).join('\n')}`)
    expect(check.ran).toBe(true)
    expect(check.loader).toMatch(/MelonLoader/)
  })
})

describe('UE4SS, Script Hook V and the Cyberpunk frameworks (real downloads into stand-in folders)', () => {
  it('UE4SS experimental build for a UE 5.5 game, next to OnlineFix-style files', async () => {
    const work = join(LIVE, 'ue4ss')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'Backrooms-Repack')
    const bin = join(dir, 'BET', 'Binaries', 'Win64')
    await fsp.mkdir(bin, { recursive: true })
    await fsp.mkdir(join(dir, 'BET', 'Content', 'Paks'), { recursive: true })
    await fsp.writeFile(join(bin, 'BETGameSteam-Win64-Shipping.exe'), 'MZ')
    await fsp.writeFile(join(dir, 'BET.exe'), 'MZ')
    const env = realEnv(work, { fileVersion: async (f) => (/Shipping\.exe$/i.test(f) ? '++UE5+Release-5.5-CL-40574608' : undefined) })
    const lua = join(work, 'pkg', 'HelloLua')
    await fsp.mkdir(join(lua, 'HelloLua', 'Scripts'), { recursive: true })
    await fsp.writeFile(join(lua, 'HelloLua', 'Scripts', 'main.lua'), 'print("hello from NexusForge")\n')
    const game = gameAt('live:ue', 'Backrooms stand-in', dir, join(dir, 'BET.exe'))
    const { report, after } = await installAndDeploy(unrealIntegration, game, env, work, unrealIntegration.loaders, [{ dir: lua, files: await walkFiles(lua), name: 'HelloLua' }])
    expect(report.outcome).toBe('verified')
    expect(after.loaders[0].state).toBe('installed')
    expect(await fsp.access(join(bin, 'ue4ss', 'UE4SS.dll')).then(() => true, () => false)).toBe(true)
    expect(await fsp.access(join(bin, 'ue4ss', 'Mods', 'HelloLua', 'enabled.txt')).then(() => true, () => false)).toBe(true)
  })

  it('Script Hook V from dev-c.com for the version of the GTA5.exe on this PC', async () => {
    const work = join(LIVE, 'shv')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'GTA V stand-in')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'GTA5.exe'), 'MZ')
    const data = JSON.parse(await fsp.readFile(join(NF_DATA, 'nexusforge.json'), 'utf8')) as { games: Record<string, Game> }
    const real = Object.values(data.games).find((g) => /GTA5\.exe$/i.test(g.exePath ?? ''))
    const version = real?.exePath ? await readExeVersion(real.exePath) : undefined
    say('GTA5.exe on this PC:', real?.exePath, version)
    const env = realEnv(work, { fileVersion: async (f) => (/GTA5\.exe$/i.test(f) ? version : undefined) })
    const { report, after } = await installAndDeploy(gta5Integration, gameAt('live:gta', 'GTA V stand-in', dir, join(dir, 'GTA5.exe')), env, work, [gta5Integration.loaders[0]])
    expect(report.outcome).toBe('verified')
    expect(after.loaders[0].state).toBe('installed')
    const files = (await fsp.readdir(dir)).sort()
    say('stand-in folder:', files.join(', '))
    expect(files).toEqual(expect.arrayContaining(['ScriptHookV.dll', 'dinput8.dll', 'args.txt']))
    expect(files).not.toContain('NativeTrainer.asi')
  })

  it('Cyber Engine Tweaks, RED4ext, redscript and ArchiveXL from GitHub in a stand-in Cyberpunk folder', async () => {
    const work = join(LIVE, 'cp2077')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'Cyb2077')
    await fsp.mkdir(join(dir, 'bin', 'x64'), { recursive: true })
    await fsp.writeFile(join(dir, 'bin', 'x64', 'Cyberpunk2077.exe'), 'MZ')
    await fsp.writeFile(join(dir, 'bin', 'x64', 'steam_emu.ini'), '[Settings]')
    const env = realEnv(work)
    const ids = ['cet', 'red4ext', 'redscript', 'archivexl']
    const { report, after } = await installAndDeploy(cyberpunkIntegration, gameAt('live:cp', 'Cyberpunk stand-in', dir, join(dir, 'bin', 'x64', 'Cyberpunk2077.exe')), env, work, cyberpunkIntegration.loaders.filter((l) => ids.includes(l.id)))
    expect(report.outcome).toBe('verified')
    for (const id of ids) expect(after.loaders.find((l) => l.id === id)?.state, id).toBe('installed')
    expect(await fsp.readFile(join(dir, 'bin', 'x64', 'steam_emu.ini'), 'utf8')).toBe('[Settings]')
  })
})
