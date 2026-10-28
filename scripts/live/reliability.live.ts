// Live checks of the reliability work against this PC (real logs, real packages, real release channel).
//
// Read-only on the real game folders and NexusForge storage; only LIVE_DIR is written.
//   npx vitest run --config scripts/live/vitest.live.config.ts scripts/live/reliability.live.ts
//
// What this proves: the rules read the real files the way the unit tests assume (log formats, save folder of the
// installed GTA V copy, the NexusTools installer, the Zombies V package), and the official Script Hook V .NET
// nightly downloads with a matching SHA-256 and lays out correctly. What it does not prove: that GTA V then loads
// Zombies V. That needs a start of the real game after the update (ScriptHookVDotNet.log, see docs/INTEGRATIONS.md).

import { describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import os from 'node:os'
import type { Game, InstalledMod, LaunchCheck } from '../../src/shared/types'
import type { IntegrationEnv } from '../../src/main/integrations/types'
import { engineTargets } from '../../src/main/integrations/types'
import { createSteamEnv } from '../../src/main/integrations/steam-apps'
import { GITHUB_HOSTS } from '../../src/main/integrations/github'
import { gta5Integration, gtaLaunchCheck, gtaSaveFolder, shvdnLoader } from '../../src/main/integrations/gta5'
import { readBepInExLog } from '../../src/main/integrations/bepinex'
import { genericIntegration } from '../../src/main/integrations/generic'
import { classifyPackage } from '../../src/main/mods/classify'
import { runtimeByMod } from '../../src/main/mods/runtime'
import { downloadVerified } from '../../src/main/util/download'
import { extractArchive } from '../../src/main/mods/archive'
import { readExeVersion } from '../../src/main/library/exe-version'
import { applyDeployment, readManifest } from '../../src/main/mods/deploy'
import { buildPlan } from '../../src/main/mods/plan'
import { planFilesFor } from '../../src/main/mods/routes'
import { walkFiles } from '../../src/main/util/fs'

const LIVE = resolve(process.env.LIVE_DIR ?? join(import.meta.dirname, '..', '..', '.smoke', 'live'))
const NF_DATA = process.env.NF_DATA ?? join(os.homedir(), 'AppData', 'Roaming', 'NexusForge')
const DEMO = process.env.CU_DEMO ?? 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Casualties Unknown Demo'
const UA = 'NexusForge/1.0'
const say = (...a: unknown[]) => console.log('[live]', ...a)

function realEnv(work: string, over: Partial<IntegrationEnv> = {}): IntegrationEnv {
  return {
    documents: join(os.homedir(), 'Documents'),
    publicDocuments: join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Documents'),
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
    ...over
  }
}

interface Data {
  games: Record<string, Game>
  mods: Record<string, Record<string, InstalledMod>>
}
async function data(): Promise<Data> {
  return JSON.parse(await fsp.readFile(join(NF_DATA, 'nexusforge.json'), 'utf8')) as Data
}

describe('this PC, read-only', () => {
  it("GTA V: the copy's save folder, and what the loader logs say per script", async () => {
    const d = await data()
    const gta = Object.values(d.games).find((g) => /GTA5\.exe$/i.test(g.exePath ?? ''))
    if (!gta) return say('no GTA V in the library: skipped')
    const env = realEnv(join(LIVE, 'rel'))
    const s = await gtaSaveFolder(gta, env)
    say('save folder:', s.folder?.dir ?? s.note, s.folder?.evidence ?? '')
    const check = await gtaLaunchCheck(dirname(gta.exePath!), 0)
    say(`log ${check.logFile} at ${check.at ? new Date(check.at).toISOString() : '-'}:`)
    for (const f of check.files ?? []) say(`  ${f.file}: ${f.ok ? 'loaded' : 'FAILED'}${f.needs ? ` (needs ${f.needs.loaderId} ${f.needs.version})` : ''}`)
    expect(check.ran).toBe(true)
    const manifest = await readManifest(join(NF_DATA, 'deployments', `${gta.id.replace(/[:]/g, '_')}.json`))
    if (manifest) {
      const rt = runtimeByMod(manifest, Object.values(d.mods[gta.id] ?? {}), check)
      for (const [id, r] of Object.entries(rt)) say(`  mod ${d.mods[gta.id]?.[id]?.name ?? id}: ${r.state}${r.needs ? ` needs ${r.needs.loaderId} ${r.needs.version}` : ''}`)
    }
  })

  it('Casualties: Unknown: BepInEx says per plugin what it loaded', async () => {
    const check: LaunchCheck = await readBepInExLog(DEMO, 0)
    if (!check.ran) return say('no BepInEx log: skipped')
    for (const f of check.files ?? []) say(`  ${f.file}: ${f.ok ? 'loaded' : 'FAILED'}`)
    expect((check.files ?? []).length).toBeGreaterThan(0)
  })

  it('packages in NexusForge storage are classified by what they are', async () => {
    const d = await data()
    for (const [gameId, mods] of Object.entries(d.mods)) {
      const game = d.games[gameId]
      if (!game) continue
      for (const m of Object.values(mods)) {
        if (m.loaderId) continue
        let files
        try {
          files = await walkFiles(m.stagingDir)
        } catch {
          continue
        }
        const integration = /GTA5\.exe$/i.test(game.exePath ?? '') ? gta5Integration : genericIntegration
        const env = realEnv(join(LIVE, 'rel'))
        const info = await integration.inspect(game, env, { loaders: {} }, [])
        const c = await classifyPackage({ dir: m.stagingDir, files, name: m.name, archiveName: m.originalFile, source: m.source }, { game, info, integration, env })
        say(`${game.name} / ${m.name}: ${c.kind} -> ${c.routes.map((r) => `${r.from || '.'}=>${r.target}:${r.to || '.'}`).join(', ') || 'not deployed'}${c.checks.length ? ` [${c.checks.map((x) => `${x.level}:${x.code}`).join(', ')}]` : ''}`)
      }
    }
  })
})

describe('Script Hook V .NET nightly (real GitHub release, stand-in folder)', () => {
  it('a script that needs API 3.7 makes NexusForge install the official nightly, SHA-256 checked', async () => {
    const work = join(LIVE, 'shvdn-nightly')
    await fsp.rm(work, { recursive: true, force: true })
    const dir = join(work, 'GTA V stand-in')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(join(dir, 'GTA5.exe'), 'MZ')
    await fsp.writeFile(join(dir, 'ScriptHookV.dll'), 'MZ stand-in')
    const game = { id: 'live:gta', name: 'GTA V stand-in', platform: 'custom', installDir: dir, exePath: join(dir, 'GTA5.exe'), launch: { kind: 'exe', exe: '' }, art: { capsule: [], hero: [], header: [], logo: [] }, playtimeMinutes: 0, addedAt: 0, modding: { targetDir: dir, strategy: 'auto', sources: {} } } as Game
    const env = realEnv(work)
    const needs: LaunchCheck = { ran: true, loaded: [], errors: [], files: [{ file: 'ZombiesV.dll', ok: false, evidence: ['Unable to resolve API version 3.7.0.'], needs: { loaderId: 'shvdn', version: '3.7.0' } }] }
    const state = { loaders: {}, lastLaunch: needs }
    const mods: InstalledMod[] = []
    const info = await gta5Integration.inspect(game, env, state, mods)
    const st = info.loaders.find((l) => l.id === 'shvdn')!
    say(`status: ${st.state} latest=${st.latest} canInstall=${st.canInstall}\n  ${st.warning}`)
    expect(st.latest).toMatch(/^3\.7\.0-nightly\.\d+$/)
    const host = {
      async installModFile(_g: string, file: string, meta: { name: string; version?: string }) {
        const stage = join(work, 'mods', 'shvdn')
        await extractArchive(file, stage)
        const c = await gta5Integration.classify({ dir: stage, files: await walkFiles(stage), name: meta.name, loaderHint: 'shvdn' }, game, info, env)
        const m = { id: 'shvdn', gameId: game.id, name: meta.name, version: meta.version, stagingDir: stage, rootPath: c.rootPath, routes: c.routes, skipped: c.skipped, checks: c.checks, kind: c.kind, loaderId: c.loaderId } as InstalledMod
        mods.push(m)
        return m
      },
      state: () => state,
      saveState: () => {}
    }
    const steps: string[] = []
    await shvdnLoader.install(game, info, env, host, (s) => steps.push(s))
    say(steps.filter((s) => !/Downloading/.test(s)).join(' | '))
    expect(steps.some((s) => /SHA-256/.test(s))).toBe(true)
    expect(mods[0].version).toMatch(/^3\.7\.0-nightly/)
    const plan = buildPlan([{ id: 'shvdn', revision: 1, files: await planFilesFor(mods[0]) }], {})
    const after = await gta5Integration.inspect(game, env, state, mods)
    const r = await applyDeployment({ gameId: game.id, profileId: 'live', targets: engineTargets(after), strategy: 'auto', plan, manifestPath: join(work, 'state', 'm.json'), backupDir: join(work, 'state', 'b'), overwriteDir: join(work, 'state', 'o') })
    const files = (await fsp.readdir(dir)).sort()
    say(`deploy: ${r.outcome}; stand-in folder: ${files.join(', ')}`)
    expect(files).toEqual(expect.arrayContaining(['ScriptHookVDotNet.asi', 'ScriptHookVDotNet2.dll', 'ScriptHookVDotNet3.dll']))
    expect(files.some((f) => /\.pdb$/i.test(f) || f === 'Docs' || f === 'Licenses')).toBe(false)
  })
})
