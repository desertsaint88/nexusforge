import { shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ConflictReport, DeployReport, DeployStatus, InstalledMod, LinkCapabilities, ModFileEntry, ModSourceRef } from '@shared/types'
import { db } from '../store'
import { paths } from '../paths'
import { emit } from '../events'
import { scoped } from '../logger'
import { dirSize, exists, isDir, safeName, safeReaddir, shortId, walkFiles } from '../util/fs'
import { getGame } from '../library/library'
import { findPreset } from '../library/presets'
import { extractArchive, isArchive } from './archive'
import { applyThunderstoreLayout, detectRoot, readThunderstoreManifest } from './layout'
import { buildPlan, conflictReport, type DeployPlan, type PlanMod } from './plan'
import { applyDeployment, EMPTY_PLAN, readManifest } from './deploy'
import { probeLinks } from './links'
import { activeProfile, addModToProfiles, deleteAllProfiles, listProfiles, saveProfile } from './profiles'

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

function requireGame(gameId: string) {
  const g = getGame(gameId)
  if (!g) throw new Error('Game not found')
  return g
}

// ---------------------------------------------------------------------------
// File index

const fileCache = new Map<string, ModFileEntry[]>()

export async function modFiles(mod: InstalledMod): Promise<ModFileEntry[]> {
  const key = `${mod.id}:${mod.updatedAt}:${mod.rootPath}`
  const hit = fileCache.get(key)
  if (hit) return hit
  const files = (await walkFiles(join(mod.stagingDir, ...mod.rootPath.split('/').filter(Boolean)))).map((f) => ({ rel: f.rel, size: f.size }))
  fileCache.set(key, files)
  return files
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
}

export async function installMod(gameId: string, input: string, meta: InstallMeta = {}): Promise<InstalledMod> {
  const game = requireGame(gameId)
  if (!(await exists(input))) throw new Error(`File not found: ${input}`)
  const stagingRoot = paths.modStaging(gameId)
  const id = shortId('m')
  const tmp = join(stagingRoot, `.installing-${id}`)
  log.info(`installing ${input} for ${game.name}`)
  try {
    if (await isDir(input)) {
      await fsp.cp(input, tmp, { recursive: true, errorOnExist: false, force: true })
    } else if (isArchive(input)) {
      await extractArchive(input, tmp)
    } else {
      await fsp.mkdir(tmp, { recursive: true })
      await fsp.copyFile(input, join(tmp, basename(input)))
    }

    const ts = meta.source?.sourceId === 'thunderstore' ? meta.source.modId.replace('/', '-') : undefined
    const tsManifest = await readThunderstoreManifest(tmp)
    let rootPath: string
    if (ts || tsManifest) {
      rootPath = await applyThunderstoreLayout(tmp, ts ?? tsManifest?.name ?? 'plugin')
    } else {
      rootPath = await detectRoot(tmp, basename(game.modding.targetDir), findPreset(game)?.keepWrapper)
    }

    const guessed = (await isDir(input)) ? { name: basename(input) } : isArchive(input) ? nameFromArchive(input) : { name: basename(input, extname(input)) }
    const name = meta.name ?? tsManifest?.name?.replace(/_/g, ' ') ?? guessed.name
    const version = meta.version ?? tsManifest?.version_number ?? guessed.version

    const finalDir = join(stagingRoot, `${safeName(name)}_${id.slice(2, 8)}`)
    await fsp.rename(tmp, finalDir)
    const { bytes, files } = await dirSize(join(finalDir, ...rootPath.split('/').filter(Boolean)))
    if (files === 0) throw new Error('The archive contains no files.')

    // Installing a mod that is already installed from the same source replaces it in place.
    const previous = meta.source
      ? listMods(gameId).find((m) => m.source?.sourceId === meta.source!.sourceId && m.source?.modId === meta.source!.modId)
      : undefined

    const mod: InstalledMod = {
      id: previous?.id ?? id,
      gameId,
      name: previous?.name && !meta.name ? previous.name : name,
      version,
      author: meta.author ?? previous?.author,
      summary: meta.summary ?? tsManifest?.description ?? previous?.summary,
      thumbnail: meta.thumbnail ?? previous?.thumbnail,
      source: meta.source ?? previous?.source,
      stagingDir: finalDir,
      rootPath,
      installedAt: previous?.installedAt ?? Date.now(),
      updatedAt: Date.now(),
      sizeBytes: bytes,
      fileCount: files,
      originalFile: (await isDir(input)) ? undefined : basename(input)
    }
    saveMod(mod)
    if (previous) {
      log.info(`updated ${mod.name} ${previous.version ?? ''} -> ${version ?? ''}`)
      await removeStaging(previous.stagingDir, gameId)
    } else {
      await addModToProfiles(gameId, mod.id)
    }
    emit('mods:changed', { gameId })
    return mod
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    log.error(`install failed for ${input}`, err)
    throw err
  }
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
  if (manifest?.entries.some((e) => e.modId === modId)) await deployGame(gameId)
  await removeStaging(mod.stagingDir, gameId)
  log.info(`removed mod ${mod.name}`)
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
    mod.rootPath = root
    const { bytes, files } = await dirSize(join(mod.stagingDir, ...root.split('/').filter(Boolean)))
    mod.sizeBytes = bytes
    mod.fileCount = files
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

async function planFor(gameId: string): Promise<{ plan: DeployPlan; profileId: string; order: string[] }> {
  const game = requireGame(gameId)
  const profile = await activeProfile(gameId)
  const mods = allMods()[gameId] ?? {}
  const enabled = new Set(profile.enabled)
  const planMods: PlanMod[] = []
  for (const id of profile.order) {
    const mod = mods[id]
    if (!mod || !enabled.has(id)) continue
    planMods.push({ id, root: join(mod.stagingDir, ...mod.rootPath.split('/').filter(Boolean)), revision: mod.updatedAt, files: await modFiles(mod) })
  }
  const plan = buildPlan(planMods, profile.fileOverrides, `${game.modding.targetDir.toLowerCase()}|${game.modding.strategy}`)
  return { plan, profileId: profile.id, order: profile.order }
}

export async function getConflicts(gameId: string): Promise<ConflictReport> {
  const { plan, profileId, order } = await planFor(gameId)
  return conflictReport(plan, gameId, profileId, order)
}

const locks = new Map<string, Promise<unknown>>()

function withLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(gameId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  locks.set(gameId, next)
  void next.finally(() => {
    if (locks.get(gameId) === next) locks.delete(gameId)
  })
  return next
}

async function ensureTarget(dir: string): Promise<void> {
  if (await isDir(dir)) return
  if (await isDir(dirname(dir))) {
    await fsp.mkdir(dir)
    return
  }
  throw new Error(`The deploy folder does not exist: ${dir}. Pick another one in the game settings.`)
}

export function deployGame(gameId: string): Promise<DeployReport> {
  return withLock(gameId, async () => {
    const game = requireGame(gameId)
    await ensureTarget(game.modding.targetDir)
    const { plan, profileId } = await planFor(gameId)
    return applyDeployment({
      gameId,
      profileId,
      targetDir: game.modding.targetDir,
      strategy: game.modding.strategy,
      plan,
      manifestPath: paths.deployManifest(gameId),
      backupDir: paths.backups(gameId),
      overwriteDir: paths.overwrite(gameId),
      onProgress: (p) => emit('deploy:progress', { gameId, ...p }),
      log
    })
  })
}

export function purgeGame(gameId: string): Promise<DeployReport> {
  return withLock(gameId, async () => {
    const game = requireGame(gameId)
    const manifest = await readManifest(paths.deployManifest(gameId))
    return applyDeployment({
      gameId,
      profileId: manifest?.profileId ?? '',
      targetDir: manifest?.targetDir ?? game.modding.targetDir,
      strategy: manifest?.strategy ?? game.modding.strategy,
      plan: EMPTY_PLAN,
      manifestPath: paths.deployManifest(gameId),
      backupDir: paths.backups(gameId),
      overwriteDir: paths.overwrite(gameId),
      onProgress: (p) => emit('deploy:progress', { gameId, ...p }),
      log
    })
  })
}

export async function deployStatus(gameId: string): Promise<DeployStatus> {
  const manifest = await readManifest(paths.deployManifest(gameId))
  const methods = { symlink: 0, hardlink: 0, copy: 0 }
  for (const e of manifest?.entries ?? []) methods[e.method]++
  const { plan } = await planFor(gameId)
  const deployed = Boolean(manifest && manifest.entries.length)
  return {
    gameId,
    deployed,
    inSync: deployed ? manifest!.planHash === plan.hash : plan.entries.size === 0,
    fileCount: manifest?.entries.length ?? 0,
    methods,
    deployedAt: manifest?.deployedAt,
    profileId: manifest?.profileId
  }
}

export async function probeGame(gameId: string): Promise<LinkCapabilities> {
  const game = requireGame(gameId)
  let target = game.modding.targetDir
  while (!(await isDir(target)) && dirname(target) !== target) target = dirname(target)
  return probeLinks(paths.modStaging(gameId), target)
}

/** Purges deployed files, then deletes the game's mods and profiles. */
export async function forgetGameMods(gameId: string): Promise<void> {
  const manifest = await readManifest(paths.deployManifest(gameId))
  if (manifest?.entries.length) await purgeGame(gameId)
  for (const m of listMods(gameId)) await removeStaging(m.stagingDir, gameId)
  const all = allMods()
  delete all[gameId]
  db().set('mods', all)
  await deleteAllProfiles(gameId)
}
