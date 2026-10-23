// The deployment engine. Pure Node (no Electron imports) so it can be unit tested against temp folders.
//
// Invariant: the manifest always describes what NexusForge has put into the game folder. Files are only
// ever deleted when they are provably ours (same symlink target / same hardlink file id / same size+mtime
// for copies). Anything else found at a deployed path is moved to the overwrite folder, and original game
// files that a mod replaces are moved to the backup folder and restored on purge.

import { promises as fsp, constants as fsc } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import type { DeployManifest, DeployManifestEntry, DeployMethod, DeployProgress, DeployReport, DeployStrategy } from '@shared/types'
import { relKey, type DeployPlan, type PlanEntry } from './plan'
import { moveFile, readJson, writeJsonAtomic } from '../util/fs'

export interface EngineLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface DeployOptions {
  gameId: string
  profileId: string
  targetDir: string
  strategy: DeployStrategy
  plan: DeployPlan
  manifestPath: string
  backupDir: string
  overwriteDir: string
  onProgress?: (p: Omit<DeployProgress, 'gameId'>) => void
  log?: EngineLogger
}

const silent: EngineLogger = { info() {}, warn() {}, error() {} }

export const EMPTY_PLAN: DeployPlan = { entries: new Map(), conflicts: [], hash: 'empty' }

export async function readManifest(path: string): Promise<DeployManifest | undefined> {
  const m = await readJson<DeployManifest>(path)
  return m && m.version === 1 && Array.isArray(m.entries) ? m : undefined
}

function stripLongPrefix(p: string): string {
  return p.startsWith('\\\\?\\') ? p.slice(4) : p
}

function samePath(a: string, b: string): boolean {
  return normalize(stripLongPrefix(a)).toLowerCase() === normalize(stripLongPrefix(b)).toLowerCase()
}

function targetPath(targetDir: string, rel: string): string {
  const abs = resolve(targetDir, ...rel.split('/'))
  const root = resolve(targetDir)
  if (abs.toLowerCase() !== root.toLowerCase() && !abs.toLowerCase().startsWith(root.toLowerCase() + sep)) {
    throw new Error(`Refusing to write outside the target folder: ${rel}`)
  }
  return abs
}

type DeployedState = 'ours' | 'missing' | 'modified'

export async function deployedState(abs: string, e: DeployManifestEntry): Promise<DeployedState> {
  let st
  try {
    st = await fsp.lstat(abs, { bigint: true })
  } catch {
    return 'missing'
  }
  if (e.method === 'symlink') {
    if (!st.isSymbolicLink()) return 'modified'
    try {
      return samePath(await fsp.readlink(abs), e.source) ? 'ours' : 'modified'
    } catch {
      return 'modified'
    }
  }
  if (st.isSymbolicLink()) return 'modified'
  if (e.method === 'hardlink') return e.ino !== undefined && String(st.ino) === e.ino ? 'ours' : 'modified'
  return Number(st.size) === e.size && Math.abs(Number(st.mtimeMs) - e.mtimeMs) < 2000 ? 'ours' : 'modified'
}

async function sourceUnchanged(e: DeployManifestEntry, want: PlanEntry): Promise<boolean> {
  if (!samePath(e.source, want.source) || e.size !== want.size) return false
  if (e.method === 'symlink') return true
  try {
    const st = await fsp.stat(want.source, { bigint: true })
    if (e.method === 'hardlink') return String(st.ino) === e.ino
    return e.srcMtimeMs === undefined || Math.abs(Number(st.mtimeMs) - e.srcMtimeMs) < 2000
  } catch {
    return false
  }
}

async function uniquePath(p: string): Promise<string> {
  let candidate = p
  for (let i = 1; ; i++) {
    try {
      await fsp.lstat(candidate)
      candidate = `${p}.${i}`
    } catch {
      return candidate
    }
  }
}

interface LinkState {
  symlink: boolean
  hardlink: boolean
}

const SYMLINK_FALLBACK = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN', 'EISDIR'])
const HARDLINK_FALLBACK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EINVAL', 'EMLINK', 'UNKNOWN'])

async function placeFile(src: string, dst: string, state: LinkState, fallbacks: Set<string>): Promise<DeployMethod> {
  if (state.symlink) {
    try {
      await fsp.symlink(src, dst, 'file')
      return 'symlink'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      if (!SYMLINK_FALLBACK.has(code)) throw err
      state.symlink = false
      fallbacks.add(
        code === 'EPERM'
          ? 'Symlinks need Windows Developer Mode or admin rights, so NexusForge fell back to hardlinks/copies.'
          : `Symlinks are not supported here (${code}); fell back to hardlinks/copies.`
      )
    }
  }
  if (state.hardlink) {
    try {
      await fsp.link(src, dst)
      return 'hardlink'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      if (!HARDLINK_FALLBACK.has(code)) throw err
      state.hardlink = false
      fallbacks.add(
        code === 'EXDEV'
          ? 'Mod storage is on a different drive than the game, so files were copied. Put mod storage on the game drive to use links.'
          : `Hardlinks are not supported here (${code}); files were copied.`
      )
    }
  }
  await fsp.copyFile(src, dst, fsc.COPYFILE_EXCL)
  return 'copy'
}

/** Creates missing parent folders and returns the ones it created (relative to targetDir, forward slashes). */
async function ensureParent(targetDir: string, abs: string): Promise<string[]> {
  const created: string[] = []
  const missing: string[] = []
  let dir = dirname(abs)
  const root = resolve(targetDir).toLowerCase()
  while (dir.toLowerCase() !== root && dir.toLowerCase().startsWith(root)) {
    try {
      await fsp.stat(dir)
      break
    } catch {
      missing.push(dir)
      dir = dirname(dir)
    }
  }
  if (!missing.length) return created
  await fsp.mkdir(dirname(abs), { recursive: true })
  for (const m of missing) created.push(relative(targetDir, m).split(sep).join('/'))
  return created
}

function emptyMethods(): Record<DeployMethod, number> {
  return { symlink: 0, hardlink: 0, copy: 0 }
}

/**
 * Brings the target folder in line with `plan`, touching only what changed since the last deployment.
 * Deploying an empty plan is a purge.
 */
export async function applyDeployment(opts: DeployOptions): Promise<DeployReport> {
  const started = Date.now()
  const log = opts.log ?? silent
  const progress = opts.onProgress ?? (() => {})
  const report: DeployReport = {
    gameId: opts.gameId,
    placed: 0,
    removed: 0,
    unchanged: 0,
    backedUp: 0,
    rescued: 0,
    methods: emptyMethods(),
    fallbacks: [],
    errors: [],
    durationMs: 0
  }
  const addError = (msg: string) => {
    log.warn(msg)
    if (report.errors.length < 50) report.errors.push(msg)
  }

  let old = await readManifest(opts.manifestPath)

  // Target folder changed since the last deploy: clean the old location completely first.
  if (old && !samePath(old.targetDir, opts.targetDir)) {
    log.info(`target changed from ${old.targetDir} to ${opts.targetDir}; purging old location`)
    const purge = await applyDeployment({ ...opts, targetDir: old.targetDir, plan: EMPTY_PLAN, onProgress: undefined })
    report.removed += purge.removed
    report.rescued += purge.rescued
    report.errors.push(...purge.errors)
    old = undefined
  }

  progress({ phase: 'planning', done: 0, total: opts.plan.entries.size })
  const strategyChanged = Boolean(old && old.strategy !== opts.strategy)
  const oldEntries = new Map<string, DeployManifestEntry>((old?.entries ?? []).map((e) => [relKey(e.rel), e]))
  const keep: DeployManifestEntry[] = []
  const toRemove: DeployManifestEntry[] = []
  const toPlace: PlanEntry[] = []
  const carriedBackup = new Map<string, string>()

  for (const [key, e] of oldEntries) {
    const want = opts.plan.entries.get(key)
    if (!want) {
      toRemove.push(e)
      continue
    }
    const unchanged =
      !strategyChanged &&
      want.modId === e.modId &&
      (await sourceUnchanged(e, want)) &&
      (await deployedState(targetPath(old!.targetDir, e.rel), e)) === 'ours'
    if (unchanged) {
      keep.push(e)
      report.unchanged++
    } else {
      toRemove.push(e)
      toPlace.push(want)
      if (e.backup) carriedBackup.set(key, e.backup)
    }
  }
  for (const [key, want] of opts.plan.entries) if (!oldEntries.has(key)) toPlace.push(want)

  // --- remove -------------------------------------------------------------
  let done = 0
  const total = toRemove.length + toPlace.length
  const failedRemoval = new Set<string>()
  for (const e of toRemove) {
    const key = relKey(e.rel)
    try {
      const abs = targetPath(opts.targetDir, e.rel)
      const state = await deployedState(abs, e)
      if (state === 'ours') {
        await fsp.unlink(abs)
        report.removed++
      } else if (state === 'modified') {
        const dest = await uniquePath(join(opts.overwriteDir, ...e.rel.split('/')))
        await moveFile(abs, dest)
        report.rescued++
        log.warn(`${e.rel} was changed after deployment; moved to ${dest}`)
      }
      if (e.backup && !opts.plan.entries.has(key)) {
        try {
          await fsp.lstat(abs)
          addError(`Could not restore original ${e.rel}: something else is at that path. The original is kept at ${e.backup}`)
        } catch {
          try {
            await moveFile(e.backup, abs)
          } catch (err) {
            addError(`Could not restore original ${e.rel}: ${(err as Error).message}`)
          }
        }
      }
    } catch (err) {
      addError(`Failed to remove ${e.rel}: ${(err as Error).message}`)
      // Keep tracking it so a later run can retry, and don't place over it.
      keep.push(e)
      failedRemoval.add(key)
    }
    if (++done % 50 === 0) progress({ phase: 'removing', done, total })
  }

  // --- place --------------------------------------------------------------
  const linkState: LinkState = { symlink: opts.strategy === 'symlink', hardlink: opts.strategy !== 'copy' }
  const fallbacks = new Set<string>()
  const createdDirs = new Set<string>(old?.createdDirs ?? [])
  const placed: DeployManifestEntry[] = []
  const flush = async () => {
    await writeJsonAtomic(opts.manifestPath, manifestOf([...keep, ...placed]))
  }
  const manifestOf = (entries: DeployManifestEntry[]): DeployManifest => ({
    version: 1,
    gameId: opts.gameId,
    profileId: opts.profileId,
    targetDir: opts.targetDir,
    strategy: opts.strategy,
    deployedAt: Date.now(),
    planHash: opts.plan.hash,
    entries,
    createdDirs: [...createdDirs]
  })

  if (toPlace.length) await flush()
  for (const want of toPlace) {
    if (failedRemoval.has(want.key)) continue
    try {
      const abs = targetPath(opts.targetDir, want.rel)
      for (const d of await ensureParent(opts.targetDir, abs)) createdDirs.add(d)
      let backup = carriedBackup.get(want.key)
      let occupied = false
      try {
        await fsp.lstat(abs)
        occupied = true
      } catch {
        // free
      }
      if (occupied) {
        if (backup) {
          const dest = await uniquePath(join(opts.overwriteDir, ...want.rel.split('/')))
          await moveFile(abs, dest)
          report.rescued++
        } else {
          backup = await uniquePath(join(opts.backupDir, ...want.rel.split('/')))
          await moveFile(abs, backup)
          report.backedUp++
        }
      }
      const method = await placeFile(want.source, abs, linkState, fallbacks)
      const st = await fsp.lstat(abs, { bigint: true })
      const srcSt = await fsp.stat(want.source, { bigint: true })
      placed.push({
        rel: want.rel,
        modId: want.modId,
        source: want.source,
        method,
        backup,
        size: want.size,
        mtimeMs: Number(st.mtimeMs),
        ino: method === 'hardlink' ? String(st.ino) : undefined,
        srcMtimeMs: Number(srcSt.mtimeMs)
      })
      report.placed++
    } catch (err) {
      addError(`Failed to deploy ${want.rel}: ${(err as Error).message}`)
    }
    done++
    if (done % 50 === 0) progress({ phase: 'linking', done, total })
    if (placed.length % 500 === 0) await flush()
  }

  // --- finish -------------------------------------------------------------
  progress({ phase: 'finishing', done: total, total })
  const finalEntries = [...keep, ...placed]
  const liveDirs = new Set<string>()
  for (const e of finalEntries) {
    const parts = relKey(e.rel).split('/')
    for (let i = 1; i < parts.length; i++) liveDirs.add(parts.slice(0, i).join('/'))
  }
  const deepestFirst = [...createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const d of deepestFirst) {
    if (liveDirs.has(d.toLowerCase())) continue
    try {
      await fsp.rmdir(targetPath(opts.targetDir, d))
      createdDirs.delete(d)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') createdDirs.delete(d)
      // ENOTEMPTY: the game put its own files there; leave it.
    }
  }

  if (finalEntries.length) {
    await writeJsonAtomic(opts.manifestPath, manifestOf(finalEntries))
  } else {
    await fsp.rm(opts.manifestPath, { force: true })
  }
  for (const e of finalEntries) report.methods[e.method]++
  report.fallbacks = [...fallbacks]
  report.durationMs = Date.now() - started
  log.info(
    `deploy ${opts.gameId}: placed ${report.placed}, removed ${report.removed}, unchanged ${report.unchanged}, backed up ${report.backedUp}, rescued ${report.rescued}, errors ${report.errors.length} in ${report.durationMs}ms`
  )
  return report
}
