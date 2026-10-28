// Diagnose a game's mod setup, repair it with the user's consent, and export the report.
//
// runDiagnostics never changes anything (it reads the game folder, the deployment manifest, the loaders' logs).
// applyFix only runs one of a fixed set of actions, each the same operation the user could start from the UI, and
// runs the checks again afterwards so the result shows whether the repair worked.

import { app, BrowserWindow, dialog, shell } from 'electron'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { DiagnosticReport } from '@shared/types'
import { scoped } from '../logger'
import { paths } from '../paths'
import { safeName } from '../util/fs'
import { getGame, updateGame } from '../library/library'
import { deployStatus, forgetInspection, inspectGame, launchEvidence, listMods, relayoutMod, removeMod } from '../mods/manager'
import { readManifest } from '../mods/deploy'
import { activeProfile } from '../mods/profiles'
import { integrationEnv, integrationState } from '../integrations/env'
import { forgetIntegration } from '../integrations/registry'
import { installLoader, setupAndDeploy } from '../integrations/orchestrator'
import { runChecks } from './core'
import { reportMarkdown } from './report'

const log = scoped('diagnostics')

export async function runDiagnostics(gameId: string): Promise<DiagnosticReport> {
  const started = Date.now()
  // The loader log first: loader status depends on it (a script that needs a newer Script Hook V .NET).
  const lastLaunch = await launchEvidence(gameId, undefined, true).catch(() => undefined)
  const ctx = await inspectGame(gameId, true)
  const { game, info, integration } = ctx
  const env = integrationEnv()
  const status = await deployStatus(gameId)
  const manifest = await readManifest(paths.deployManifest(gameId))
  const mods = listMods(gameId)
  const profile = await activeProfile(gameId)
  const enabled = new Set(profile.enabled)
  const verifyChecks = manifest && integration.verify ? await integration.verify(game, info, manifest, mods, env).catch(() => []) : []
  const { findings, rows } = await runChecks({ game, info, integration, mods, enabled, manifest, status, lastLaunch, verifyChecks, env, state: integrationState(gameId) })
  const report: DiagnosticReport = {
    gameId,
    gameName: game.name,
    at: Date.now(),
    integration: { id: info.integrationId, name: info.name, support: info.support, supports: info.supports! },
    installation: { installDir: game.installDir, exePath: game.exePath, deployDir: game.modding.targetDir, distribution: info.distribution.label, version: info.version, valid: info.valid, problems: info.problems },
    targets: info.targets,
    loaders: info.loaders.map((l) => ({ id: l.id, name: l.name, state: l.state, version: l.version, latest: l.latest, blocked: l.blocked, required: l.required })),
    deployment: { deployed: status.deployed, inSync: status.inSync, fileCount: status.fileCount, deployedAt: status.deployedAt, interrupted: status.interrupted, last: status.last },
    lastLaunch,
    mods: rows,
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      infos: findings.filter((f) => f.severity === 'info').length,
      fixable: findings.filter((f) => f.fixes.length).length
    },
    durationMs: Date.now() - started
  }
  log.info(`${game.name}: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s): ${findings.map((f) => f.code).join(', ') || 'none'}`)
  return report
}

const FIXES = new Set(['deploy', 'install-loader', 'relayout', 'set-deploy-dir', 'run-installer', 'remove-mod'])

/** Runs one repair the user confirmed, then checks again. */
export async function applyFix(gameId: string, fixId: string, params: Record<string, string> = {}): Promise<DiagnosticReport> {
  if (!FIXES.has(fixId)) throw new Error(`Unknown repair: ${fixId}`)
  const game = getGame(gameId)
  if (!game) throw new Error('Game not found')
  log.info(`${game.name}: repair ${fixId} ${JSON.stringify(params)}`)
  switch (fixId) {
    case 'deploy':
      await setupAndDeploy(gameId)
      break
    case 'install-loader': {
      const { info } = await inspectGame(gameId, true)
      if (!info.loaders.some((l) => l.id === params.loaderId)) throw new Error(`${game.name} has no loader ${params.loaderId}.`)
      await installLoader(gameId, params.loaderId)
      break
    }
    case 'relayout':
      await relayoutMod(gameId, modIdOf(gameId, params.modId))
      break
    case 'remove-mod':
      await removeMod(gameId, modIdOf(gameId, params.modId))
      break
    case 'set-deploy-dir': {
      // Only the game's own folder (or one inside it) can become the deploy folder.
      const dir = resolve(params.dir ?? '')
      const rel = relative(resolve(game.installDir), dir)
      if (!params.dir || rel.startsWith('..') || /^[a-z]:/i.test(rel)) throw new Error('That folder is not inside the game folder.')
      if (!(await fsp.stat(dir).then((s) => s.isDirectory(), () => false))) throw new Error(`${dir} does not exist.`)
      updateGame(gameId, { modding: { ...game.modding, targetDir: dir } })
      forgetIntegration(gameId)
      forgetInspection(gameId)
      await setupAndDeploy(gameId)
      break
    }
    case 'run-installer': {
      const mod = listMods(gameId).find((m) => m.id === params.modId)
      if (!mod || mod.kind !== 'installer' || !mod.meta?.installer) throw new Error('That mod is not a setup program.')
      const file = resolve(mod.stagingDir, mod.meta.installer)
      if (relative(resolve(mod.stagingDir), file).startsWith('..')) throw new Error('Invalid installer path.')
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
      break
    }
  }
  return runDiagnostics(gameId)
}

function modIdOf(gameId: string, modId: string | undefined): string {
  if (!modId || !listMods(gameId).some((m) => m.id === modId)) throw new Error('Mod not found')
  return modId
}

/** Writes the report as Markdown where the user picks (default: Downloads). Returns the path, or null if cancelled. */
export async function exportDiagnostics(gameId: string, win?: BrowserWindow | null): Promise<string | null> {
  const report = await runDiagnostics(gameId)
  const text = reportMarkdown(report, { home: os.homedir(), user: os.userInfo().username }, app.getVersion())
  const defaultPath = join(app.getPath('downloads'), `NexusForge diagnostics - ${safeName(report.gameName)} - ${new Date().toISOString().slice(0, 10)}.md`)
  const opts = { title: 'Save diagnostic report', defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] }
  const pick = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return null
  await fsp.writeFile(pick.filePath, text, 'utf8')
  log.info(`exported diagnostics for ${report.gameName} to ${pick.filePath}`)
  return pick.filePath
}
