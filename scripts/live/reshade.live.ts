// Live checks of NexusForge's ReShade support against this PC and the real download channels.
//
// 1. Every game in NexusForge's library (read from its data file), read-only: the executable ReShade would go next
//    to, the graphics API (ReShade's real compatibility list / the executable's imports), and the DLL name.
// 2. Both ReShade builds from reshade.me, checked with Windows' own Authenticode check against ReShade's certificate.
// 3. A stand-in GTA V folder (Social Club emulator and ASI loader stand-ins): the real GTA V x Minecraft files from
//    MC_PACK (the download's GTA V folder), ReShade (add-on build, because MCPassthrough.asi is an add-on) and the real Standard + SweetFX
//    shader packs, all installed, laid out and deployed with the real engine; ReShade.ini written and verified.
// 4. A copy of the installed Casualties: Unknown demo (Unity, Direct3D 11): ReShade installed and deployed, the game
//    started in a small window for a few seconds, and ReShade.log must show ReShade attached to the game.
//
// Only LIVE_DIR is written; real game folders are only read.
//   npx vitest run --config scripts/live/vitest.live.config.ts scripts/live/reshade.live.ts

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import type { Game, InstalledMod, IntegrationInfo } from '../../src/shared/types'
import type { GameIntegration, IntegrationEnv, IntegrationState, LoaderInstallHost, StagedPackage } from '../../src/main/integrations/types'
import { engineTargets } from '../../src/main/integrations/types'
import { INTEGRATIONS } from '../../src/main/integrations/registry'
import { gta5Integration } from '../../src/main/integrations/gta5'
import { unityIntegration } from '../../src/main/integrations/unity'
import { createSteamEnv } from '../../src/main/integrations/steam-apps'
import { GITHUB_HOSTS } from '../../src/main/integrations/github'
import { downloadVerified } from '../../src/main/util/download'
import { authenticode } from '../../src/main/util/signature'
import { extractArchive } from '../../src/main/mods/archive'
import { readExeVersion, readVersionStrings } from '../../src/main/library/exe-version'
import { applyDeployment } from '../../src/main/mods/deploy'
import { buildPlan } from '../../src/main/mods/plan'
import { planFilesFor } from '../../src/main/mods/routes'
import { classifyPackage } from '../../src/main/mods/classify'
import { walkFiles } from '../../src/main/util/fs'
import { detectApi, EFFECTS_ID, findReshade, renderTarget, RESHADE_ID, withReshade } from '../../src/main/reshade/core'
import { reshadeBinaries, reshadeRelease, RESHADE_THUMBPRINT } from '../../src/main/reshade/release'
import { IniDoc } from '../../src/main/reshade/ini'
import { readReshadeLog } from '../../src/main/reshade/log'
import { readPe } from '../../src/main/reshade/pe'
import { fakePe } from '../../tests/helpers'
import { local } from '../local-config.mjs'

const LIVE = resolve(process.env.LIVE_DIR ?? join(import.meta.dirname, '..', '..', '.smoke', 'live'))
const DEMO = process.env.CU_DEMO ?? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Casualties Unknown Demo'
const NF_DATA = process.env.NF_DATA ?? join(os.homedir(), 'AppData', 'Roaming', 'NexusForge')
const MC_PACK = process.env.MC_PACK ?? local.mcPack
const UA = 'NexusForge/1.8'
const say = (...a: unknown[]) => console.log('[live]', ...a)

function realEnv(work: string): IntegrationEnv {
  return {
    documents: join(work, 'Documents'),
    publicDocuments: join(work, 'Public'),
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
    verifySignature: authenticode
  }
}

function gameAt(id: string, name: string, installDir: string, exePath: string): Game {
  return { id, name, platform: 'custom', installDir, exePath, launch: { kind: 'exe', exe: exePath }, art: { capsule: [], hero: [], header: [], logo: [] }, playtimeMinutes: 0, addedAt: 0, modding: { targetDir: installDir, strategy: 'auto', sources: {} } } as Game
}

/** NexusForge's install path in small: packages are stored, classified with the shared rules, then deployed. */
function liveSetup(base: GameIntegration, game: Game, env: IntegrationEnv, work: string) {
  const integration = withReshade(base)
  const mods: InstalledMod[] = []
  const states: Record<string, IntegrationState> = {}
  let seq = 0
  const inspect = () => integration.inspect(game, env, states[game.id] ?? { loaders: {} }, mods)
  const stage = async (src: string, meta: { name: string; version?: string }) => {
    const dir = join(work, 'mods', `${meta.name.replace(/[^\w]+/g, '_')}_${++seq}`)
    if ((await fsp.stat(src)).isDirectory()) await fsp.cp(src, dir, { recursive: true })
    else await extractArchive(src, dir)
    const pkg: StagedPackage = { dir, files: await walkFiles(dir), name: meta.name }
    const info = await inspect()
    const c = await classifyPackage(pkg, { game, info, integration, env, mods })
    const prev = c.loaderId ? mods.findIndex((m) => m.loaderId === c.loaderId) : -1
    const m = { id: prev >= 0 ? mods[prev].id : `m${seq}`, gameId: game.id, name: c.name ?? meta.name, version: meta.version ?? c.version, stagingDir: dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, checks: c.checks, kind: c.kind, loaderId: c.loaderId, needsLoader: c.needsLoader, needsLoaders: c.needsLoaders, meta: c.meta, installedAt: Date.now(), updatedAt: Date.now() } as InstalledMod
    if (prev >= 0) mods[prev] = m
    else mods.push(m)
    return m
  }
  const host: LoaderInstallHost = {
    installModFile: (_g, file, meta) => stage(file, meta),
    state: (g) => states[g] ?? { loaders: {} },
    saveState: (g, s) => {
      states[g] = s
    },
    mods: () => mods
  }
  const deploy = async () => {
    const info = await inspect()
    const plan = buildPlan(await Promise.all(mods.map(async (m) => ({ id: m.id, revision: m.updatedAt, files: (await planFilesFor(m)).filter((f) => info.targets.some((t) => t.id === f.target)) }))), {})
    const report = await applyDeployment({
      gameId: game.id,
      profileId: 'live',
      targets: engineTargets(info),
      strategy: 'auto',
      plan,
      manifestPath: join(work, 'state', 'manifest.json'),
      backupDir: join(work, 'state', 'backups'),
      overwriteDir: join(work, 'state', 'overwrite'),
      configure: (m) => integration.configure!(game, info, m, mods, env, host),
      verifyExtra: (m) => integration.verify!(game, info, m, mods, env),
      loadVerifiable: integration.loadVerifiable,
      log: { info: () => {}, warn: say, error: say }
    })
    say(`deploy: ${report.outcome}: ${report.title} ${JSON.stringify(report.methods)}`)
    for (const c of report.verification?.checks ?? []) if (!/is intact|deployed file/i.test(c.label)) say(`  check ${c.ok ? 'ok ' : 'NO '} ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
    return report
  }
  const install = async (id: string) => {
    const info = await inspect()
    const loader = integration.loaders.find((l) => l.id === id)!
    const st = info.loaders.find((l) => l.id === id)
    say(`${loader.name}: ${st?.state} canInstall=${st?.canInstall} proxy=${st?.proxy ?? '-'} ${st?.detail ?? st?.blocked ?? ''}`)
    const steps: string[] = []
    await loader.install(game, info, env, host, (d) => steps.push(d))
    say(`${loader.name}: ${[...new Set(steps)].filter((x) => !/Downloading/.test(x)).join(' | ')}`)
  }
  return { integration, mods, states, inspect, stage, deploy, install, host }
}

describe('the library on this PC (read-only)', () => {
  it('every game: where ReShade would go, the API, and the DLL name', async () => {
    const data = JSON.parse(await fsp.readFile(join(NF_DATA, 'nexusforge.json'), 'utf8')) as { games: Record<string, Game>; mods: Record<string, Record<string, InstalledMod>> }
    const env = realEnv(join(LIVE, 'reshade-library'))
    const rows: string[] = []
    let gta: string | undefined
    for (const game of Object.values(data.games)) {
      if (!(await fsp.access(game.installDir).then(() => true, () => false))) {
        rows.push(`${game.name}: (folder missing)`)
        continue
      }
      let base: GameIntegration = INTEGRATIONS[INTEGRATIONS.length - 1]
      for (const i of INTEGRATIONS) if (await i.matches(game, env).catch(() => false)) {
        base = i
        break
      }
      const t = await renderTarget(game, env)
      const api = t ? await detectApi(t) : undefined
      const mods = Object.values(data.mods[game.id] ?? {})
      const info = await withReshade(base).inspect(game, env, { loaders: {} }, mods)
      const rs = info.loaders.find((l) => l.id === RESHADE_ID)!
      const copies = t ? await findReshade(t.dir) : []
      const row = `${game.name} | ${t ? `${t.exeName} (${t.machine})` : 'no exe'} | ${api?.api ?? '?'} via ${api?.source ?? '-'} | ${rs.state}${rs.canInstall ? '+install' : ''}${rs.proxy ? ` as ${rs.proxy}` : ''}${copies.length ? ` | has ${copies.map((c) => `${c.name} ${c.version} ${c.build}`).join(', ')}` : ''}${rs.blocked ? ` | ${rs.blocked.slice(0, 120)}` : ''}`
      rows.push(row)
      if (/^GTA5\.exe$/i.test(t?.exeName ?? '')) gta = row
    }
    say('\n' + rows.join('\n'))
    expect(rows.length).toBeGreaterThan(10)
    // ReShade64.asi through Script Hook V; a ReShade put in by hand as dxgi.dll is reported as never loaded.
    expect(gta).toMatch(/GTA5\.exe \(x64\) \| dxgi via compat \| (missing\+install as ReShade64\.asi|broken\+install as dxgi\.dll)/)
  })
})

describe('ReShade from reshade.me (real downloads, Windows signature check)', () => {
  it('both builds: signed by ReShade, the version the site offers, unpacked from the setup', async () => {
    const env = realEnv(join(LIVE, 'reshade-bins'))
    const rel = await reshadeRelease(env)
    say(`reshade.me: ${rel.version} ${rel.released ?? ''} ${rel.thumbprint}`)
    expect(rel.thumbprint).toBe(RESHADE_THUMBPRINT)
    for (const build of ['standard', 'addon'] as const) {
      const b = await reshadeBinaries(env, build, (d) => say(`  ${build}: ${d}`))
      for (const dll of ['ReShade32.dll', 'ReShade64.dll']) {
        const f = join(b.dir, dll)
        const vs = await readVersionStrings(f)
        const pe = await readPe(f)
        const sig = await authenticode(f)
        say(`  ${build} ${dll}: ${vs?.productName} ${vs?.version} ${pe?.machine} signed=${pe?.signed} ${sig?.status} ${sig?.thumbprint ?? ''}`)
        expect(vs?.productName).toBe('ReShade')
        expect(pe?.machine).toBe(dll.includes('64') ? 'x64' : 'x86')
        expect(pe?.signed).toBe(build === 'standard')
      }
    }
  })
})

describe('GTA V x Minecraft in a stand-in GTA V folder (real files, real downloads, real engine)', () => {
  it.skipIf(!MC_PACK)('installs only the GTA V half, ReShade with add-on support as ReShade64.asi, the shader packs, and writes ReShade.ini', async () => {
    const work = join(LIVE, 'reshade-gta')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'Grand-Theft-Auto-V-Repack', 'Grand Theft Auto V')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'GTA5.exe'), fakePe({ imports: ['kernel32.dll', 'd3d11.dll', 'dxgi.dll'] }))
    await fsp.writeFile(join(dir, 'version.dll'), 'MZ\0socialclub_emu\0')
    await fsp.writeFile(join(dir, 'dinput8.dll'), 'MZ\0Alexander Blade\0')
    // Script Hook V is already there, as in the real game folder (the mod needs it; its own check is in loaders.live.ts).
    await fsp.writeFile(join(dir, 'ScriptHookV.dll'), 'MZ\0ScriptHookV\0')
    const game = gameAt('live:gta', 'Grand Theft Auto V', join(work, 'Grand-Theft-Auto-V-Repack'), join(dir, 'GTA5.exe'))
    game.modding.targetDir = dir
    const env = realEnv(work)
    const s = liveSetup(gta5Integration, game, env, work)
    // The archive as it came: "GTA V X Minecraft/GTA V/…" (the real files) next to "Minecraft/…".
    const pack = join(work, 'download', 'GTA V X Minecraft')
    await fsp.cp(MC_PACK, join(pack, 'GTA V'), { recursive: true })
    await fsp.mkdir(join(pack, 'Minecraft'), { recursive: true })
    await fsp.writeFile(join(pack, 'Minecraft', 'passthrough-0.1.0.jar'), 'PK stand-in')
    const mod = await s.stage(join(work, 'download'), { name: 'GTA V X Minecraft' })
    say(`classified: needs=${[mod.needsLoader, ...(mod.needsLoaders ?? [])].join(',')} meta=${JSON.stringify(mod.meta)}`)
    for (const k of mod.skipped ?? []) say(`  left out ${k.path}: ${k.reason}`)
    for (const c of mod.checks ?? []) say(`  ${c.level}: ${c.message}`)
    expect(mod.meta?.reshadeAddon).toBe('1')
    expect([mod.needsLoader, ...(mod.needsLoaders ?? [])]).toEqual(['scripthookv', RESHADE_ID])
    await s.install(RESHADE_ID)
    await s.install(EFFECTS_ID)
    const report = await s.deploy()
    expect(['verified', 'deployed']).toContain(report.outcome)
    const top = (await fsp.readdir(dir)).sort()
    say(`game folder: ${top.join(', ')}`)
    expect(top).not.toContain('GTA V')
    expect(top).not.toContain('Minecraft')
    expect(top).not.toContain('dxgi.dll')
    expect(top).toEqual(expect.arrayContaining(['ReShade64.asi', 'MCPassthrough.asi', 'ReShade.ini', 'ReShadePreset.ini', 'reshade-shaders', 'dinput8.dll', 'version.dll']))
    expect(await fsp.readFile(join(dir, 'version.dll'), 'utf8')).toContain('socialclub_emu')
    expect(await fsp.readFile(join(dir, 'dinput8.dll'), 'utf8')).toContain('Alexander Blade')
    const copies = await findReshade(dir)
    expect(copies).toEqual([expect.objectContaining({ name: 'ReShade64.asi', build: 'addon' })])
    const ini = IniDoc.parse(await fsp.readFile(join(dir, 'ReShade.ini'), 'utf8'))
    say(`ReShade.ini:\n${ini.serialize()}`)
    expect(ini.get('GENERAL', 'EffectSearchPaths')).toBe('.\\reshade-shaders\\Shaders\\**')
    expect(ini.get('GENERAL', 'PresetPath')).toBe('.\\ReShadePreset.ini')
    expect(ini.get('GENERAL', 'PreprocessorDefinitions')).toMatch(/RESHADE_DEPTH_INPUT_IS_REVERSED=1/)
    expect(ini.get('INPUT', 'KeyOverlay')).toBe('36,0,0,0')
    const fx = (await walkFiles(join(dir, 'reshade-shaders'))).map((f) => f.rel)
    say(`reshade-shaders: ${fx.length} files, e.g. ${fx.filter((f) => /\.fx$/.test(f)).slice(0, 12).join(', ')}`)
    expect(fx).toEqual(expect.arrayContaining(['Shaders/MCPassthrough.fx', 'Shaders/SweetFX/SMAA.fx', 'Shaders/DisplayDepth.fx']))
    const after = await s.inspect()
    expect(after.loaders.find((l) => l.id === RESHADE_ID)).toMatchObject({ state: 'installed', proxy: 'ReShade64.asi' })
  })
})

describe('ReShade in a real game (copy of the Casualties: Unknown demo, small window, a few seconds)', () => {
  it('ReShade loads as dxgi.dll and attaches to the game (ReShade.log)', async () => {
    const work = join(LIVE, 'reshade-cu')
    const dir = join(work, 'Unity Copy')
    await fsp.rm(work, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    for (const k of ['CasualtiesUnknown_Data', 'MonoBleedingEdge', 'CasualtiesUnknown.exe', 'UnityCrashHandler64.exe', 'UnityPlayer.dll']) await fsp.cp(join(DEMO, k), join(dir, k), { recursive: true })
    const game = gameAt('live:cu', 'Unity Copy', dir, join(dir, 'CasualtiesUnknown.exe'))
    const env = realEnv(work)
    const s = liveSetup(unityIntegration, game, env, work)
    await s.install(RESHADE_ID)
    const report = await s.deploy()
    expect(['verified', 'deployed']).toContain(report.outcome)
    expect((await findReshade(dir)).map((c) => c.name)).toEqual(['dxgi.dll'])
    const logFile = join(dir, 'ReShade.log')
    await new Promise<void>((done) => {
      const child = spawn(game.exePath!, ['-screen-fullscreen', '0', '-screen-width', '640', '-screen-height', '360', '-logFile', join(dir, 'player-live.log')], { cwd: dir, stdio: 'ignore' })
      const started = Date.now()
      const t = setInterval(async () => {
        const text = await fsp.readFile(logFile, 'utf8').catch(() => '')
        if (/runtime environment/i.test(text) || Date.now() - started > 45_000) {
          clearInterval(t)
          setTimeout(() => {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            setTimeout(done, 2500)
          }, 1500)
        }
      }, 500)
    })
    const log = await readReshadeLog(logFile)
    say(`ReShade.log: version=${log?.version} module=${log?.module} runtime=${log?.runtime} api=${log?.api} gpu=${log?.gpu} compiled=${log?.compiled.length} errors=${log?.errors.length}`)
    expect(log?.module).toBe('dxgi.dll')
    expect(log?.runtime).toBe(true)
  })
})
