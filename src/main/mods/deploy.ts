// The deployment engine. Pure Node (no Electron imports) so it can be unit tested against temp folders.
//
// A deployment brings one or more target folders (the game folder, a mods folder in Documents, a save folder)
// in line with a plan, in stages: preflight checks -> remove what is no longer wanted -> place new files ->
// configure (loader lists) -> verify -> record. When any stage fails, the previous deployment is put back
// (rollback). A journal written before the first change lets a deployment that was cut off (crash, power loss)
// be rolled back on the next run.
//
// Invariant: the manifest always describes what NexusForge has put into the targets. Files are only ever
// deleted when they are provably ours (same symlink target / same file id / same size+mtime for copies).
// Anything else found at a deployed path is moved to the overwrite folder (in save folders it stays where it
// is), and original files a mod replaces are moved to the backup folder and restored on purge.

import { createReadStream, promises as fsp, constants as fsc } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, normalize, parse, relative, resolve, sep } from 'node:path'
import type {
  DeployManifest,
  DeployManifestEntry,
  DeployMethod,
  DeployProblem,
  DeployProgress,
  DeployReport,
  DeployStage,
  DeployStrategy,
  VerifyCheck
} from '@shared/types'
import { entryKey, relKey, type DeployPlan, type PlanEntry } from './plan'
import { moveFile, readJson, writeJsonAtomic } from '../util/fs'

export interface EngineLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface TargetSpec {
  dir: string
  label?: string
  /** Save folders: always copies, and files the game changed are never removed. */
  userData?: boolean
  /** The folder may be created (recursively) when it doesn't exist yet. */
  create?: boolean
}

export interface DeployOptions {
  gameId: string
  profileId: string
  targets: Record<string, TargetSpec>
  strategy: DeployStrategy
  plan: DeployPlan
  manifestPath: string
  backupDir: string
  overwriteDir: string
  onProgress?: (p: Omit<DeployProgress, 'gameId'>) => void
  log?: EngineLogger
  signal?: AbortSignal
  /** Refuses to start, e.g. while the game is running. */
  precheck?: () => Promise<DeployProblem | undefined>
  /** Runs after the files are in place, and again after a rollback (loader config such as enabled.json). */
  configure?: (manifest: DeployManifest) => Promise<void>
  /** Integration checks after the file checks; a failed 'error' check rolls the deployment back. */
  verifyExtra?: (manifest: DeployManifest) => Promise<VerifyCheck[]>
  /** The integration knows how the game loads these files (shown as "verified" rather than "files in place"). */
  loadVerifiable?: boolean
  /** Put the previous deployment back when anything fails (default true). */
  rollback?: boolean
  /** Copied files are compared byte for byte up to this many bytes per deployment (default 512 MB). */
  hashBudgetBytes?: number
  /** Waits between retries of a locked file, in ms. */
  retryDelays?: number[]
}

const silent: EngineLogger = { info() {}, warn() {}, error() {} }

export const EMPTY_PLAN: DeployPlan = { entries: new Map(), conflicts: [], hash: 'empty' }

/** A failure with an explanation for the user. */
export class DeployError extends Error {
  constructor(public problem: DeployProblem) {
    super(problem.detail)
  }
}

const journalPath = (manifestPath: string) => `${manifestPath}.journal`

// ---------------------------------------------------------------------------
// Manifest

interface ManifestV1 {
  version: 1
  gameId: string
  profileId: string
  targetDir: string
  strategy: DeployStrategy
  deployedAt: number
  planHash: string
  entries: Array<Omit<DeployManifestEntry, 'target'>>
  createdDirs: string[]
}

/** Reads a manifest; ones written before deploy targets existed describe the game folder ('game'). */
export async function readManifest(path: string): Promise<DeployManifest | undefined> {
  const m = await readJson<DeployManifest | ManifestV1>(path)
  if (!m || !Array.isArray(m.entries)) return undefined
  if (m.version === 2) return m
  if (m.version === 1 && typeof m.targetDir === 'string') {
    return {
      version: 2,
      gameId: m.gameId,
      profileId: m.profileId,
      targets: { game: m.targetDir },
      strategy: m.strategy,
      deployedAt: m.deployedAt,
      planHash: m.planHash,
      entries: m.entries.map((e) => ({ ...e, target: 'game' })),
      createdDirs: (m.createdDirs ?? []).map((d) => `game|${d}`)
    }
  }
  return undefined
}

/** The plan that reproduces a manifest (used to roll back to it). */
export function planFromManifest(m: DeployManifest | undefined): DeployPlan {
  if (!m) return EMPTY_PLAN
  const entries = new Map<string, PlanEntry>()
  for (const e of m.entries) {
    const key = entryKey(e.target, e.rel)
    entries.set(key, { key, target: e.target, rel: e.rel, modId: e.modId, source: e.source, size: e.size })
  }
  return { entries, conflicts: [], hash: m.planHash }
}

// ---------------------------------------------------------------------------
// Paths and file state

function stripLongPrefix(p: string): string {
  return p.startsWith('\\\\?\\') ? p.slice(4) : p
}

function samePath(a: string, b: string): boolean {
  return normalize(stripLongPrefix(a)).toLowerCase() === normalize(stripLongPrefix(b)).toLowerCase()
}

export function targetPath(targetDir: string, rel: string): string {
  const abs = resolve(targetDir, ...rel.split('/'))
  const root = resolve(targetDir)
  if (abs.toLowerCase() !== root.toLowerCase() && !abs.toLowerCase().startsWith(root.toLowerCase().replace(/[\\/]+$/, '') + sep)) {
    throw new DeployError({
      code: 'unsafe_path',
      title: 'A mod file points outside its folder',
      detail: `Refusing to write outside the target folder: ${rel}`,
      advice: ['Remove this mod; its package is malformed or unsafe.'],
      paths: [rel]
    })
  }
  return abs
}

type DeployedState = 'ours' | 'missing' | 'modified'

export async function deployedState(abs: string, e: Pick<DeployManifestEntry, 'method' | 'source' | 'ino' | 'size' | 'mtimeMs'>): Promise<DeployedState> {
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p)
    return true
  } catch {
    return false
  }
}

async function sha1(file: string): Promise<string> {
  const h = createHash('sha1')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Antivirus scanners and indexers hold freshly written files for a moment; a game or editor holds them longer.
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

async function withRetry<T>(fn: () => Promise<T>, delays: number[], onRetry?: (err: NodeJS.ErrnoException) => Promise<void>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT.has(code) || i >= delays.length) throw err
      await onRetry?.(err as NodeJS.ErrnoException).catch(() => {})
      await sleep(delays[i])
    }
  }
}

/** Deletes a file, clearing a read-only flag if that is what stops it. */
async function removeFile(abs: string, delays: number[]): Promise<void> {
  await withRetry(() => fsp.unlink(abs), delays, async (err) => {
    if (err.code === 'EPERM' || err.code === 'EACCES') await fsp.chmod(abs, 0o666)
  })
}

// ---------------------------------------------------------------------------
// Problems

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code
}

function problemFor(err: unknown, action: string, path?: string): DeployProblem {
  if (err instanceof DeployError) return err.problem
  const code = errCode(err)
  const msg = (err as Error)?.message ?? String(err)
  const paths = path ? [path] : undefined
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return {
      code: 'locked',
      title: 'A file is in use or protected',
      detail: `Windows refused to ${action}${path ? ` ${path}` : ''} (${code}). It is usually open in the game or another program.`,
      advice: ['Close the game and any tool that uses its files, then deploy again.', 'If it keeps happening, restart the PC once: a crashed game can keep files locked.'],
      paths
    }
  }
  if (code === 'ENOSPC') {
    return { code: 'disk_full', title: 'The drive is full', detail: `Not enough free space to ${action}${path ? ` ${path}` : ''}.`, advice: ['Free up space on that drive and deploy again.'], paths }
  }
  if (code === 'ENOENT') {
    return {
      code: 'source_missing',
      title: 'A file is missing',
      detail: `${path ?? 'A file'} could not be found while trying to ${action}: ${msg}`,
      advice: ['Reinstall the mod from the Mods list (its files in NexusForge storage are incomplete).'],
      paths
    }
  }
  if (code === 'ENAMETOOLONG') {
    return { code: 'path_too_long', title: 'A path is too long', detail: `${path ?? 'A path'} is longer than Windows allows here.`, advice: ['Move the game or NexusForge storage to a shorter folder path.'], paths }
  }
  if ((err as Error)?.name === 'AbortError' || code === 'ABORT_ERR') {
    return { code: 'cancelled', title: 'Deployment cancelled', detail: 'You cancelled the deployment.', advice: [] }
  }
  return { code: 'error', title: 'Deployment failed', detail: `Could not ${action}${path ? ` ${path}` : ''}: ${msg}`, advice: ['Open the log (Settings › About) for details and deploy again.'], paths }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeployError({ code: 'cancelled', title: 'Deployment cancelled', detail: 'You cancelled the deployment.', advice: [] })
}

// ---------------------------------------------------------------------------
// Placing files

interface TargetCaps {
  dir: string
  label: string
  userData: boolean
  /** Volume serial number of the target folder (stat dev). */
  dev?: bigint
  symlink?: boolean
}

async function probeSymlink(dir: string): Promise<boolean> {
  const tag = randomBytes(4).toString('hex')
  const src = join(dir, `.nf-probe-${tag}.src`)
  const link = join(dir, `.nf-probe-${tag}.lnk`)
  try {
    await fsp.writeFile(src, 'probe')
    await fsp.symlink(src, link, 'file')
    return true
  } catch {
    return false
  } finally {
    await Promise.allSettled([fsp.unlink(link), fsp.unlink(src)])
  }
}

const devCache = new Map<string, bigint | undefined>()
async function devOf(dir: string): Promise<bigint | undefined> {
  const key = dir.toLowerCase()
  if (devCache.has(key)) return devCache.get(key)
  let d: bigint | undefined
  try {
    d = (await fsp.stat(dir, { bigint: true })).dev
  } catch {
    d = undefined
  }
  devCache.set(key, d)
  return d
}

function driveOf(p: string): string {
  return parse(resolve(p)).root.replace(/[\\/]+$/, '') || p
}

class MethodPicker {
  readonly notes = new Set<string>()
  constructor(private strategy: DeployStrategy) {}

  async pick(caps: TargetCaps, source: string): Promise<DeployMethod> {
    if (caps.userData || this.strategy === 'copy') return 'copy'
    const sameVolume = caps.dev !== undefined && caps.dev === (await devOf(dirname(source)))
    if (this.strategy === 'symlink') {
      caps.symlink ??= await probeSymlink(caps.dir)
      if (caps.symlink) return 'symlink'
      this.notes.add(
        'Symlinks need the Windows right "Create symbolic links", which Windows only gives to administrators or when Developer Mode is on. ' +
          'NexusForge used hardlinks and copies instead; the game sees exactly the same files, so nothing needs changing.'
      )
    }
    if (sameVolume) return 'hardlink'
    this.notes.add(`Copied into ${caps.label}: mod storage is on ${driveOf(source)} and ${caps.label} on ${driveOf(caps.dir)}, and links only work within one drive.`)
    return 'copy'
  }

  /** The planned link didn't work on this file system; copies always do. */
  fallback(method: DeployMethod, err: unknown, caps: TargetCaps): DeployMethod | undefined {
    const code = errCode(err) ?? 'UNKNOWN'
    if (method === 'symlink' && ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN', 'EISDIR'].includes(code)) {
      caps.symlink = false
      this.notes.add('Symlinks were refused by Windows; NexusForge used hardlinks and copies instead (the game sees the same files).')
      return 'hardlink'
    }
    if (method === 'hardlink' && ['EXDEV', 'EPERM', 'ENOTSUP', 'EINVAL', 'EMLINK', 'UNKNOWN'].includes(code)) {
      this.notes.add(`The file system of ${caps.label} doesn't support hardlinks (${code}); files were copied.`)
      return 'copy'
    }
    return undefined
  }
}

async function placeFile(src: string, dst: string, method: DeployMethod, caps: TargetCaps, picker: MethodPicker, delays: number[]): Promise<DeployMethod> {
  let m: DeployMethod | undefined = method
  for (;;) {
    try {
      if (m === 'symlink') await fsp.symlink(src, dst, 'file')
      else if (m === 'hardlink') await fsp.link(src, dst)
      else await withRetry(() => fsp.copyFile(src, dst, fsc.COPYFILE_EXCL), delays)
      return m
    } catch (err) {
      const next = picker.fallback(m, err, caps)
      if (!next) throw err
      m = next === 'hardlink' && caps.dev !== (await devOf(dirname(src))) ? 'copy' : next
    }
  }
}

/** Creates missing parent folders and returns the ones it created (relative to targetDir, forward slashes). */
async function ensureParent(targetDir: string, abs: string): Promise<string[]> {
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
  if (!missing.length) return []
  await fsp.mkdir(dirname(abs), { recursive: true })
  return missing.map((m) => relative(targetDir, m).split(sep).join('/'))
}

function emptyMethods(): Record<DeployMethod, number> {
  return { symlink: 0, hardlink: 0, copy: 0 }
}

// ---------------------------------------------------------------------------
// Journal

interface Journal {
  version: 1
  startedAt: number
  /** If the deployment is cut off, the targets are brought back to this. */
  restoreTo: DeployManifest | null
  /** Files that may have been placed but not recorded yet. */
  pending: Array<{ target: string; dir: string; rel: string; source: string }>
  /** Set once the first file was touched (failures before that need no rollback). */
  changing?: boolean
}

async function writeJournal(path: string, j: Journal): Promise<void> {
  await writeJsonAtomic(journalPath(path), j)
}

async function clearJournal(path: string): Promise<void> {
  await fsp.rm(journalPath(path), { force: true })
}

/** A deployment that was cut off left a journal behind. */
export async function hasInterruptedDeployment(manifestPath: string): Promise<boolean> {
  return pathExists(journalPath(manifestPath))
}

/** Files the cut-off run placed but couldn't record yet: recognized by comparing them with their source. */
async function adoptOrphans(current: DeployManifest | undefined, j: Journal, opts: DeployOptions): Promise<DeployManifest | undefined> {
  if (!j.pending.length) return current
  const known = new Set((current?.entries ?? []).map((e) => entryKey(e.target, e.rel)))
  const base: DeployManifest = current ?? {
    version: 2,
    gameId: opts.gameId,
    profileId: opts.profileId,
    targets: {},
    strategy: opts.strategy,
    deployedAt: Date.now(),
    planHash: 'recovered',
    entries: [],
    createdDirs: []
  }
  let adopted = 0
  for (const p of j.pending) {
    if (known.has(entryKey(p.target, p.rel))) continue
    let abs: string
    try {
      abs = targetPath(p.dir, p.rel)
    } catch {
      continue
    }
    let st
    let src
    try {
      st = await fsp.lstat(abs, { bigint: true })
      src = await fsp.stat(p.source, { bigint: true })
    } catch {
      continue
    }
    let method: DeployMethod | undefined
    if (st.isSymbolicLink()) method = samePath(await fsp.readlink(abs).catch(() => ''), p.source) ? 'symlink' : undefined
    else if (st.ino === src.ino) method = 'hardlink'
    else if (st.size === src.size && (await sha1(abs)) === (await sha1(p.source))) method = 'copy'
    if (!method) continue
    if (base.targets[p.target] && !samePath(base.targets[p.target], p.dir)) continue
    base.targets[p.target] = p.dir
    base.entries.push({
      target: p.target,
      rel: p.rel,
      modId: 'recovered',
      source: p.source,
      method,
      size: Number(src.size),
      mtimeMs: Number(st.mtimeMs),
      ino: method === 'hardlink' ? String(st.ino) : undefined,
      srcMtimeMs: Number(src.mtimeMs)
    })
    adopted++
  }
  if (adopted) {
    opts.log?.warn(`recovery: adopted ${adopted} file(s) the interrupted deployment had placed`)
    await writeJsonAtomic(opts.manifestPath, base)
  }
  return base
}

// ---------------------------------------------------------------------------
// The sync itself

interface StageFn {
  /** Starts a stage (the previous one ends successfully). */
  (stage: DeployStage, message?: string): void
  progress(done: number, total: number, message?: string): void
  /** Ends the running stage as failed. */
  fail(): void
  /** Ends the running stage successfully. */
  end(): void
}

interface SyncResult {
  manifest: DeployManifest | undefined
  /** Per-file errors in 'restore' mode (deploy mode throws instead). */
  errors: string[]
  /** Copies placed in this run, for the content check. */
  copied: Array<{ abs: string; source: string; size: number }>
}

interface SyncInput {
  opts: DeployOptions
  targets: Record<string, TargetSpec>
  plan: DeployPlan
  previous: DeployManifest | undefined
  report: DeployReport
  stage: StageFn
  mode: 'deploy' | 'restore'
  journal: Journal
}

async function sync(input: SyncInput): Promise<SyncResult> {
  const { opts, targets, plan, previous, report, stage, mode } = input
  const log = opts.log ?? silent
  const delays = opts.retryDelays ?? [100, 250, 600, 1200]
  const errors: string[] = []
  const fail: (problem: DeployProblem) => never = (problem) => {
    throw new DeployError(problem)
  }

  // --- plan ---------------------------------------------------------------
  stage('plan')
  const oldTargets = previous?.targets ?? {}
  const sameTarget = (id: string) => Boolean(oldTargets[id] && targets[id] && samePath(oldTargets[id], targets[id].dir))
  const strategyChanged = Boolean(previous && previous.strategy !== opts.strategy)
  const oldEntries = new Map<string, DeployManifestEntry>((previous?.entries ?? []).map((e) => [entryKey(e.target, e.rel), e]))
  const keep: DeployManifestEntry[] = []
  const toRemove: DeployManifestEntry[] = []
  const toPlace: PlanEntry[] = []
  const carriedBackup = new Map<string, string>()

  for (const [key, e] of oldEntries) {
    const want = plan.entries.get(key)
    if (!want || !sameTarget(e.target)) {
      toRemove.push(e)
      if (want) toPlace.push(want)
      continue
    }
    const unchanged =
      !strategyChanged &&
      want.modId === e.modId &&
      (await sourceUnchanged(e, want)) &&
      (await deployedState(targetPath(oldTargets[e.target], e.rel), e)) === 'ours'
    if (unchanged) {
      keep.push(e)
      report.unchanged++
    } else {
      toRemove.push(e)
      toPlace.push(want)
      if (e.backup) carriedBackup.set(key, e.backup)
    }
  }
  for (const [key, want] of plan.entries) if (!oldEntries.has(key)) toPlace.push(want)

  // --- preflight ------------------------------------------------------------
  stage('preflight')
  if (mode === 'deploy' && opts.precheck) {
    const p = await opts.precheck()
    if (p) fail(p)
  }
  const caps = new Map<string, TargetCaps>()
  const usedTargets = new Set(toPlace.map((e) => e.target))
  for (const id of usedTargets) {
    const spec = targets[id]
    if (!spec) fail({ code: 'target_missing', title: 'Unknown deploy folder', detail: `No folder is set for "${id}".`, advice: ['Check the game settings.'] })
    const dir = resolve(spec.dir)
    let isDirectory = false
    try {
      isDirectory = (await fsp.stat(dir)).isDirectory()
    } catch {
      // missing
    }
    if (!isDirectory) {
      const parentOk = await fsp
        .stat(dirname(dir))
        .then((s) => s.isDirectory())
        .catch(() => false)
      if (spec.create || parentOk) {
        try {
          await fsp.mkdir(dir, { recursive: true })
        } catch (err) {
          fail({ ...problemFor(err, 'create the folder', dir), code: 'not_writable', title: 'Cannot create the deploy folder' })
        }
      } else {
        fail({
          code: 'target_missing',
          title: 'The deploy folder does not exist',
          detail: `${spec.label ?? id}: ${dir} does not exist (the game may have moved or been uninstalled).`,
          advice: ['Rescan the library, or pick the right folder in the game settings.'],
          paths: [dir]
        })
      }
    }
    // A write test catches folders only administrators may change (C:\Program Files) before anything is touched.
    const probe = join(dir, `.nf-write-${randomBytes(4).toString('hex')}.tmp`)
    try {
      await fsp.writeFile(probe, '')
      await fsp.unlink(probe)
    } catch (err) {
      const code = errCode(err)
      fail({
        code: 'not_writable',
        title: `NexusForge can't write to ${spec.label ?? 'the game folder'}`,
        detail: `Windows denied writing to ${dir} (${code ?? 'error'}).`,
        advice: [
          'Folders under C:\\Program Files can only be changed with administrator rights. Install or move the game to a folder you own (for example a Steam library on another drive), or start NexusForge once with "Run as administrator".',
          'If a security tool (Controlled Folder Access) blocks it, allow NexusForge there.'
        ],
        paths: [dir]
      })
    }
    caps.set(id, { dir, label: spec.label ?? id, userData: Boolean(spec.userData), dev: await devOf(dir) })
  }

  const picker = new MethodPicker(opts.strategy)
  const methods = new Map<string, DeployMethod>()
  const copyBytes = new Map<string, number>()
  for (const want of toPlace) {
    if (mode === 'deploy') checkAbort(opts.signal)
    let st
    try {
      st = await fsp.stat(want.source)
    } catch {
      if (mode === 'restore') continue
      fail({
        code: 'source_missing',
        title: 'Mod files are missing from storage',
        detail: `${want.rel} is no longer in NexusForge's mod storage (${want.source}).`,
        advice: ['Reinstall the mod it belongs to, then deploy again.'],
        paths: [want.source]
      })
    }
    if (!st.isFile()) fail({ code: 'source_missing', title: 'A mod file is not a file', detail: `${want.source} is not a regular file.`, advice: ['Reinstall the mod.'] })
    const c = caps.get(want.target)!
    const m = await picker.pick(c, want.source)
    methods.set(want.key, m)
    if (m === 'copy') copyBytes.set(want.target, (copyBytes.get(want.target) ?? 0) + st.size)
  }
  // Free space, per drive.
  const perDrive = new Map<string, { need: number; dir: string }>()
  for (const [id, bytes] of copyBytes) {
    const c = caps.get(id)!
    const d = driveOf(c.dir).toLowerCase()
    const cur = perDrive.get(d) ?? { need: 0, dir: c.dir }
    cur.need += bytes
    perDrive.set(d, cur)
  }
  for (const [drive, { need, dir }] of perDrive) {
    try {
      const s = await fsp.statfs(dir)
      const free = Number(s.bavail) * Number(s.bsize)
      if (free < need + 64 * 1024 * 1024) {
        fail({
          code: 'disk_full',
          title: `Not enough space on ${drive.toUpperCase()}`,
          detail: `The mods need ${(need / 1024 ** 2).toFixed(0)} MB there, ${(free / 1024 ** 2).toFixed(0)} MB are free.`,
          advice: ['Free up space on that drive, or keep mod storage on the same drive as the game so files are linked instead of copied.'],
          paths: [dir]
        })
      }
    } catch (err) {
      if (err instanceof DeployError) throw err
      // statfs not available for this path: the copy itself reports ENOSPC.
    }
  }

  input.journal.pending = toPlace.map((e) => ({ target: e.target, dir: caps.get(e.target)?.dir ?? targets[e.target]?.dir ?? '', rel: e.rel, source: e.source }))
  input.journal.changing = true
  await writeJournal(opts.manifestPath, input.journal)

  // --- remove -------------------------------------------------------------
  const total = toRemove.length + toPlace.length
  let done = 0
  stage('remove')
  const failedRemoval = new Set<string>()
  const createdDirs = new Set<string>(previous?.createdDirs ?? [])
  const manifestTargets: Record<string, string> = {}
  for (const [id, c] of caps) manifestTargets[id] = c.dir
  const placed: DeployManifestEntry[] = []
  // Entries still to remove stay in the manifest until they are gone.
  const pendingRemoval: DeployManifestEntry[] = [...toRemove]
  const manifestOf = (entries: DeployManifestEntry[]): DeployManifest => {
    const t: Record<string, string> = { ...manifestTargets }
    for (const e of entries) {
      if (!t[e.target]) t[e.target] = targets[e.target]?.dir ?? oldTargets[e.target]
    }
    return {
      version: 2,
      gameId: opts.gameId,
      profileId: opts.profileId,
      targets: t,
      strategy: opts.strategy,
      deployedAt: Date.now(),
      planHash: plan.hash,
      entries,
      createdDirs: [...createdDirs]
    }
  }
  const flush = () => writeJsonAtomic(opts.manifestPath, manifestOf([...keep, ...placed, ...pendingRemoval]))

  for (const e of toRemove) {
    const key = entryKey(e.target, e.rel)
    const oldDir = oldTargets[e.target]
    const userData = Boolean(targets[e.target]?.userData)
    let abs = ''
    try {
      if (mode === 'deploy') checkAbort(opts.signal)
      abs = targetPath(oldDir, e.rel)
      const state = await deployedState(abs, e)
      if (state === 'ours') {
        await removeFile(abs, delays)
        report.removed++
      } else if (state === 'modified') {
        if (userData) {
          // A world or save the game changed: that's the player's progress. Stop managing it, leave it there.
          report.kept++
          log.info(`${e.rel} was changed by the game; left in place`)
        } else {
          const dest = await uniquePath(join(opts.overwriteDir, e.target === 'game' ? '' : e.target, ...e.rel.split('/')))
          await withRetry(() => moveFile(abs, dest), delays)
          report.rescued++
          log.warn(`${e.rel} was changed after deployment; moved to ${dest}`)
        }
      }
      const stillWanted = plan.entries.has(key) && sameTarget(e.target)
      if (e.backup && !stillWanted) {
        if (await pathExists(abs)) {
          errors.push(`Could not restore original ${e.rel}: something else is at that path. The original is kept at ${e.backup}`)
        } else {
          await withRetry(() => moveFile(e.backup!, abs), delays)
        }
      }
      pendingRemoval.splice(pendingRemoval.indexOf(e), 1)
    } catch (err) {
      const problem = problemFor(err, 'remove', abs || e.rel)
      if (mode === 'deploy') {
        await flush()
        throw new DeployError(problem)
      }
      errors.push(problem.detail)
      failedRemoval.add(key)
      pendingRemoval.splice(pendingRemoval.indexOf(e), 1)
      keep.push(e)
    }
    if (++done % 25 === 0) stage.progress(done, total)
  }
  if (toRemove.length) await flush()

  // --- place --------------------------------------------------------------
  stage('place')
  const copied: SyncResult['copied'] = []
  let sinceFlush = 0
  for (const want of toPlace) {
    if (failedRemoval.has(want.key)) continue
    const c = caps.get(want.target)
    if (!c) continue
    let abs = ''
    try {
      if (mode === 'deploy') checkAbort(opts.signal)
      abs = targetPath(c.dir, want.rel)
      for (const d of await ensureParent(c.dir, abs)) createdDirs.add(`${want.target}|${d}`)
      let backup = carriedBackup.get(want.key)
      let backedUpNow = false
      if (await pathExists(abs)) {
        if (backup) {
          // The original was saved before; what's here now was changed or added after our deployment.
          const dest = await uniquePath(join(opts.overwriteDir, want.target === 'game' ? '' : want.target, ...want.rel.split('/')))
          await withRetry(() => moveFile(abs, dest), delays)
          report.rescued++
        } else {
          backup = await uniquePath(join(opts.backupDir, want.target === 'game' ? '' : want.target, ...want.rel.split('/')))
          await withRetry(() => moveFile(abs, backup!), delays)
          report.backedUp++
          backedUpNow = true
        }
      }
      let method: DeployMethod
      try {
        method = await placeFile(want.source, abs, methods.get(want.key) ?? 'copy', c, picker, delays)
      } catch (err) {
        // Put the original straight back so it is never lost with the failed file.
        if (backedUpNow && backup && !(await pathExists(abs))) await moveFile(backup, abs).catch(() => {})
        throw err
      }
      const st = await fsp.lstat(abs, { bigint: true })
      const srcSt = await fsp.stat(want.source, { bigint: true })
      placed.push({
        target: want.target,
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
      if (method === 'copy') copied.push({ abs, source: want.source, size: want.size })
      report.placed++
      // A moved original must be on record at once, so a crash can never lose it.
      if (backedUpNow || ++sinceFlush >= 100) {
        await flush()
        sinceFlush = 0
      }
    } catch (err) {
      const problem = problemFor(err, 'place', abs || want.rel)
      if (mode === 'deploy') {
        await flush()
        throw new DeployError(problem)
      }
      errors.push(problem.detail)
    }
    if (++done % 25 === 0) stage.progress(done, total)
  }

  // --- tidy up ------------------------------------------------------------
  const finalEntries = [...keep, ...placed]
  const liveDirs = new Set<string>()
  for (const e of finalEntries) {
    const parts = relKey(e.rel).split('/')
    for (let i = 1; i < parts.length; i++) liveDirs.add(`${e.target}|${parts.slice(0, i).join('/')}`)
  }
  const deepestFirst = [...createdDirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const d of deepestFirst) {
    const [target, rel] = [d.slice(0, d.indexOf('|')), d.slice(d.indexOf('|') + 1)]
    if (liveDirs.has(`${target}|${rel.toLowerCase()}`)) continue
    const base = targets[target]?.dir ?? oldTargets[target]
    if (!base) {
      createdDirs.delete(d)
      continue
    }
    try {
      await fsp.rmdir(targetPath(base, rel))
      createdDirs.delete(d)
    } catch (err) {
      if (errCode(err) === 'ENOENT') createdDirs.delete(d)
      // ENOTEMPTY: the game put its own files there; leave it.
    }
  }

  const manifest = finalEntries.length ? manifestOf(finalEntries) : undefined
  if (manifest) await writeJsonAtomic(opts.manifestPath, manifest)
  else await fsp.rm(opts.manifestPath, { force: true })
  for (const n of picker.notes) if (!report.notes.includes(n)) report.notes.push(n)
  return { manifest, errors, copied }
}

/** Checks every deployed file against its manifest entry; copies placed in this run are compared byte for byte. */
async function verifyFiles(manifest: DeployManifest | undefined, copied: SyncResult['copied'], budget: number): Promise<{ checked: number; failed: Array<{ target: string; rel: string; reason: string }> }> {
  const failed: Array<{ target: string; rel: string; reason: string }> = []
  let checked = 0
  for (const e of manifest?.entries ?? []) {
    checked++
    const dir = manifest!.targets[e.target]
    let abs: string
    try {
      abs = targetPath(dir, e.rel)
    } catch {
      failed.push({ target: e.target, rel: e.rel, reason: 'outside its folder' })
      continue
    }
    const state = await deployedState(abs, e)
    if (state !== 'ours') {
      failed.push({ target: e.target, rel: e.rel, reason: state === 'missing' ? 'missing after deployment' : 'not the deployed file' })
      continue
    }
    if (e.method === 'symlink') {
      try {
        if ((await fsp.stat(abs)).size !== e.size) failed.push({ target: e.target, rel: e.rel, reason: 'link target has a different size' })
      } catch {
        failed.push({ target: e.target, rel: e.rel, reason: 'link points to a missing file' })
      }
    } else if (e.method === 'hardlink') {
      try {
        const [a, b] = await Promise.all([fsp.stat(abs, { bigint: true }), fsp.stat(e.source, { bigint: true })])
        if (a.ino !== b.ino) failed.push({ target: e.target, rel: e.rel, reason: 'not linked to the mod file' })
      } catch {
        failed.push({ target: e.target, rel: e.rel, reason: 'mod file in storage is missing' })
      }
    }
  }
  let used = 0
  for (const c of copied) {
    if (used + c.size > budget) break
    used += c.size
    try {
      if ((await sha1(c.abs)) !== (await sha1(c.source))) {
        const e = manifest?.entries.find((x) => samePath(targetPath(manifest.targets[x.target], x.rel), c.abs))
        failed.push({ target: e?.target ?? '?', rel: e?.rel ?? c.abs, reason: 'copy differs from the mod file' })
      }
    } catch {
      // already reported by the state check
    }
  }
  return { checked, failed }
}

function newReport(gameId: string): DeployReport {
  return {
    gameId,
    outcome: 'nothing',
    title: '',
    placed: 0,
    removed: 0,
    unchanged: 0,
    backedUp: 0,
    rescued: 0,
    kept: 0,
    methods: emptyMethods(),
    notes: [],
    errors: [],
    stages: [],
    durationMs: 0
  }
}

function stageTracker(report: DeployReport, onProgress?: DeployOptions['onProgress']): StageFn {
  let current: { stage: DeployStage; at: number; message?: string } | undefined
  const close = (ok: boolean) => {
    if (current) report.stages.push({ stage: current.stage, ok, ms: Date.now() - current.at, message: current.message })
    current = undefined
  }
  const fn = ((stage: DeployStage, message?: string) => {
    close(true)
    current = { stage, at: Date.now(), message }
    onProgress?.({ phase: stage, done: 0, total: 0, message })
  }) as StageFn
  fn.progress = (done, total, message) => onProgress?.({ phase: current?.stage ?? 'place', done, total, message })
  fn.fail = () => close(false)
  fn.end = () => close(true)
  return fn
}

/** Stages of a rollback or recovery run show up as that one phase. */
function subStages(phase: DeployStage, onProgress?: DeployOptions['onProgress']): StageFn {
  const fn = ((_stage: DeployStage) => onProgress?.({ phase, done: 0, total: 0 })) as StageFn
  fn.progress = (done, total) => onProgress?.({ phase, done, total })
  fn.fail = () => {}
  fn.end = () => {}
  return fn
}

/**
 * Brings the targets in line with `opts.plan`, touching only what changed since the last deployment.
 * Deploying an empty plan is a purge. On failure the previous deployment is restored (unless `rollback` is false).
 */
export async function applyDeployment(opts: DeployOptions): Promise<DeployReport> {
  const started = Date.now()
  const log = opts.log ?? silent
  const report = newReport(opts.gameId)
  const stage = stageTracker(report, opts.onProgress)
  devCache.clear()

  // A deployment that was cut off goes back to where it started before anything else happens.
  const leftover = await readJson<Journal>(journalPath(opts.manifestPath))
  if (leftover?.version === 1) {
    stage('recover')
    try {
      const current = await adoptOrphans(await readManifest(opts.manifestPath), leftover, opts)
      const restoreTo = leftover.restoreTo ?? undefined
      const targets = targetsOf(restoreTo, opts)
      const r = await sync({ opts, targets, plan: planFromManifest(restoreTo), previous: current, report: newReport(opts.gameId), stage: subStages('recover', opts.onProgress), mode: 'restore', journal: leftover })
      if (restoreTo && r.manifest) await opts.configure?.(r.manifest).catch(() => {})
      report.recovered = true
      report.notes.push(r.errors.length ? `An interrupted deployment was partly undone (${r.errors.length} file(s) could not be restored).` : 'An interrupted deployment was found and undone first.')
      log.warn(`recovered interrupted deployment of ${opts.gameId}: ${r.errors.length} error(s)`)
    } catch (err) {
      log.error('recovery of the interrupted deployment failed', err)
      report.errors.push(`Recovery of an interrupted deployment failed: ${(err as Error).message}`)
    }
    await clearJournal(opts.manifestPath)
  }

  const previous = await readManifest(opts.manifestPath)
  const journal: Journal = { version: 1, startedAt: Date.now(), restoreTo: previous ?? null, pending: [] }
  try {
    const r = await sync({ opts, targets: opts.targets, plan: opts.plan, previous, report, stage, mode: 'deploy', journal })
    if (r.manifest) {
      stage('configure')
      await opts.configure?.(r.manifest)
    } else if (opts.configure && previous) {
      stage('configure')
      await opts.configure(emptyManifestLike(previous, opts))
    }
    stage('verify')
    const files = await verifyFiles(r.manifest, r.copied, opts.hashBudgetBytes ?? 512 * 1024 * 1024)
    const checks = opts.verifyExtra ? await opts.verifyExtra(r.manifest ?? emptyManifestLike(previous, opts)) : []
    report.verification = { ok: !files.failed.length && !checks.some((c) => !c.ok && c.level === 'error'), checked: files.checked, failed: files.failed, checks, loadVerified: Boolean(opts.loadVerifiable) && !checks.some((c) => !c.ok && c.level === 'error') }
    if (files.failed.length) {
      throw new DeployError({
        code: 'verify_failed',
        title: 'Files did not check out after deployment',
        detail: `${files.failed.length} file(s) are not what NexusForge placed: ${files.failed.slice(0, 3).map((f) => `${f.rel} (${f.reason})`).join(', ')}.`,
        advice: ['An antivirus program may have removed or changed them; check its quarantine.', 'Deploy again; if it keeps failing, reinstall the mod.'],
        paths: files.failed.map((f) => f.rel)
      })
    }
    const failedCheck = checks.find((c) => !c.ok && c.level === 'error')
    if (failedCheck) {
      throw new DeployError({ code: 'check_failed', title: failedCheck.label, detail: failedCheck.detail ?? failedCheck.label, advice: ['See the setup panel of this game.'] })
    }
    stage('record')
    if (r.manifest) {
      r.manifest.verified = { at: Date.now(), ok: true, problems: checks.filter((c) => !c.ok).map((c) => c.label), loadVerified: report.verification.loadVerified }
      await writeJsonAtomic(opts.manifestPath, r.manifest)
    }
    for (const e of r.manifest?.entries ?? []) report.methods[e.method]++
    const live = r.manifest?.entries.length ?? 0
    report.outcome = live || report.removed || report.kept ? 'verified' : 'nothing'
    report.title =
      report.outcome === 'nothing'
        ? 'Nothing to deploy: no mod is enabled'
        : live
          ? `${live.toLocaleString()} file${live === 1 ? '' : 's'} deployed${report.verification.loadVerified ? ' and verified' : ', every file checked'}`
          : 'Mods removed from the game, original files restored'
    stage.end()
  } catch (err) {
    stage.fail()
    const problem = problemFor(err, 'deploy')
    report.problem = problem
    report.errors.push(problem.detail)
    log.warn(`deploy ${opts.gameId} failed: ${problem.code}: ${problem.detail}`)
    if (!journal.changing) {
      // Stopped before the first file was touched (preflight): the game is exactly as it was.
      report.outcome = 'failed'
      report.title = `${problem.title}. Nothing was changed.`
    } else if (opts.rollback === false) {
      report.outcome = 'failed'
      report.title = problem.title
    } else {
      stage('rollback')
      try {
        const current = await readManifest(opts.manifestPath)
        const targets = targetsOf(previous, opts)
        const back = await sync({ opts, targets, plan: planFromManifest(previous), previous: current, report: newReport(opts.gameId), stage: subStages('rollback', opts.onProgress), mode: 'restore', journal })
        if (back.manifest) await opts.configure?.(back.manifest).catch((e) => back.errors.push(`Loader settings: ${(e as Error).message}`))
        else if (opts.configure && current) await opts.configure(emptyManifestLike(current, opts)).catch(() => {})
        if (back.errors.length) {
          report.outcome = 'failed'
          report.errors.push(...back.errors)
          report.title = `${problem.title} (and the previous state could only partly be restored)`
        } else {
          report.outcome = 'rolled_back'
          report.title = `${problem.title}: nothing was changed, your previous setup is back`
        }
      } catch (e) {
        report.outcome = 'failed'
        report.errors.push(`Rollback failed: ${(e as Error).message}`)
        report.title = `${problem.title} (rollback failed)`
      }
      stage.end()
    }
  } finally {
    await clearJournal(opts.manifestPath).catch(() => {})
  }
  opts.onProgress?.({ phase: 'done', done: 0, total: 0 })
  report.durationMs = Date.now() - started
  log.info(
    `deploy ${opts.gameId}: ${report.outcome}; placed ${report.placed}, removed ${report.removed}, unchanged ${report.unchanged}, backed up ${report.backedUp}, rescued ${report.rescued}, kept ${report.kept}, errors ${report.errors.length} in ${report.durationMs}ms`
  )
  return report
}

function targetsOf(m: DeployManifest | undefined, opts: DeployOptions): Record<string, TargetSpec> {
  const out: Record<string, TargetSpec> = {}
  for (const [id, dir] of Object.entries(m?.targets ?? {})) out[id] = { ...opts.targets[id], dir }
  return out
}

function emptyManifestLike(m: DeployManifest | undefined, opts: DeployOptions): DeployManifest {
  return {
    version: 2,
    gameId: opts.gameId,
    profileId: opts.profileId,
    targets: m?.targets ?? Object.fromEntries(Object.entries(opts.targets).map(([k, v]) => [k, v.dir])),
    strategy: opts.strategy,
    deployedAt: Date.now(),
    planHash: 'empty',
    entries: [],
    createdDirs: []
  }
}
