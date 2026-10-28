// The diagnostic checks: what is wrong with a game's mod setup, with the evidence for it. Detection only: nothing
// here changes a file or a setting. Repairs are separate actions (DiagnosticFix) the user confirms first; see
// diagnostics.ts. Game integrations add their own checks through GameIntegration.diagnose.
//
// Codes (stable, listed in docs/INTEGRATIONS.md):
//   NF-INS-* installation   NF-DEP-* deployment   NF-PKG-* packages   NF-LDR-* mod loaders
//   NF-CFG-* configuration  NF-RUN-* runtime evidence                NF-<GAME>-* game-specific

import { promises as fsp } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type {
  DeployManifest,
  DeployStatus,
  DiagnosticFinding,
  DiagnosticModRow,
  Game,
  InstalledMod,
  IntegrationInfo,
  LaunchCheck,
  ModRuntime,
  VerifyCheck
} from '@shared/types'
import type { GameIntegration, IntegrationEnv, IntegrationState } from '../integrations/types'
import { loadersNeeded } from '../integrations/zip-loader'
import { safeReaddir } from '../util/fs'

export interface DiagnoseInput {
  game: Game
  info: IntegrationInfo
  integration: GameIntegration
  mods: InstalledMod[]
  enabled: Set<string>
  manifest?: DeployManifest
  status: DeployStatus
  lastLaunch?: LaunchCheck
  /** Checks the integration runs after deploying, run again now against the current manifest. */
  verifyChecks: VerifyCheck[]
  env: IntegrationEnv
  state: IntegrationState
}

const UNKNOWN: ModRuntime = { state: 'unknown', evidence: [] }

/** Folders next to a game that are never the game itself (redistributables, store wrappers). */
const NOT_GAME = /^(_?common_?redist|_?redist|redistributables?|directx|vcredist|support|_commonredist|__installer|installers?)$/i

/**
 * The deploy folder is a wrapper around the real game folder (repacks: "<Game>-SteamRIP.com\<Game>\game.exe"):
 * it holds nothing but the folder with the .exe, read-me files and redistributables.
 */
export async function wrapperFolder(game: Pick<Game, 'exePath' | 'modding'>): Promise<string | undefined> {
  if (!game.exePath) return undefined
  const target = game.modding.targetDir
  const exeDir = dirname(game.exePath)
  const rel = relative(target, exeDir)
  if (!rel || rel.startsWith('..') || /^[a-z]:/i.test(rel)) return undefined
  const first = rel.split(/[\\/]/)[0]
  const entries = await safeReaddir(target)
  const dirs = entries.filter((e) => e.isDirectory() && !NOT_GAME.test(e.name))
  const files = entries.filter((e) => e.isFile() && !/\.(url|txt|nfo|md|html?|lnk|ico|jpe?g|png|pdf)$/i.test(e.name))
  if (dirs.length !== 1 || dirs[0].name.toLowerCase() !== first.toLowerCase() || files.length) return undefined
  // Only when the game itself lives one level down (its .exe directly in that folder); engines that keep the .exe in
  // bin\ (Watch Dogs, Source games) have data folders next to bin\ and are left alone.
  return rel.includes('\\') || rel.includes('/') ? undefined : exeDir
}

async function manifestDrift(manifest: DeployManifest, limit = 20000): Promise<Array<{ path: string; reason: string; modId: string }>> {
  const out: Array<{ path: string; reason: string; modId: string }> = []
  for (const e of manifest.entries.slice(0, limit)) {
    const dir = manifest.targets[e.target]
    if (!dir) continue
    const abs = join(dir, e.rel)
    try {
      const st = await fsp.lstat(abs)
      if (e.method === 'symlink' && !st.isSymbolicLink()) out.push({ path: abs, reason: 'replaced by a regular file', modId: e.modId })
      else if (e.method !== 'symlink' && st.size !== e.size) out.push({ path: abs, reason: `changed (size ${st.size} instead of ${e.size})`, modId: e.modId })
    } catch {
      out.push({ path: abs, reason: 'missing', modId: e.modId })
    }
  }
  return out
}

function finding(f: Omit<DiagnosticFinding, 'fixes' | 'evidence'> & Partial<Pick<DiagnosticFinding, 'fixes' | 'evidence'>>): DiagnosticFinding {
  return { evidence: [], fixes: [], ...f }
}

const DEPLOY_FIX = { id: 'deploy', label: 'Set up and deploy', description: 'Installs the mod loaders the enabled mods need (official releases), then deploys and checks every file. Replaced game files are backed up first.', consequential: true }

export async function runChecks(input: DiagnoseInput): Promise<{ findings: DiagnosticFinding[]; rows: DiagnosticModRow[] }> {
  const { game, info, integration, mods, enabled, manifest, status } = input
  const out: DiagnosticFinding[] = []
  const name = (id: string) => mods.find((m) => m.id === id)?.name ?? id

  // --- Installation --------------------------------------------------------------------------------------------
  if (game.missing) {
    out.push(finding({ code: 'NF-INS-001', category: 'installation', severity: 'error', confidence: 'confirmed', title: 'The game folder is missing', detail: `${game.installDir} does not exist (moved, deleted, or the drive is not connected).`, evidence: [game.installDir], userAction: 'Point the game at its folder again (Game settings › Executable) or remove it from the library.' }))
  } else if (game.exePath) {
    try {
      await fsp.access(game.exePath)
    } catch {
      out.push(finding({ code: 'NF-INS-002', category: 'installation', severity: 'error', confidence: 'confirmed', title: "The game's executable is missing", detail: `${game.exePath} does not exist, so NexusForge can't tell which copy is started.`, evidence: [game.exePath], userAction: 'Pick the executable again in the game settings.' }))
    }
  }
  for (const p of game.missing ? [] : info.problems) out.push(finding({ code: 'NF-INS-003', category: 'installation', severity: 'error', confidence: 'confirmed', title: 'The game installation looks incomplete', detail: p, evidence: [game.installDir] }))
  const wrapper = integration.id === 'generic' ? await wrapperFolder(game) : undefined
  if (wrapper) {
    out.push(
      finding({
        code: 'NF-INS-004',
        category: 'installation',
        severity: 'warning',
        confidence: 'likely',
        title: 'Mods go one folder above the game',
        detail: `The deploy folder ${game.modding.targetDir} only holds the folder the game runs from (${wrapper}) plus read-me files. Most games read mods relative to their own folder, so mods placed one level up are likely never seen.`,
        evidence: [`deploy folder: ${game.modding.targetDir}`, `executable: ${game.exePath}`],
        fixes: [{ id: 'set-deploy-dir', label: 'Deploy into the game folder', description: `Changes the deploy folder to ${wrapper} and deploys again: NexusForge's files move from ${game.modding.targetDir} to ${wrapper}.`, consequential: true, params: { dir: wrapper } }]
      })
    )
  }

  // --- Deployment state ------------------------------------------------------------------------------------------
  if (status.interrupted) out.push(finding({ code: 'NF-DEP-001', category: 'deployment', severity: 'error', confidence: 'confirmed', title: 'A deployment was cut off', detail: 'NexusForge was closed or crashed while it changed files. The next deployment first puts back the state from before it.', evidence: ['deployment journal present'], fixes: [DEPLOY_FIX] }))
  if (status.last && (status.last.outcome === 'failed' || status.last.outcome === 'rolled_back')) {
    out.push(finding({ code: 'NF-DEP-002', category: 'deployment', severity: 'error', confidence: 'confirmed', title: status.last.problem?.title ?? 'The last deployment failed', detail: `${status.last.problem?.detail ?? status.last.title}${status.last.outcome === 'rolled_back' ? ' The previous setup was restored.' : ''}`, evidence: [`${new Date(status.last.at).toLocaleString()}: ${status.last.title}`, ...(status.last.problem?.paths ?? []).slice(0, 5)], fixes: [DEPLOY_FIX], userAction: status.last.problem?.advice.join(' ') }))
  }
  const enabledDeployable = mods.filter((m) => enabled.has(m.id) && !(m.checks ?? []).some((c) => c.level === 'error'))
  const stale = [...new Set((manifest?.entries ?? []).map((e) => e.modId))].filter((id) => !enabledDeployable.some((m) => m.id === id))
  if (!game.missing && !status.inSync && (enabledDeployable.length || stale.length)) {
    out.push(
      finding({
        code: 'NF-DEP-003',
        category: 'deployment',
        severity: 'warning',
        confidence: 'confirmed',
        title: 'The game does not have the current mod setup',
        detail: stale.length
          ? `The game still has files of mods that are disabled, removed or can't be deployed any more (${stale.map(name).join(', ')}); deploying takes them out.`
          : status.deployed
            ? 'Mods were enabled, disabled, updated or laid out with newer rules since the last deployment; the game still has the old files.'
            : 'The enabled mods were never deployed into the game.',
        evidence: [`enabled mods: ${enabledDeployable.map((m) => m.name).join(', ') || 'none deployable'}`, ...(stale.length ? [`still in the game: ${stale.map(name).join(', ')}`] : [])],
        modIds: stale.length ? stale : undefined,
        fixes: [DEPLOY_FIX]
      })
    )
  }
  if (manifest?.entries.length) {
    const drift = await manifestDrift(manifest)
    if (drift.length) {
      const modIds = [...new Set(drift.map((d) => d.modId))]
      out.push(finding({ code: 'NF-DEP-004', category: 'deployment', severity: 'error', confidence: 'confirmed', title: `${drift.length} deployed file(s) are missing or changed`, detail: `Files NexusForge placed are no longer what it recorded (${modIds.map(name).join(', ')}). An antivirus, the game, a game update or another tool changed them.`, evidence: drift.slice(0, 12).map((d) => `${d.path}: ${d.reason}`), modIds, fixes: [DEPLOY_FIX] }))
    }
  }
  for (const m of mods) {
    try {
      await fsp.access(m.stagingDir)
    } catch {
      out.push(finding({ code: 'NF-DEP-005', category: 'state', severity: 'error', confidence: 'confirmed', title: `${m.name}: its files are gone from NexusForge storage`, detail: 'The mod is still listed, but its folder in NexusForge storage is missing, so it can\'t be deployed.', evidence: [m.stagingDir], modIds: [m.id], fixes: [{ id: 'remove-mod', label: 'Remove from the list', description: `Removes ${m.name} from NexusForge (and its files from the game, if deployed). Install it again afterwards.`, consequential: true, params: { modId: m.id } }] }))
    }
  }

  // --- Packages --------------------------------------------------------------------------------------------------
  for (const m of mods) {
    if (!enabled.has(m.id)) continue
    for (const c of m.checks ?? []) {
      if (c.level === 'info') continue
      const fixes = []
      if (c.code === 'installer' && m.meta?.installer) fixes.push({ id: 'run-installer', label: 'Run installer', description: `Starts ${m.meta.installer} from NexusForge storage. It is a program from the internet: Windows may ask for permission, and it does its own installation (NexusForge can't undo it).`, consequential: true, params: { modId: m.id } })
      if (c.code === 'savegame' && info.targets.some((t) => t.id === 'saves')) fixes.push({ id: 'relayout', label: 'Check the package again', description: `Classifies ${m.name} again now that the save folder is known (${info.targets.find((t) => t.id === 'saves')!.dir}).`, consequential: false, params: { modId: m.id } })
      out.push(
        finding({
          code: c.level === 'error' ? 'NF-PKG-001' : 'NF-PKG-002',
          category: 'package',
          severity: 'warning',
          confidence: 'confirmed',
          title: c.level === 'error' ? `${m.name} is not deployed` : c.userAction ? `${m.name} needs something only you can do` : `${m.name}: may not work as expected`,
          detail: c.message,
          evidence: [`package: ${m.originalFile ?? m.stagingDir}`, `classified as: ${m.kind ?? 'files'}${m.meta?.strategy ? ` (${m.meta.strategy})` : ''}`],
          modIds: [m.id],
          fixes,
          userAction: c.userAction
        })
      )
    }
  }

  // --- Loaders ---------------------------------------------------------------------------------------------------
  const needed = new Map<string, string[]>()
  for (const m of enabledDeployable) for (const l of loadersNeeded(m)) needed.set(l, [...(needed.get(l) ?? []), m.id])
  for (const [loaderId, modIds] of needed) {
    const l = info.loaders.find((x) => x.id === loaderId)
    const managed = mods.some((m) => m.loaderId === loaderId && enabled.has(m.id))
    if (!l) continue
    if (l.state === 'unsupported' || (l.blocked && l.state !== 'installed' && l.state !== 'outdated')) {
      out.push(finding({ code: 'NF-LDR-002', category: 'loader', severity: 'error', confidence: 'confirmed', title: `${l.name} can't be installed here`, detail: `${modIds.map(name).join(', ')} need ${l.name}. ${l.blocked ?? ''}`, evidence: [`loader state: ${l.state}`], modIds, userAction: l.blocked }))
    } else if ((l.state === 'missing' || l.state === 'broken') && !managed) {
      out.push(finding({ code: 'NF-LDR-001', category: 'loader', severity: 'error', confidence: 'confirmed', title: `${l.name} is missing`, detail: `${modIds.map(name).join(', ')} need ${l.name}, which is ${l.state === 'broken' ? 'incomplete' : 'not installed'}; without it the game never loads them.`, evidence: [`${l.dir ?? ''}: ${l.detail ?? l.state}`], modIds, fixes: l.canInstall ? [{ id: 'install-loader', label: `Install ${l.name}`, description: `Downloads ${l.name}${l.latest ? ` ${l.latest}` : ''} from its official release${l.warning ? ` (${l.warning})` : ''} and deploys it into ${l.dir ?? 'the game'}. Replaced files are backed up.`, consequential: true, params: { loaderId } }] : [] }))
    }
  }
  for (const l of info.loaders) {
    if (l.state !== 'outdated' || !l.canUpdate) continue
    const fromLog = Boolean(l.warning && /log/i.test(l.warning) && needed.has(l.id))
    out.push(finding({ code: 'NF-LDR-003', category: 'loader', severity: fromLog ? 'error' : 'info', confidence: 'confirmed', title: `${l.name} ${l.version ?? ''} has an update (${l.latest})`, detail: l.warning ?? `${l.latest} is available from the official release.`, evidence: [`installed: ${l.version ?? 'unknown'}`, `newest fitting: ${l.latest}`], modIds: needed.get(l.id), fixes: [{ id: 'install-loader', label: `Update to ${l.latest}`, description: `Downloads ${l.name} ${l.latest} from its official release (checksum checked where the publisher states one) and deploys it over ${l.version ?? 'the installed version'}; replaced files are backed up and come back if the deployment fails.`, consequential: true, params: { loaderId: l.id } }] }))
  }

  // --- Configuration (the integration's own checks, against what is deployed now) --------------------------------
  for (const c of input.verifyChecks) {
    // Already reported above in the same words (a loader update).
    if (c.ok || out.some((f) => f.detail === c.detail)) continue
    out.push(finding({ code: 'NF-CFG-001', category: 'configuration', severity: c.level === 'error' ? 'error' : c.level === 'warning' ? 'warning' : 'info', confidence: 'confirmed', title: c.label, detail: c.detail ?? c.label, evidence: [`${info.name}: post-deployment check`], fixes: c.level === 'error' ? [DEPLOY_FIX] : [] }))
  }

  // --- Runtime evidence ------------------------------------------------------------------------------------------
  const runtime = status.runtime ?? {}
  const check = input.lastLaunch
  const caps = info.supports
  for (const [modId, r] of Object.entries(runtime)) {
    if (r.state !== 'failed') continue
    const l = r.needs ? info.loaders.find((x) => x.id === r.needs!.loaderId) : undefined
    out.push(
      finding({
        code: 'NF-RUN-001',
        category: 'runtime',
        severity: 'error',
        confidence: 'confirmed',
        title: `${name(modId)} failed to load at the last start`,
        detail: r.needs ? `Its loader log says it needs ${l?.name ?? r.needs.loaderId} ${r.needs.version} or newer${l?.version ? `; ${l.version} is installed` : ''}.` : 'Its loader log reports an error for it.',
        evidence: [...(r.logFile ? [`log: ${r.logFile}${r.at ? ` (${new Date(r.at).toLocaleString()})` : ''}`] : []), ...r.evidence],
        modIds: [modId],
        fixes: l && (l.canUpdate || l.canInstall) ? [{ id: 'install-loader', label: `${l.canUpdate ? 'Update' : 'Install'} ${l.name}${l.latest ? ` to ${l.latest}` : ''}`, description: `${l.warning ? `${l.warning} ` : ''}Replaced files are backed up and come back if the deployment fails.`, consequential: true, params: { loaderId: l.id } }] : [],
        userAction: l && !l.canUpdate && !l.canInstall ? `Wait for a ${l.name} build that supports it, or remove the mod.` : undefined
      })
    )
  }
  if (check?.ran && check.errors.length) {
    const tied = new Set(Object.values(runtime).flatMap((r) => r.evidence))
    const loose = check.errors.filter((e) => ![...tied].some((t) => t.includes(e.trim())))
    if (loose.length) out.push(finding({ code: 'NF-RUN-002', category: 'runtime', severity: 'warning', confidence: 'likely', title: `${check.loader ?? 'The mod loader'} logged errors at the last start`, detail: 'Errors NexusForge could not tie to one mod. They may come from a mod installed outside NexusForge, or from the loader itself.', evidence: [`log: ${check.logFile ?? ''}`, ...loose.slice(0, 10)] }))
  }
  if (game.missing) {
    // Nothing to say about runtime for a game that isn't there.
  } else if (caps && !caps.runtimeLog && manifest?.entries.length) {
    out.push(finding({ code: 'NF-RUN-003', category: 'runtime', severity: 'info', confidence: 'confirmed', title: 'Loading can not be confirmed for this game', detail: `NexusForge knows of no log in which ${game.name} (or its mod loader) says which mods it loaded. The installation is validated (every file checked); whether the game uses the mods shows only in the game.`, evidence: [`integration: ${info.name}`] }))
  } else if (caps?.runtimeLog && manifest?.entries.length) {
    if (!check?.ran) out.push(finding({ code: 'NF-RUN-004', category: 'runtime', severity: 'info', confidence: 'confirmed', title: 'No start of the game with mods seen yet', detail: "The mod loader's log doesn't exist yet. Start the game once, then run Diagnose again to see which mods loaded.", evidence: [check?.logFile ? `expected log: ${check.logFile}` : 'no loader log'] }))
    else if (check.at && check.at < manifest.deployedAt) out.push(finding({ code: 'NF-RUN-005', category: 'runtime', severity: 'info', confidence: 'confirmed', title: 'The last start was before the last deployment', detail: 'What the log says may not match the current setup. Start the game again to check it.', evidence: [`log written ${new Date(check.at).toLocaleString()}`, `deployed ${new Date(manifest.deployedAt).toLocaleString()}`] }))
  }

  // --- Game-specific ---------------------------------------------------------------------------------------------
  if (integration.diagnose) {
    try {
      out.push(...(await integration.diagnose({ game, info, mods, enabled, manifest, lastLaunch: check, env: input.env, state: input.state })))
    } catch (err) {
      out.push(finding({ code: 'NF-INT-001', category: 'state', severity: 'warning', confidence: 'confirmed', title: `${info.name}: its own checks failed`, detail: (err as Error).message }))
    }
  }

  // --- Per-mod rows --------------------------------------------------------------------------------------------
  const rows: DiagnosticModRow[] = mods.map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    kind: m.kind,
    enabled: enabled.has(m.id),
    state: status.perMod[m.id] ?? (enabled.has(m.id) ? 'prepared' : 'disabled'),
    runtime: runtime[m.id] ?? UNKNOWN,
    needs: loadersNeeded(m),
    problems: (m.checks ?? []).filter((c) => c.level !== 'info').map((c) => c.message)
  }))

  const rank = { error: 0, warning: 1, info: 2 }
  out.sort((a, b) => rank[a.severity] - rank[b.severity])
  return { findings: out, rows }
}

/** File name of a log or path without the folders (for short evidence lines). */
export const short = (p: string) => basename(p)
