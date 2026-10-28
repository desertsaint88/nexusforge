// One-click setup: everything a game needs so its enabled mods work, in order:
//   check the game -> install the mod loader the mods need (official channel) -> deploy -> verify.
// Runs after every download that installs into a game (Settings › Mods › "Set up and deploy automatically"),
// and from the Deploy / Install buttons. Each run is one operation with visible steps (setup:progress).

import { app, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { DeployReport, IntegrationInfo, LaunchCheck, LaunchSpec, SetupProgress, SetupStep, ShortcutInfo } from '@shared/types'
import { emit, toast } from '../events'
import { db } from '../store'
import { scoped } from '../logger'
import { safeName, shortId } from '../util/fs'
import { deployGame, deployProgressHooks, forgetInspection, inspectGame, listMods, loaderHost, removeMod } from '../mods/manager'
import { activeProfile } from '../mods/profiles'
import { integrationEnv, integrationState, saveIntegrationState } from './env'
import { loadersNeeded } from './zip-loader'
import { notifyInBackground } from '../window'

const log = scoped('setup')

const current = new Map<string, SetupProgress>()
const queues = new Map<string, Promise<unknown>>()
const pendingRuns = new Map<string, Promise<DeployReport>>()

function publish(p: SetupProgress): void {
  current.set(p.gameId, p)
  emit('setup:progress', { ...p, steps: p.steps.map((s) => ({ ...s })) })
}

export function setupState(gameId: string): SetupProgress | undefined {
  return current.get(gameId)
}

function queue<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(gameId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  queues.set(gameId, next)
  void next
    .finally(() => {
      if (queues.get(gameId) === next) queues.delete(gameId)
    })
    .catch(() => {})
  return next
}

class Operation {
  readonly p: SetupProgress
  constructor(gameId: string, title: string) {
    this.p = { gameId, opId: shortId('op'), title, steps: [], done: false }
    publish(this.p)
  }
  step(id: string, label: string): SetupStep {
    const s: SetupStep = { id, label, state: 'running' }
    this.p.steps.push(s)
    publish(this.p)
    return s
  }
  update(s: SetupStep, patch: Partial<SetupStep>): void {
    Object.assign(s, patch)
    publish(this.p)
  }
  finish(ok: boolean, error?: string): void {
    this.p.done = true
    this.p.ok = ok
    this.p.error = error
    publish(this.p)
  }
}

/** Loaders to install for `wanted`, the ones they build on first (ArchiveXL needs RED4ext). */
function installOrder(info: IntegrationInfo, wanted: string[], mods: Array<{ loaderId?: string }>): string[] {
  const out: string[] = []
  const add = (id: string, depth: number) => {
    const l = info.loaders.find((x) => x.id === id)
    if (!l || depth > 6) return
    for (const r of l.requires ?? []) add(r, depth + 1)
    if (l.state === 'installed' || l.state === 'outdated') return
    if (mods.some((x) => x.loaderId === id)) return
    if (!out.includes(id)) out.push(id)
  }
  for (const id of wanted) add(id, 0)
  return out
}

async function neededLoaders(gameId: string, info: IntegrationInfo): Promise<string[]> {
  const profile = await activeProfile(gameId)
  const enabled = new Set(profile.enabled)
  const mods = listMods(gameId).filter((m) => enabled.has(m.id))
  const wanted: string[] = []
  for (const m of mods) {
    if ((m.checks ?? []).some((c) => c.level === 'error')) continue
    wanted.push(...loadersNeeded(m))
  }
  return installOrder(info, wanted, mods)
}

async function runLoaderInstall(op: Operation, gameId: string, loaderId: string, signal?: AbortSignal): Promise<boolean> {
  const { game, integration, info } = await inspectGame(gameId, true)
  const loader = integration.loaders.find((l) => l.id === loaderId)
  const status = info.loaders.find((l) => l.id === loaderId)
  const step = op.step(`loader:${loaderId}`, `Install ${status?.name ?? loaderId}`)
  if (!loader || !status) {
    op.update(step, { state: 'failed', detail: `${game.name} has no ${loaderId}.` })
    return false
  }
  if (!status.canInstall && !status.canUpdate) {
    op.update(step, { state: 'skipped', detail: status.blocked ?? status.detail ?? 'Nothing to install.' })
    return false
  }
  try {
    await loader.install(game, info, integrationEnv(), loaderHost, (detail, progress) => op.update(step, { detail, progress }), signal)
    forgetInspection(gameId)
    op.update(step, { state: 'done', progress: 1 })
    log.info(`${game.name}: installed ${status.name}`)
    return true
  } catch (err) {
    const msg = (err as Error).message
    op.update(step, { state: 'failed', detail: msg })
    log.warn(`${game.name}: installing ${status.name} failed: ${msg}`)
    return false
  }
}

async function runDeploy(op: Operation, gameId: string): Promise<DeployReport> {
  const step = op.step('deploy', 'Deploy and verify')
  const unsubscribe = progressListener(gameId, (phase, done, total) => op.update(step, { detail: phaseLabel(phase), progress: total ? done / total : undefined }))
  try {
    const report = await deployGame(gameId)
    const ok = report.outcome === 'verified' || report.outcome === 'nothing'
    op.update(step, { state: ok ? 'done' : 'failed', detail: report.title, progress: 1 })
    return report
  } finally {
    unsubscribe()
  }
}

const PHASES: Record<string, string> = {
  recover: 'Undoing an interrupted deployment…',
  plan: 'Working out what changes…',
  preflight: 'Checking folders, rights and free space…',
  remove: 'Taking out files that are no longer wanted…',
  place: 'Putting files in place…',
  configure: "Updating the mod loader's settings…",
  verify: 'Checking every file…',
  record: 'Saving the result…',
  rollback: 'Something failed: putting the previous state back…'
}
const phaseLabel = (p: string) => PHASES[p] ?? p

// The manager reports deployment stages; the running operation shows them on its deploy step.
const listeners = new Map<string, Set<(phase: string, done: number, total: number) => void>>()
function progressListener(gameId: string, fn: (phase: string, done: number, total: number) => void): () => void {
  const set = listeners.get(gameId) ?? new Set()
  set.add(fn)
  listeners.set(gameId, set)
  return () => set.delete(fn)
}
deployProgressHooks.add((gameId, p) => {
  for (const fn of listeners.get(gameId) ?? []) fn(p.phase, p.done, p.total)
})

function announce(gameName: string, report: DeployReport, quiet: boolean): void {
  if (report.outcome === 'verified') {
    const notes = report.notes.filter((n) => n.includes('was not deployed'))
    if (notes.length) toast('warning', `${gameName}: ${report.title}`, notes.join(' '))
    else if (!quiet) toast('success', `${gameName} is ready`, report.title)
    notifyInBackground(`${gameName} is ready`, report.title)
  } else if (report.outcome === 'nothing') {
    if (!quiet) toast('info', gameName, report.title)
  } else {
    toast('error', `${gameName}: ${report.problem?.title ?? 'Deployment failed'}`, `${report.problem?.detail ?? report.title}${report.outcome === 'rolled_back' ? ' Your previous setup was restored.' : ''}`)
    notifyInBackground(`${gameName}: deployment failed`, report.problem?.title ?? report.title)
  }
}

/**
 * Installs what the enabled mods need, deploys and verifies. Calls that arrive while one is waiting to start
 * join it (a mod and its dependency finishing together run one setup).
 */
export function setupAndDeploy(gameId: string, opts: { quiet?: boolean; signal?: AbortSignal } = {}): Promise<DeployReport> {
  const waiting = pendingRuns.get(gameId)
  if (waiting) return waiting
  const run = queue(gameId, async () => {
    pendingRuns.delete(gameId)
    const { game } = await inspectGame(gameId, true)
    const op = new Operation(gameId, `Setting up ${game.name}`)
    try {
      const check = op.step('check', `Check ${game.name}`)
      const { info } = await inspectGame(gameId, true)
      op.update(check, { state: info.valid ? 'done' : 'failed', detail: info.valid ? `${info.name} · ${info.distribution.label}${info.version ? ` · ${info.version}` : ''}` : info.problems.join(' ') })
      for (const loaderId of await neededLoaders(gameId, info)) await runLoaderInstall(op, gameId, loaderId, opts.signal)
      const report = await runDeploy(op, gameId)
      const ok = report.outcome === 'verified' || report.outcome === 'nothing'
      op.finish(ok, ok ? undefined : (report.problem?.detail ?? report.title))
      announce(game.name, report, Boolean(opts.quiet))
      return report
    } catch (err) {
      op.finish(false, (err as Error).message)
      throw err
    }
  })
  pendingRuns.set(gameId, run)
  return run
}

/** The Install / Update button of a loader: installs it, then deploys so it is in the game. */
export function installLoader(gameId: string, loaderId: string, signal?: AbortSignal): Promise<DeployReport | undefined> {
  return queue(gameId, async () => {
    const { game, info } = await inspectGame(gameId, true)
    const name = info.loaders.find((l) => l.id === loaderId)?.name ?? loaderId
    const op = new Operation(gameId, `Installing ${name} for ${game.name}`)
    const status = info.loaders.find((l) => l.id === loaderId)
    // What it builds on goes in first; the loader itself is (re)installed even when it is there (Update / Repair).
    const chain = [...installOrder(info, status?.requires ?? [], listMods(gameId)), loaderId]
    let ok = true
    for (const id of chain) if (ok) ok = await runLoaderInstall(op, gameId, id, signal)
    if (!ok) {
      op.finish(false, op.p.steps.at(-1)?.detail)
      throw new Error(op.p.steps.at(-1)?.detail ?? `Could not install ${name}.`)
    }
    const report = await runDeploy(op, gameId)
    const fine = report.outcome === 'verified' || report.outcome === 'nothing'
    op.finish(fine, fine ? undefined : report.title)
    announce(game.name, report, false)
    return report
  })
}

export function removeLoader(gameId: string, loaderId: string): Promise<void> {
  return queue(gameId, async () => {
    const { game, integration, info } = await inspectGame(gameId, true)
    const mod = listMods(gameId).find((m) => m.loaderId === loaderId)
    if (mod) {
      await removeMod(gameId, mod.id)
    } else {
      const loader = integration.loaders.find((l) => l.id === loaderId)
      if (!loader?.remove) throw new Error('NexusForge did not install this loader, so it leaves it alone.')
      await loader.remove(game, info, integrationEnv(), loaderHost)
    }
    forgetInspection(gameId)
  })
}

/** How to start a game in a variant ("modded" = with its mod loader), if the integration has a special way. */
export async function launchSpecFor(gameId: string, variant: 'vanilla' | 'modded'): Promise<{ spec: LaunchSpec; followDir?: string } | undefined> {
  const { game, integration, info } = await inspectGame(gameId, true)
  return integration.launch?.(game, info, variant, integrationEnv())
}

/** Reads the loader's log of the last start and remembers it. */
export async function checkLastLaunch(gameId: string, since: number): Promise<LaunchCheck | undefined> {
  const { game, integration, info } = await inspectGame(gameId)
  if (!integration.checkLaunch) return undefined
  const check = await integration.checkLaunch(game, info, since, integrationEnv())
  if (check.ran) {
    const state = integrationState(gameId)
    state.lastLaunch = check
    saveIntegrationState(gameId, state)
    emit('integration:launch', { gameId, check })
  }
  return check
}

export function lastLaunch(gameId: string): LaunchCheck | undefined {
  return integrationState(gameId).lastLaunch
}

function shortcutDir(where: 'startmenu' | 'desktop'): string {
  return where === 'desktop' ? app.getPath('desktop') : join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NexusForge')
}

/** Creates (or updates) a NexusForge shortcut that starts the game's modded variant. */
export async function createShortcut(gameId: string, variant: 'vanilla' | 'modded', where: 'startmenu' | 'desktop'): Promise<ShortcutInfo> {
  const { game, integration, info } = await inspectGame(gameId, true)
  const spec = await integration.shortcut?.(game, info, variant, integrationEnv())
  if (!spec) throw new Error(`${game.name} has no ${variant} start NexusForge can make a shortcut for.`)
  const dir = shortcutDir(where)
  await fsp.mkdir(dir, { recursive: true })
  const path = join(dir, `${safeName(spec.name)}.lnk`)
  const existed = await fsp
    .access(path)
    .then(() => true)
    .catch(() => false)
  const ok = shell.writeShortcutLink(path, existed ? 'replace' : 'create', {
    target: spec.target,
    args: spec.args,
    cwd: spec.cwd,
    description: spec.description,
    icon: spec.icon,
    iconIndex: spec.icon ? 0 : undefined
  })
  if (!ok) throw new Error(`Windows refused to create ${path}.`)
  const rec: ShortcutInfo = { gameId, path, label: spec.name, where, variant }
  db().set('shortcuts', [...(db().get('shortcuts') ?? []).filter((s) => s.path.toLowerCase() !== path.toLowerCase()), rec])
  log.info(`${existed ? 'updated' : 'created'} shortcut ${path} -> ${spec.target} ${spec.args ?? ''}`)
  return rec
}

/** NexusForge's shortcuts for a game that still exist. */
export async function listShortcuts(gameId: string): Promise<ShortcutInfo[]> {
  const out: ShortcutInfo[] = []
  for (const s of db().get('shortcuts') ?? []) {
    if (s.gameId !== gameId) continue
    if (await fsp.access(s.path).then(() => true, () => false)) out.push(s)
  }
  return out
}
