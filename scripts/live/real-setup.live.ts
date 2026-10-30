// Live end-to-end checks of the one-click setup with real downloads and real game files.
//
// Casualties: Unknown: a vanilla copy of the installed demo (its Steam folder is only read) gets the real
// BepInEx 5 from GitHub (SHA-256 checked) and Medical Brutalism from NexusForge's mod storage, deployed and verified;
// then the copy is started (batch mode, no window) and BepInEx's own log must show the plugin loading.
// Terraria: the real tModLoader.zip from GitHub is installed next to a stand-in GOG Terraria folder, and the
// local Terraria copy (TERRARIA_DIR) is inspected read-only (where its world goes, whether tModLoader can be set up).
//
// Env: LIVE_DIR (work folder), CU_DEMO (installed demo), TERRARIA_DIR (a local Terraria; or terrariaDir in scripts/local.json), NF_DATA (NexusForge data).

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import os from 'node:os'
import type { Game, InstalledMod } from '../../src/shared/types'
import type { IntegrationEnv, LoaderInstallHost, StagedPackage } from '../../src/main/integrations/types'
import { engineTargets } from '../../src/main/integrations/types'
import { casualtiesIntegration } from '../../src/main/integrations/casualties'
import { readBepInExLog } from '../../src/main/integrations/bepinex'
import { classifyTerraria, terrariaIntegration, tmodloaderLoader, requiredTerrariaVersion } from '../../src/main/integrations/terraria'
import { readTmod } from '../../src/main/integrations/tmod'
import { createSteamEnv } from '../../src/main/integrations/steam-apps'
import { GITHUB_HOSTS } from '../../src/main/integrations/github'
import { downloadVerified } from '../../src/main/util/download'
import { extractArchive } from '../../src/main/mods/archive'
import { readExeVersion } from '../../src/main/library/exe-version'
import { applyDeployment } from '../../src/main/mods/deploy'
import { buildPlan } from '../../src/main/mods/plan'
import { planFilesFor } from '../../src/main/mods/routes'
import { walkFiles } from '../../src/main/util/fs'
import { local as localConfig } from '../local-config.mjs'

const LIVE = resolve(process.env.LIVE_DIR ?? join(import.meta.dirname, '..', '..', '.smoke', 'live'))
const DEMO = process.env.CU_DEMO ?? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Casualties Unknown Demo'
const TERRARIA = process.env.TERRARIA_DIR ?? localConfig.terrariaDir
const NF_DATA = process.env.NF_DATA ?? join(os.homedir(), 'AppData', 'Roaming', 'NexusForge')
const UA = 'NexusForge-live-check'
const say = (...a: unknown[]) => console.log('[live]', ...a)

function realEnv(documents: string, workDir: string): IntegrationEnv {
  return {
    documents,
    workDir,
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
    download: (url, dest, opts) => downloadVerified(url, dest, { ...opts, allowedHosts: GITHUB_HOSTS, userAgent: UA }),
    async openUrl(url) {
      throw new Error(`live check does not open ${url}`)
    },
    fileVersion: readExeVersion,
    extract: (a, d) => extractArchive(a, d)
  }
}

let seq = 0
/** What NexusForge's installMod does: unpack into storage, let the integration lay it out. */
async function stage(game: Game, file: string, name: string, storage: string, env: IntegrationEnv, version?: string): Promise<InstalledMod> {
  const dir = join(storage, `${name.replace(/[^\w]+/g, '_')}_${++seq}`)
  await extractArchive(file, dir)
  const pkg: StagedPackage = { dir, files: await walkFiles(dir), name, archiveName: file.split(/[\\/]/).pop() }
  const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
  const c = await casualtiesIntegration.classify(pkg, game, info, env)
  return { id: `m${seq}`, gameId: game.id, name: c.name ?? name, version, stagingDir: dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, checks: c.checks, kind: c.kind, loaderId: c.loaderId, needsLoader: c.needsLoader, meta: c.meta, installedAt: Date.now(), updatedAt: Date.now(), sizeBytes: 0, fileCount: 0 } as InstalledMod
}

async function copyVanilla(from: string, to: string): Promise<void> {
  // Only the game's own files: whatever an earlier deployment put into the Steam folder stays behind.
  const keep = ['CasualtiesUnknown_Data', 'MonoBleedingEdge', 'CasualtiesUnknown.exe', 'UnityCrashHandler64.exe', 'UnityPlayer.dll']
  await fsp.rm(to, { recursive: true, force: true })
  await fsp.mkdir(to, { recursive: true })
  for (const k of keep) await fsp.cp(join(from, k), join(to, k), { recursive: true })
}

function startAndWait(exe: string, cwd: string, log: string, until: (text: string) => boolean, ms: number): Promise<{ text: string; ranMs: number }> {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn(exe, ['-batchmode', '-nographics', '-logFile', join(cwd, 'player-live.log')], { cwd, stdio: 'ignore', windowsHide: true })
    const timer = setInterval(async () => {
      const text = await fsp.readFile(log, 'utf8').catch(() => '')
      if (until(text) || Date.now() - started > ms) {
        clearInterval(timer)
        child.kill()
        // Unity may leave its crash handler; end the whole tree.
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        setTimeout(() => done({ text, ranMs: Date.now() - started }), 1500)
      }
    }, 1000)
  })
}

describe('Casualties: Unknown (copy of the installed demo, real BepInEx, real start)', () => {
  it('clean copy → BepInEx installed from GitHub → Medical Brutalism deployed → verified → BepInEx loads the plugin', async () => {
    const work = join(LIVE, 'casualties')
    const gameDir = join(work, 'Casualties Unknown Demo')
    await copyVanilla(DEMO, gameDir)
    const env = realEnv(join(work, 'Documents'), join(work, 'nf-work'))
    const storage = join(work, 'mods')
    const game: Game = {
      id: 'live:cu',
      name: 'Casualties: Unknown Demo',
      platform: 'custom',
      installDir: gameDir,
      exePath: join(gameDir, 'CasualtiesUnknown.exe'),
      launch: { kind: 'exe', exe: join(gameDir, 'CasualtiesUnknown.exe') },
      art: { capsule: [], hero: [], header: [], logo: [] },
      playtimeMinutes: 0,
      addedAt: 0,
      modding: { targetDir: gameDir, strategy: 'auto', sources: {} }
    } as Game
    expect(await casualtiesIntegration.matches(game, env)).toBe(true)

    const before = await casualtiesIntegration.inspect(game, env, { loaders: {} }, [])
    say('inspect:', before.name, before.support, before.distribution.label, JSON.stringify(before.loaders[0]))
    expect(before.valid).toBe(true)
    expect(before.loaders[0]).toMatchObject({ id: 'bepinex', state: 'missing', canInstall: true })

    // The loader comes through the official GitHub release, then installs like a mod (as installMod does).
    const mods: InstalledMod[] = []
    const host: LoaderInstallHost = {
      async installModFile(_g, file, meta) {
        const m = await stage(game, file, meta.name, storage, env, meta.version)
        mods.push(m)
        return m
      },
      state: () => ({ loaders: {} }),
      saveState: () => {}
    }
    const steps: string[] = []
    await casualtiesIntegration.loaders[0].install(game, before, env, host, (d) => steps.push(d))
    say('loader steps:', [...new Set(steps)].join(' | '))
    expect(steps.some((s) => /SHA-256 GitHub published/.test(s))).toBe(true)
    expect(mods[0]).toMatchObject({ kind: 'loader', loaderId: 'bepinex' })

    // A real download (read from NexusForge's downloads folder, copied before unpacking).
    const dl = (await fsp.readdir(join(NF_DATA, 'downloads'))).find((f) => /MedicalBrutalism/i.test(f))
    expect(dl, 'Medical Brutalism download in NexusForge/downloads').toBeTruthy()
    const local = join(work, 'MedicalBrutalism.zip')
    await fsp.copyFile(join(NF_DATA, 'downloads', dl!), local)
    const mb = await stage(game, local, "Alexx_'s Medical Brutalism", storage, env, '4.7.10')
    mods.push(mb)
    say('Medical Brutalism routes:', JSON.stringify(mb.routes), 'skipped:', (mb.skipped ?? []).map((s) => s.path).join(', '))
    expect(mb.needsLoader).toBe('bepinex')

    const info = await casualtiesIntegration.inspect(game, env, { loaders: {} }, mods)
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
      verifyExtra: (m) => casualtiesIntegration.verify!(game, info, m, mods, env),
      loadVerifiable: true,
      log: { info: say, warn: say, error: say }
    })
    say('deploy:', report.outcome, report.title, JSON.stringify(report.methods), report.notes.join(' '))
    for (const c of report.verification?.checks ?? []) say(`  check ${c.ok ? 'ok ' : 'NO '} ${c.label}${c.detail ? ` (${c.detail})` : ''}`)
    expect(report.outcome).toBe('verified')
    const root = (await fsp.readdir(gameDir)).sort()
    say('game folder now:', root.join(', '))
    expect(root).not.toContain('Alexx__sMedicalBrutalism.dll')
    expect(root).not.toContain('modloader')
    expect(root).not.toContain('howtomod.txt')

    // A real start of the copy, without a window. BepInEx writes LogOutput.log as it loads plugins.
    const logFile = join(gameDir, 'BepInEx', 'LogOutput.log')
    const since = Date.now()
    const run = await startAndWait(game.exePath!, gameDir, logFile, (t) => /Chainloader startup complete/.test(t), 120_000)
    const check = await readBepInExLog(gameDir, since)
    say(`start: ran ${run.ranMs} ms; loader ${check.loader}; loaded [${check.loaded.join(', ')}]; errors ${check.errors.length}`)
    say(run.text.split(/\r?\n/).filter((l) => /plugins? to load|Loading \[|Chainloader/.test(l)).join('\n'))
    expect(check.ran).toBe(true)
    expect(check.loaded.join(' ')).toMatch(/medical|brutal/i)

    // Purge: the copy is vanilla again (BepInEx's own log/config files are not NexusForge's and stay).
    const purge = await applyDeployment({
      gameId: game.id,
      profileId: 'live',
      targets: engineTargets(info),
      strategy: 'auto',
      plan: { entries: new Map(), conflicts: [], hash: 'empty' },
      manifestPath: join(work, 'state', 'manifest.json'),
      backupDir: join(work, 'state', 'backups'),
      overwriteDir: join(work, 'state', 'overwrite')
    })
    say('purge:', purge.outcome, purge.title, 'left in game folder:', (await fsp.readdir(gameDir)).join(', '))
    expect(purge.outcome).toBe('verified')
    await expect(fsp.access(join(gameDir, 'winhttp.dll'))).rejects.toThrow()
  })
})

describe('real .tmod files from the tModLoader Workshop (SteamCMD anonymous into LIVE_DIR/tml-ws)', () => {
  it('reads every real .tmod (header, SHA-1, Info dependencies) and picks the build for tModLoader 2026.08', async () => {
    const ws = join(LIVE, 'tml-ws', 'steamapps', 'workshop', 'content', '1281930')
    const items = await fsp.readdir(ws).catch(() => [] as string[])
    if (!items.length) return say('no Workshop items downloaded; skipped')
    for (const item of items) {
      const files = (await walkFiles(join(ws, item))).filter((f) => f.rel.endsWith('.tmod'))
      for (const f of files) {
        const t = await readTmod(f.abs)
        say(`${item}/${f.rel}: ${t.name} v${t.version} built for ${t.builtFor} sha1 ${t.hashOk ? 'ok' : 'BAD'} display "${t.displayName ?? ''}" needs [${(t.refs ?? []).map((r) => r.name + (r.version ? '@' + r.version : '')).join(', ')}]`)
        expect(t.hashOk).toBe(true)
        expect(t.name).toBeTruthy()
      }
      const pkg = { dir: join(ws, item), files: await walkFiles(join(ws, item)), name: item }
      const c = await classifyTerraria(pkg, '2026.08.3.0', true)
      say(`${item}: routes ${JSON.stringify(c.routes)} needs ${c.meta?.tmodNeeds ?? '-'} name "${c.name ?? ''}" checks ${c.checks.map((x) => x.level + ':' + (x.code ?? '')).join(',')}`)
      expect(c.routes.length).toBe(1)
      expect(c.checks.some((x) => x.level === 'error')).toBe(false)
    }
  })
})

describe('Terraria (real tModLoader.zip, a local Terraria copy read-only)', () => {
  it('installs the official tModLoader.zip next to a GOG-style Terraria folder (layout and checksum as published)', async () => {
    const work = join(LIVE, 'terraria')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'GOG Games', 'Terraria')
    await fsp.mkdir(join(dir, 'Content'), { recursive: true })
    await fsp.writeFile(join(dir, 'Terraria.exe'), 'stand-in')
    await fsp.writeFile(join(dir, 'goggame-1207665503.info'), JSON.stringify({ gameId: '1207665503', name: 'Terraria' }))
    const env = realEnv(join(work, 'Documents'), join(work, 'nf-work'))
    // tModLoader's start check wants an unmodified Terraria.exe (MD5); this stand-in has none, so the check is
    // simulated by putting the stand-in's MD5 into the real InstallVerifier.cs. Download and layout stay real.
    const realText = env.fetchText
    const standIn = createHash('md5').update('stand-in').digest('hex')
    env.fetchText = async (url) => {
      const text = await realText(url)
      return url.includes('InstallVerifier.cs') ? text.replace(/(gogHash\s*=\s*ToByteArray\(")[0-9a-f]{32}/i, `$1${standIn}`) : text
    }
    const states: Record<string, { loaders: Record<string, never> }> = {}
    const host = { installModFile: async () => ({}) as InstalledMod, state: (g: string) => states[g] ?? { loaders: {} }, saveState: (g: string, s: never) => (states[g] = s) } as unknown as LoaderInstallHost
    const game = { id: 'live:tr', name: 'Terraria', platform: 'custom', installDir: dir, exePath: join(dir, 'Terraria.exe'), version: '1.4.5.8', modding: { targetDir: dir, strategy: 'auto', sources: {} } } as unknown as Game
    const info = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    say('inspect:', info.distribution.label, JSON.stringify(info.loaders[0]))
    expect(info.loaders[0]).toMatchObject({ state: 'missing', canInstall: true, via: 'github' })
    const steps: string[] = []
    await tmodloaderLoader.install(game, info, env, host, (d) => steps.push(d))
    say('steps:', [...new Set(steps)].join(' | '))
    const tml = join(work, 'GOG Games', 'tModLoader')
    const files = (await fsp.readdir(tml)).sort()
    say('tModLoader folder:', files.slice(0, 30).join(', '))
    expect(files).toContain('tModLoader.dll')
    expect(files).toContain('start-tModLoader.bat')
    const after = await terrariaIntegration.inspect(game, env, host.state(game.id), [])
    say('after:', JSON.stringify(after.loaders[0]), 'launch:', JSON.stringify(await terrariaIntegration.launch!(game, after, 'modded', env)))
    expect(after.loaders[0].state).toBe('installed')
    expect(after.targets.find((t) => t.id === 'tml-mods')?.dir).toBe(join(work, 'Documents', 'My Games', 'Terraria', 'tModLoader', 'Mods'))
    expect(await requiredTerrariaVersion(env, 'v2026.08.3.0')).toBe('1.4.5.8')
    // The vanilla folder only gained nothing; tModLoader sits next to it.
    expect((await fsp.readdir(dir)).sort()).toEqual(['Content', 'Terraria.exe', 'goggame-1207665503.info'])
  })

  it("a local Terraria copy (read-only): where A Link to Terraria goes, and whether tModLoader can be set up", async () => {
    if (!TERRARIA) return say('no TERRARIA_DIR; skipped')
    if (!(await fsp.access(join(TERRARIA, 'Terraria.exe')).then(() => true, () => false))) return say(`no Terraria at ${TERRARIA} any more; skipped`)
    const env = realEnv(join(os.homedir(), 'Documents'), join(LIVE, 'nf-work'))
    const game = { id: 'live:real-tr', name: 'Terraria', platform: 'custom', installDir: TERRARIA, exePath: join(TERRARIA, 'Terraria.exe'), modding: { targetDir: TERRARIA, strategy: 'auto', sources: {} } } as unknown as Game
    const info = await terrariaIntegration.inspect(game, env, { loaders: {} }, [])
    say('real Terraria:', info.valid, info.version, info.distribution.label, '|', info.distribution.detail)
    say('loader:', info.loaders[0].state, '|', info.loaders[0].blocked)
    say('launch options:', JSON.stringify(info.launchOptions))
    expect(info.valid).toBe(true)
    const storage = join(NF_DATA, 'mods', 'custom_74b50d2fd60d')
    const folder = (await fsp.readdir(storage)).find((f) => /Link to Terraria/i.test(f))
    expect(folder).toBeTruthy()
    const dir = join(storage, folder!)
    const c = await terrariaIntegration.classify({ dir, files: await walkFiles(dir), name: 'The Legend of Zelda - A Link to Terraria' }, game, info, env)
    const mod = { id: 'zelda', stagingDir: dir, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped } as InstalledMod
    for (const f of await planFilesFor(mod)) say(`plan: ${f.rel} -> ${info.targets.find((t) => t.id === f.target)?.dir}`)
    expect(c.routes).toEqual([{ from: 'A-Link-to-Terraria-4.0.6-Journey.wld', target: 'worlds', to: 'A-Link-to-Terraria-4.0.6-Journey.wld' }])
  })
})
