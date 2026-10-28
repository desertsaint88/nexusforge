import { shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ConflictReport,
  DeployOutcomeSummary,
  DeployProgress,
  DeployReport,
  DeployStatus,
  Game,
  InstalledMod,
  IntegrationInfo,
  LinkCapabilities,
  ModDeployState,
  ModFileEntry,
  ModSourceRef
} from '@shared/types'
import { db } from '../store'
import { paths } from '../paths'
import { emit } from '../events'
import { scoped } from '../logger'
import { exists, isDir, renameDir, safeName, safeReaddir, shortId, walkFiles } from '../util/fs'
import { getGame, runningGames } from '../library/library'
import { findPreset } from '../library/presets'
import { gameProcessesIn, runningExecutables } from '../library/tracker'
import { extractArchive, isArchive, zipFolder } from './archive'
import { buildPlan, conflictReport, type DeployPlan, type PlanFile, type PlanMod } from './plan'
import { planFilesFor, routesOf } from './routes'
import { applyDeployment, EMPTY_PLAN, hasInterruptedDeployment, readManifest } from './deploy'
import { probeLinks } from './links'
import { activeProfile, addModToProfiles, deleteAllProfiles, listProfiles, saveProfile } from './profiles'
import { integrationFor } from '../integrations/registry'
import { integrationEnv, integrationState, saveIntegrationState } from '../integrations/env'
import { engineTargets, type GameIntegration, type LoaderInstallHost, type StagedPackage } from '../integrations/types'
import { route, skipDocs } from '../integrations/common'
import { looksLikeSave } from '../integrations/generic'
import { loadersNeeded } from '../integrations/zip-loader'

const log = scoped('mods')

function allMods(): Record<string, Record<string, InstalledMod>> {
  return db().get('mods')
}

function saveMod(mod: InstalledMod): void {
  const all = allMods()
  all[mod.gameId] = { ...(all[mod.gameId] ?? {}), [mod.id]: mod }
  db().set('mods', all)
}

function deleteModRecord(gameId: string, modId: string): void {
  const all = allMods()
  if (all[gameId]) delete all[gameId][modId]
  db().set('mods', all)
}

export function listMods(gameId: string): InstalledMod[] {
  return Object.values(allMods()[gameId] ?? {})
}

function requireMod(gameId: string, modId: string): InstalledMod {
  const m = allMods()[gameId]?.[modId]
  if (!m) throw new Error('Mod not found')
  return m
}

function requireGame(gameId: string): Game {
  const g = getGame(gameId)
  if (!g) throw new Error('Game not found')
  return g
}

// ---------------------------------------------------------------------------
// The game's integration

export interface GameContext {
  game: Game
  integration: GameIntegration
  info: IntegrationInfo
}

/** Loader installs through the mod pipeline (BepInEx goes into the game folder like a mod). */
export const loaderHost: LoaderInstallHost = {
  installModFile: (gameId, file, meta) => installMod(gameId, file, meta),
  state: integrationState,
  saveState: saveIntegrationState
}

const inspected = new Map<string, { at: number; ctx: Promise<GameContext> }>()

/** What the game's integration says about it right now (cached for a few seconds). */
export function inspectGame(gameId: string, fresh = false): Promise<GameContext> {
  const hit = inspected.get(gameId)
  if (!fresh && hit && Date.now() - hit.at < 4000) return hit.ctx
  const ctx = (async () => {
    const game = requireGame(gameId)
    const env = integrationEnv()
    const integration = await integrationFor(game, env)
    const info = await integration.inspect(game, env, integrationState(gameId), listMods(gameId))
    return { game, integration, info }
  })()
  inspected.set(gameId, { at: Date.now(), ctx })
  ctx.catch(() => inspected.delete(gameId))
  return ctx
}

export function forgetInspection(gameId: string): void {
  inspected.delete(gameId)
}

export async function integrationInfo(gameId: string, fresh = false): Promise<IntegrationInfo> {
  return (await inspectGame(gameId, fresh)).info
}

// ---------------------------------------------------------------------------
// Files

const fileCache = new Map<string, PlanFile[]>()

/** Every file a mod puts into the game: deploy target, path there, and its file in storage. */
export async function planFiles(mod: InstalledMod): Promise<PlanFile[]> {
  const key = `${mod.id}:${mod.updatedAt}:${mod.stagingDir}:${JSON.stringify(routesOf(mod))}:${JSON.stringify(mod.skipped ?? [])}`
  const hit = fileCache.get(key)
  if (hit) return hit
  const out = await planFilesFor(mod)
  fileCache.set(key, out)
  return out
}

/** Files under the mod's content folder (the mod settings preview). */
export async function modFiles(mod: InstalledMod): Promise<ModFileEntry[]> {
  return (await planFiles(mod)).map((f) => ({ rel: f.target === 'game' ? f.rel : `${f.target}: ${f.rel}`, size: f.size }))
}

// ---------------------------------------------------------------------------
// Install

/** "SkyUI_5_2_SE-12604-5-2SE-1507064606.7z" -> { name: "SkyUI 5 2 SE", version: "5.2SE" } */
export function nameFromArchive(file: string): { name: string; version?: string } {
  let stem = basename(file).replace(/\.(zip|7z|rar|tar|gz|tgz|xz)$/i, '')
  let version: string | undefined
  const nexus = stem.match(/^(.*?)-(\d{2,7})-([\w-]+?)-(\d{9,11})$/)
  if (nexus) {
    stem = nexus[1]
    version = nexus[3].replace(/-/g, '.')
  }
  const name = stem.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return { name: name || stem, version }
}

export interface InstallMeta {
  name?: string
  version?: string
  author?: string
  summary?: string
  thumbnail?: string
  source?: ModSourceRef
  /** Mods this one needs; it is placed after them in the load order. */
  requires?: ModSourceRef[]
}

/** Archive name without the download id NexusForge prefixes ("d_1a2b3c4d5e6f-Car Pack.zip" -> "Car Pack.zip"). */
function originalName(file: string): string {
  return basename(file).replace(/^d_[0-9a-f]{6,}-/i, '')
}

/**
 * Games that load mods as .zip files (BeamNG): the zip is kept as it is. Downloads that wrap the real mod zip(s)
 * in another archive are unwrapped one level; a .7z/.rar holding the mod's folders is packed into a zip.
 */
async function stagePackedMod(input: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  const probe = join(dest, '.probe')
  try {
    await extractArchive(input, probe)
    let dir = probe
    for (let i = 0; i < 2; i++) {
      const e = await safeReaddir(dir)
      if (e.length === 1 && e[0].isDirectory()) dir = join(dir, e[0].name)
      else break
    }
    const entries = (await safeReaddir(dir)).filter((e) => !(e.isFile() && /\.(txt|md|rtf|pdf|html?|url|nfo|jpe?g|png)$/i.test(e.name)))
    const zips = entries.filter((e) => e.isFile() && /\.zip$/i.test(e.name))
    if (zips.length && zips.length === entries.length) {
      for (const z of zips) await fsp.rename(join(dir, z.name), join(dest, z.name))
    } else if (/\.zip$/i.test(input)) {
      await fsp.copyFile(input, join(dest, safeName(originalName(input))))
    } else {
      await zipFolder(dir, join(dest, `${safeName(originalName(input).replace(/\.[^.]+$/, ''))}.zip`))
    }
  } finally {
    await fsp.rm(probe, { recursive: true, force: true })
  }
}

const layoutTag = (i: GameIntegration) => `${i.id}@${i.revision}`

export async function installMod(gameId: string, input: string, meta: InstallMeta = {}): Promise<InstalledMod> {
  const game = requireGame(gameId)
  if (!(await exists(input))) throw new Error(`File not found: ${input}`)
  const ctx = await inspectGame(gameId, true)
  const stagingRoot = paths.modStaging(gameId)
  const id = shortId('m')
  const tmp = join(stagingRoot, `.installing-${id}`)
  const packed = Boolean(findPreset(game)?.keepArchive)
  const inputIsDir = await isDir(input)
  log.info(`installing ${input} for ${game.name}${packed ? ' (kept packed)' : ''} [${ctx.integration.id}]`)
  try {
    if (inputIsDir) {
      await fsp.cp(input, tmp, { recursive: true, errorOnExist: false, force: true })
    } else if (packed && isArchive(input)) {
      await stagePackedMod(input, tmp)
    } else if (isArchive(input)) {
      await extractArchive(input, tmp)
    } else {
      await fsp.mkdir(tmp, { recursive: true })
      await fsp.copyFile(input, join(tmp, originalName(input)))
    }

    const guessed = inputIsDir ? { name: basename(input) } : isArchive(input) ? nameFromArchive(originalName(input)) : { name: basename(originalName(input), extname(input)) }
    const files = await walkFiles(tmp)
    if (!files.length) throw new Error('The archive contains no files.')
    const pkg: StagedPackage = { dir: tmp, files, name: meta.name ?? guessed.name, archiveName: inputIsDir ? undefined : originalName(input), source: meta.source }
    const cls = await ctx.integration.classify(pkg, game, ctx.info, integrationEnv())

    const name = meta.name ?? cls.name ?? guessed.name
    const version = meta.version ?? cls.version ?? guessed.version
    const finalDir = join(stagingRoot, `${safeName(name)}_${id.slice(2, 8)}`)
    await renameDir(tmp, finalDir)

    // Installing a mod that is already installed from the same source replaces it in place.
    const previous = meta.source
      ? listMods(gameId).find((m) => m.source?.sourceId === meta.source!.sourceId && m.source?.modId === meta.source!.modId)
      : cls.loaderId
        ? listMods(gameId).find((m) => m.loaderId === cls.loaderId)
        : undefined

    const mod: InstalledMod = {
      id: previous?.id ?? id,
      gameId,
      name: previous?.name && !meta.name ? previous.name : name,
      version,
      author: meta.author ?? previous?.author,
      summary: meta.summary ?? previous?.summary,
      thumbnail: meta.thumbnail ?? previous?.thumbnail,
      source: meta.source ?? previous?.source,
      stagingDir: finalDir,
      rootPath: cls.rootPath,
      installedAt: previous?.installedAt ?? Date.now(),
      updatedAt: Date.now(),
      sizeBytes: 0,
      fileCount: 0,
      originalFile: inputIsDir ? undefined : basename(input),
      requires: meta.requires?.length ? meta.requires : previous?.requires,
      routes: cls.routes,
      kind: cls.kind,
      loaderId: cls.loaderId,
      needsLoader: cls.needsLoader,
      needsLoaders: cls.needsLoaders,
      skipped: cls.skipped,
      checks: cls.checks,
      meta: cls.meta,
      layoutBy: layoutTag(ctx.integration)
    }
    const deployable = await planFiles(mod)
    mod.fileCount = deployable.length
    mod.sizeBytes = deployable.reduce((a, f) => a + f.size, 0)
    saveMod(mod)
    if (previous) {
      log.info(`updated ${mod.name} ${previous.version ?? ''} -> ${version ?? ''}`)
      // The old files stay until a deployment without them succeeded, so a failed update can be rolled back.
      retireStaging(gameId, previous.stagingDir)
    } else {
      await addModToProfiles(gameId, mod.id)
    }
    if (cls.skipped.length) log.info(`${mod.name}: left out ${cls.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`)
    for (const c of cls.checks) log.info(`${mod.name}: ${c.level}: ${c.message}`)
    forgetInspection(gameId)
    emit('mods:changed', { gameId })
    return mod
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    log.error(`install failed for ${input}`, err)
    throw err
  }
}

/**
 * Lays an installed mod out again when the game's integration has newer rules (mods installed before 1.4 went
 * into the game folder as they were). A content folder the user picked by hand is kept.
 */
async function ensureLayout(mod: InstalledMod, ctx: GameContext): Promise<InstalledMod> {
  const want = layoutTag(ctx.integration)
  if (mod.layoutBy === want || mod.layoutBy === 'manual') return mod
  if (!(await isDir(mod.stagingDir))) return mod
  let next: InstalledMod
  if (ctx.integration.id === 'generic' && !mod.layoutBy) {
    // Same files as before, minus read-me files at the top of the content folder. A save game is no longer
    // put into the game folder (before 1.4 it was, where no game reads it).
    const files = await walkFiles(mod.stagingDir)
    const pkg: StagedPackage = { dir: mod.stagingDir, files, name: mod.name, archiveName: mod.originalFile, source: mod.source }
    const cls = looksLikeSave(pkg, files.map((f) => f.rel)) ? await ctx.integration.classify(pkg, ctx.game, ctx.info, integrationEnv()) : undefined
    next = cls
      ? { ...mod, routes: cls.routes, kind: cls.kind, skipped: cls.skipped, checks: cls.checks, layoutBy: want }
      : { ...mod, routes: [route(mod.rootPath, 'game')], skipped: skipDocs(files, mod.rootPath), layoutBy: want }
  } else {
    const files = await walkFiles(mod.stagingDir)
    const pkg: StagedPackage = { dir: mod.stagingDir, files, name: mod.name, archiveName: mod.originalFile, source: mod.source }
    const cls = await ctx.integration.classify(pkg, ctx.game, ctx.info, integrationEnv())
    next = {
      ...mod,
      routes: cls.routes,
      rootPath: cls.rootPath,
      kind: cls.kind,
      loaderId: cls.loaderId,
      needsLoader: cls.needsLoader,
      needsLoaders: cls.needsLoaders,
      skipped: cls.skipped,
      checks: cls.checks,
      meta: cls.meta ?? mod.meta,
      layoutBy: want
    }
  }
  const deployable = await planFiles(next)
  next.fileCount = deployable.length
  next.sizeBytes = deployable.reduce((a, f) => a + f.size, 0)
  saveMod(next)
  log.info(`re-laid out ${mod.name} with ${want}: ${(next.routes ?? []).map((r) => `${r.from || '.'} -> ${r.target}:${r.to || '.'}`).join(', ')}`)
  return next
}

function retireStaging(gameId: string, dir: string): void {
  const list = db().get('retiredStaging') ?? []
  if (!list.some((r) => r.dir.toLowerCase() === dir.toLowerCase())) db().set('retiredStaging', [...list, { gameId, dir, at: Date.now() }])
}

/** Deletes replaced mod versions that no deployment uses any more. */
async function cleanupRetired(gameId: string): Promise<void> {
  const list = db().get('retiredStaging') ?? []
  const manifest = await readManifest(paths.deployManifest(gameId))
  const used = (dir: string) => manifest?.entries.some((e) => e.source.toLowerCase().startsWith(dir.toLowerCase() + '\\') || e.source.toLowerCase().startsWith(dir.toLowerCase() + '/'))
  const keep: typeof list = []
  for (const r of list) {
    if (r.gameId !== gameId || used(r.dir)) {
      keep.push(r)
      continue
    }
    await removeStaging(r.dir, gameId).catch(() => keep.push(r))
  }
  db().set('retiredStaging', keep)
}

async function removeStaging(dir: string, gameId: string): Promise<void> {
  const game = getGame(gameId)
  const abs = resolve(dir)
  // Never delete anything that looks like a drive root or contains the game itself.
  if (abs.split(/[\\/]/).filter(Boolean).length < 3) return
  if (game && resolve(game.installDir).toLowerCase().startsWith(abs.toLowerCase())) return
  await fsp.rm(abs, { recursive: true, force: true })
}

export async function removeMod(gameId: string, modId: string): Promise<void> {
  const mod = requireMod(gameId, modId)
  deleteModRecord(gameId, modId)
  // listProfiles normalizes every profile, dropping the removed id.
  const { profiles } = await listProfiles(gameId)
  for (const p of profiles) await saveProfile(p)
  const manifest = await readManifest(paths.deployManifest(gameId))
  if (manifest?.entries.some((e) => e.modId === modId)) {
    const report = await deployGame(gameId)
    if (report.outcome !== 'verified' && report.outcome !== 'nothing') {
      // The game still has its files: keep the record so nothing is orphaned, and say why.
      saveMod(mod)
      for (const p of profiles) await saveProfile({ ...p, order: [...p.order, mod.id] })
      throw new Error(`${mod.name} could not be taken out of the game: ${report.problem?.detail ?? report.title}`)
    }
  }
  await removeStaging(mod.stagingDir, gameId)
  log.info(`removed mod ${mod.name}`)
  forgetInspection(gameId)
  emit('mods:changed', { gameId })
}

export async function updateMod(gameId: string, modId: string, patch: Partial<Pick<InstalledMod, 'name' | 'version' | 'rootPath'>>): Promise<InstalledMod> {
  const mod = requireMod(gameId, modId)
  if (patch.name !== undefined && patch.name.trim()) mod.name = patch.name.trim()
  if (patch.version !== undefined) mod.version = patch.version.trim() || undefined
  if (patch.rootPath !== undefined && patch.rootPath !== mod.rootPath) {
    const root = patch.rootPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (root.split('/').includes('..')) throw new Error('Invalid folder')
    if (!(await isDir(join(mod.stagingDir, ...root.split('/').filter(Boolean))))) throw new Error('That folder does not exist in the mod.')
    // A folder picked by hand maps onto the game's main deploy folder and is never re-laid out automatically.
    mod.rootPath = root
    mod.routes = [route(root, 'game')]
    mod.skipped = skipDocs(await walkFiles(mod.stagingDir), root)
    mod.layoutBy = 'manual'
    mod.checks = (mod.checks ?? []).filter((c) => c.level !== 'error')
    const files = await planFiles(mod)
    mod.sizeBytes = files.reduce((a, f) => a + f.size, 0)
    mod.fileCount = files.length
  }
  mod.updatedAt = Date.now()
  saveMod(mod)
  emit('mods:changed', { gameId })
  return mod
}

export async function rootCandidates(gameId: string, modId: string): Promise<string[]> {
  const mod = requireMod(gameId, modId)
  const out: string[] = ['']
  async function visit(rel: string, depth: number): Promise<void> {
    if (depth > 3 || out.length > 200) return
    for (const e of await safeReaddir(join(mod.stagingDir, ...rel.split('/').filter(Boolean)))) {
      if (!e.isDirectory()) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      out.push(child)
      await visit(child, depth + 1)
    }
  }
  await visit('', 0)
  return out
}

export async function listModFiles(gameId: string, modId: string): Promise<ModFileEntry[]> {
  return modFiles(requireMod(gameId, modId))
}

export async function openModFolder(gameId: string, modId?: string): Promise<void> {
  const dir = modId ? requireMod(gameId, modId).stagingDir : paths.modStaging(gameId)
  await shell.openPath(dir)
}

// ---------------------------------------------------------------------------
// Planning, conflicts, deployment

interface PlanResult {
  plan: DeployPlan
  profileId: string
  order: string[]
  ctx: GameContext
  /** Enabled mods left out of the deployment, and why. */
  excluded: Map<string, { state: ModDeployState; reason: string }>
}

/** A loader is usable when it is in the game, or when its mod is enabled and deploys with the others. */
function loaderReady(ctx: GameContext, loaderId: string, enabledMods: InstalledMod[]): boolean {
  const l = ctx.info.loaders.find((x) => x.id === loaderId)
  if (l && (l.state === 'installed' || l.state === 'outdated')) return true
  return enabledMods.some((m) => m.loaderId === loaderId && !(m.checks ?? []).some((c) => c.level === 'error'))
}

async function planFor(gameId: string): Promise<PlanResult> {
  const ctx = await inspectGame(gameId)
  const profile = await activeProfile(gameId)
  const mods = allMods()[gameId] ?? {}
  const enabled = new Set(profile.enabled)
  const enabledMods: InstalledMod[] = []
  for (const id of profile.order) {
    if (mods[id] && enabled.has(id)) enabledMods.push(await ensureLayout(mods[id], ctx))
  }
  const excluded: PlanResult['excluded'] = new Map()
  const planMods: PlanMod[] = []
  for (const mod of enabledMods) {
    const error = (mod.checks ?? []).find((c) => c.level === 'error')
    if (error) {
      excluded.set(mod.id, { state: 'blocked', reason: error.message })
      continue
    }
    const missingLoader = loadersNeeded(mod).find((id) => !loaderReady(ctx, id, enabledMods))
    if (missingLoader) {
      const l = ctx.info.loaders.find((x) => x.id === missingLoader)
      excluded.set(mod.id, { state: 'needs_loader', reason: l?.blocked ?? `Needs ${l?.name ?? missingLoader}, which is not installed yet.` })
      continue
    }
    const files = (await planFiles(mod)).filter((f) => ctx.info.targets.some((t) => t.id === f.target))
    planMods.push({ id: mod.id, revision: mod.updatedAt, files })
  }
  const targets = ctx.info.targets.map((t) => `${t.id}=${t.dir.toLowerCase()}`).join(';')
  const plan = buildPlan(planMods, profile.fileOverrides, `${targets}|${ctx.game.modding.strategy}`)
  return { plan, profileId: profile.id, order: profile.order, ctx, excluded }
}

export async function getConflicts(gameId: string): Promise<ConflictReport> {
  const { plan, profileId, order } = await planFor(gameId)
  return conflictReport(plan, gameId, profileId, order)
}

const locks = new Map<string, Promise<unknown>>()

export function withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(gameId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(gameId, next)
  void next
    .finally(() => {
      if (locks.get(gameId) === next) locks.delete(gameId)
    })
    .catch(() => {})
  return next
}

/** The game (or a launcher in its folder) is running: its files are locked and must not change underneath it. */
async function runningCheck(game: Game, dirs: string[]) {
  const reason = {
    code: 'game_running',
    title: `${game.name} is running`,
    detail: `Close ${game.name} before deploying: Windows keeps the files of a running game locked, and changing them under it can break both.`,
    advice: [`Close ${game.name}, then deploy again.`]
  }
  if (runningGames().includes(game.id)) return reason
  const exes = await runningExecutables().catch(() => [] as string[])
  for (const d of dirs) if (d && gameProcessesIn(d, exes).length) return reason
  return undefined
}

function summarize(report: DeployReport): DeployOutcomeSummary {
  return { at: Date.now(), outcome: report.outcome, title: report.title, problem: report.problem }
}

const controllers = new Map<string, AbortController>()

/** Listeners for deployment stages (the setup operation follows them). */
export const deployProgressHooks = new Set<(gameId: string, p: Omit<DeployProgress, 'gameId'>) => void>()

function reportProgress(gameId: string, p: Omit<DeployProgress, 'gameId'>): void {
  emit('deploy:progress', { gameId, ...p })
  for (const h of deployProgressHooks) h(gameId, p)
}

export function cancelDeploy(gameId: string): void {
  controllers.get(gameId)?.abort()
}

export function deployGame(gameId: string): Promise<DeployReport> {
  return withLock(gameId, async () => {
    forgetInspection(gameId)
    const { plan, profileId, ctx, excluded } = await planFor(gameId)
    const { game, integration, info } = ctx
    const env = integrationEnv()
    const mods = listMods(gameId)
    const controller = new AbortController()
    controllers.set(gameId, controller)
    let report: DeployReport
    try {
      report = await applyDeployment({
        gameId,
        profileId,
        targets: engineTargets(info),
        strategy: game.modding.strategy,
        plan,
        manifestPath: paths.deployManifest(gameId),
        backupDir: paths.backups(gameId),
        overwriteDir: paths.overwrite(gameId),
        onProgress: (p) => reportProgress(gameId, p),
        log,
        signal: controller.signal,
        precheck: async () => {
          if (!info.valid && plan.entries.size) {
            return { code: 'game_invalid', title: `${game.name} looks incomplete`, detail: info.problems.join(' '), advice: ['Fix the game installation (or its executable in the game settings), then deploy again.'] }
          }
          return runningCheck(game, [game.installDir, ...info.loaders.map((l) => l.dir ?? '').filter((d) => d && d.toLowerCase() !== game.installDir.toLowerCase())])
        },
        configure: integration.configure ? (m) => integration.configure!(game, info, m, mods, env, loaderHost) : undefined,
        verifyExtra: integration.verify ? (m) => integration.verify!(game, info, m, mods, env) : undefined,
        loadVerifiable: integration.loadVerifiable
      })
    } finally {
      controllers.delete(gameId)
    }
    for (const [id, why] of excluded) {
      const m = mods.find((x) => x.id === id)
      report.notes.push(`${m?.name ?? id} was not deployed: ${why.reason}`)
    }
    const summary = summarize(report)
    if (excluded.size && report.outcome === 'verified') summary.failedMods = [...excluded.keys()]
    db().set('deployOutcomes', { ...(db().get('deployOutcomes') ?? {}), [gameId]: summary })
    if (report.outcome === 'verified' || report.outcome === 'nothing') await cleanupRetired(gameId).catch(() => {})
    forgetInspection(gameId)
    return report
  })
}

export function purgeGame(gameId: string): Promise<DeployReport> {
  return withLock(gameId, async () => {
    const game = requireGame(gameId)
    const manifest = await readManifest(paths.deployManifest(gameId))
    const ctx = await inspectGame(gameId, true).catch(() => undefined)
    const env = integrationEnv()
    const targets = Object.fromEntries(Object.entries(manifest?.targets ?? { game: game.modding.targetDir }).map(([id, dir]) => [id, { dir, userData: ctx?.info.targets.find((t) => t.id === id)?.userData }]))
    const report = await applyDeployment({
      gameId,
      profileId: manifest?.profileId ?? '',
      targets,
      strategy: manifest?.strategy ?? game.modding.strategy,
      plan: EMPTY_PLAN,
      manifestPath: paths.deployManifest(gameId),
      backupDir: paths.backups(gameId),
      overwriteDir: paths.overwrite(gameId),
      onProgress: (p) => reportProgress(gameId, p),
      log,
      precheck: () => runningCheck(game, [game.installDir]),
      configure: ctx?.integration.configure ? (m) => ctx.integration.configure!(game, ctx.info, m, listMods(gameId), env, loaderHost) : undefined
    })
    db().set('deployOutcomes', { ...(db().get('deployOutcomes') ?? {}), [gameId]: summarize(report) })
    forgetInspection(gameId)
    return report
  })
}

export async function lastOutcome(gameId: string): Promise<DeployOutcomeSummary | undefined> {
  return db().get('deployOutcomes')?.[gameId]
}

export async function deployStatus(gameId: string): Promise<DeployStatus> {
  const manifest = await readManifest(paths.deployManifest(gameId))
  const methods = { symlink: 0, hardlink: 0, copy: 0 }
  for (const e of manifest?.entries ?? []) methods[e.method]++
  const { plan, ctx, excluded, order } = await planFor(gameId)
  const profile = await activeProfile(gameId)
  const enabled = new Set(profile.enabled)
  const deployed = Boolean(manifest && manifest.entries.length)
  const inSync = deployed ? manifest!.planHash === plan.hash : plan.entries.size === 0
  const last = db().get('deployOutcomes')?.[gameId]
  const perMod: Record<string, ModDeployState> = {}
  const live = new Set((manifest?.entries ?? []).map((e) => e.modId))
  const wanted = new Set([...plan.entries.values()].map((e) => e.modId))
  for (const id of order) {
    if (!enabled.has(id)) {
      perMod[id] = 'disabled'
      continue
    }
    const ex = excluded.get(id)
    if (ex) {
      perMod[id] = ex.state
      continue
    }
    if (live.has(id)) {
      // "verified" only when the integration checked that the game loads it; plain file deployments are "deployed".
      perMod[id] = inSync && manifest?.verified?.ok && manifest.verified.loadVerified ? 'verified' : inSync ? 'deployed' : 'prepared'
    } else if (wanted.has(id) && last && (last.outcome === 'failed' || last.outcome === 'rolled_back')) {
      perMod[id] = last.outcome
    } else {
      perMod[id] = wanted.has(id) ? 'prepared' : 'deployed'
    }
  }
  return {
    gameId,
    deployed,
    inSync,
    fileCount: manifest?.entries.length ?? 0,
    methods,
    deployedAt: manifest?.deployedAt,
    profileId: manifest?.profileId,
    targets: ctx.info.targets,
    last,
    perMod,
    interrupted: await hasInterruptedDeployment(paths.deployManifest(gameId))
  }
}

export async function probeGame(gameId: string): Promise<LinkCapabilities> {
  const game = requireGame(gameId)
  const info = await integrationInfo(gameId).catch(() => undefined)
  let target = info?.targets.find((t) => t.id === 'game')?.dir ?? game.modding.targetDir
  while (!(await isDir(target)) && dirname(target) !== target) target = dirname(target)
  return probeLinks(paths.modStaging(gameId), target)
}

/** Purges deployed files, then deletes the game's mods and profiles. */
export async function forgetGameMods(gameId: string): Promise<void> {
  const manifest = await readManifest(paths.deployManifest(gameId))
  if (manifest?.entries.length) {
    const r = await purgeGame(gameId)
    if (r.outcome === 'failed' || r.outcome === 'rolled_back') throw new Error(`The game still has NexusForge's files: ${r.problem?.detail ?? r.title}`)
  }
  for (const m of listMods(gameId)) await removeStaging(m.stagingDir, gameId)
  const all = allMods()
  delete all[gameId]
  db().set('mods', all)
  await deleteAllProfiles(gameId)
}

/** A short fingerprint of what a game's mods would deploy (tests and logs). */
export async function planFingerprint(gameId: string): Promise<string> {
  const { plan } = await planFor(gameId)
  return createHash('sha1').update(plan.hash).digest('hex').slice(0, 10)
}
