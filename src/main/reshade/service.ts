// The ReShade tab's side of things: what to show for a game, and the actions behind its buttons (install with the
// picked API / build / shader packs, change ReShade.ini settings, remove). Installing goes through the setup
// operation like every loader, so the steps show in the Setup panel and the result is deployed and verified.

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { DeployReport, ReshadeSettingsPatch, ReshadeSetupRequest, ReshadeView } from '@shared/types'
import { inspectGame, forgetInspection, listMods } from '../mods/manager'
import { activeProfile } from '../mods/profiles'
import { runningGames } from '../library/library'
import { integrationEnv, integrationState, saveIntegrationState } from '../integrations/env'
import { installLoader, removeLoader } from '../integrations/orchestrator'
import { emit } from '../events'
import { scoped } from '../logger'
import { fileExists } from '../integrations/common'
import {
  addonMods,
  API_LABEL,
  chooseModule,
  EFFECTS_ID,
  effectiveApi,
  effectsWanted,
  SHADERS_PATH,
  findReshade,
  moduleNames,
  presetAbs,
  presetViews,
  readIni,
  renderTarget,
  RESHADE_ID,
  writeReshadeSettings,
  type ReshadeApi
} from './core'
import { effectPackages, packageForEffect, type EffectPackage } from './lists'
import { readReshadeLog } from './log'
import { effectFilesIn } from './presets'
import { reshadeRelease } from './release'

const log = scoped('reshade')

const VK: Record<number, string> = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 19: 'Pause', 20: 'Caps Lock', 27: 'Esc', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home',
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 44: 'Print Screen', 45: 'Insert', 46: 'Delete', 144: 'Num Lock', 145: 'Scroll Lock',
  106: 'Num *', 107: 'Num +', 109: 'Num -', 110: 'Num .', 111: 'Num /', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'"
}

/** "36,0,0,0" -> "Home", "113,1,0,0" -> "Ctrl + F2". */
export function keyLabel(key?: string): string {
  const [code, ctrl, shift, alt] = (key ?? '36,0,0,0').split(',').map((x) => Number.parseInt(x, 10) || 0)
  const name = VK[code] ?? (code >= 112 && code <= 135 ? `F${code - 111}` : code >= 48 && code <= 90 ? String.fromCharCode(code) : code >= 96 && code <= 105 ? `Num ${code - 96}` : `key ${code}`)
  return [ctrl ? 'Ctrl' : '', shift ? 'Shift' : '', alt ? 'Alt' : '', name].filter(Boolean).join(' + ')
}

const API_OPTIONS: ReshadeApi[] = ['dxgi', 'd3d9', 'opengl', 'vulkan']

/** Switched-on mods that need ReShade. */
async function usedBy(gameId: string): Promise<string[]> {
  const on = new Set((await activeProfile(gameId)).enabled)
  return listMods(gameId)
    .filter((m) => on.has(m.id) && (m.needsLoader === RESHADE_ID || (m.needsLoaders ?? []).includes(RESHADE_ID)))
    .map((m) => m.name)
}

export async function reshadeView(gameId: string): Promise<ReshadeView> {
  const { game, info } = await inspectGame(gameId)
  const env = integrationEnv()
  const state = integrationState(gameId)
  const rs = state.reshade ?? {}
  const mods = listMods(gameId)
  const status = info.loaders.find((l) => l.id === RESHADE_ID) ?? { id: RESHADE_ID, name: 'ReShade', state: 'unsupported' as const, canInstall: false, canUpdate: false, canRemove: false, required: false, blocked: 'ReShade is not available for this game.' }
  const effects = info.loaders.find((l) => l.id === EFFECTS_ID)
  const t = await renderTarget(game, env)
  const view: ReshadeView = {
    gameId,
    api: { source: 'none', evidence: '', options: [] },
    status,
    effects,
    copies: [],
    build: { chosen: rs.build, effective: rs.build ?? (addonMods(mods).length ? 'addon' : 'standard'), neededBy: addonMods(mods).map((m) => m.name) },
    presets: [],
    packages: [],
    usedBy: await usedBy(gameId),
    running: runningGames().includes(gameId)
  }
  try {
    const rel = await reshadeRelease(env)
    view.latest = { version: rel.version, released: rel.released }
  } catch {
    // offline
  }
  if (!t) return view
  const managed = mods.find((m) => m.loaderId === RESHADE_ID)
  const ours = (managed?.routes ?? []).map((r) => basename(r.to).toLowerCase())
  const { api, dx, detected } = await effectiveApi(t, rs)
  const arch = t.machine === 'x86' ? 'x86' : 'x64'
  view.exe = t.exe
  view.exeName = t.exeName
  view.dir = t.dir
  view.note = t.note
  view.arch = t.machine
  view.compat = { listed: Boolean(t.compat), banned: Boolean(t.compat?.banned), renderApi: t.compat?.renderApi }
  view.api = {
    detected: detected.api,
    source: detected.source,
    evidence: detected.evidence,
    chosen: rs.api,
    effective: api,
    options: await Promise.all(
      [...new Set<ReshadeApi>([...API_OPTIONS, ...(api && !API_OPTIONS.includes(api) ? [api] : [])])].map(async (id) => ({
        id,
        label: API_LABEL[id],
        module: id === 'vulkan' ? undefined : (await chooseModule(t.dir, await moduleNames(id, id === api ? dx : undefined, t.dir, arch, t.exeName), managed?.routes?.map((r) => basename(r.to)))).name
      }))
    )
  }
  view.copies = (await findReshade(t.dir)).map((c) => ({ ...c, managed: ours.includes(c.name.toLowerCase()) }))
  // Taking over a copy installed by hand keeps its build unless the user picks another one.
  if (!rs.build && !view.build.neededBy.length && view.copies.some((c) => !c.managed && c.build === 'addon')) view.build.effective = 'addon'
  const fxMod = mods.find((m) => m.loaderId === EFFECTS_ID)
  view.shaders = { effects: (await effectFilesIn(t.dir, [SHADERS_PATH])).size, managed: Boolean(fxMod) }
  const iniPath = join(t.dir, 'ReShade.ini')
  const doc = await readIni(iniPath)
  const defs = doc?.getList('GENERAL', 'PreprocessorDefinitions') ?? []
  const def = (name: string) => defs.find((d) => d.split('=')[0].trim() === name)?.split('=')[1]?.trim() === '1'
  view.ini = {
    path: iniPath,
    exists: Boolean(doc),
    presetPath: doc?.get('GENERAL', 'PresetPath'),
    keyOverlay: doc?.get('INPUT', 'KeyOverlay'),
    keyLabel: keyLabel(doc?.get('INPUT', 'KeyOverlay')),
    performanceMode: doc?.get('GENERAL', 'PerformanceMode') === '1',
    depth: { reversed: def('RESHADE_DEPTH_INPUT_IS_REVERSED'), upsideDown: def('RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN'), logarithmic: def('RESHADE_DEPTH_INPUT_IS_LOGARITHMIC') },
    effectSearchPaths: doc?.getList('GENERAL', 'EffectSearchPaths') ?? []
  }
  const packs = await effectPackages(env).catch(() => [] as EffectPackage[])
  view.presets = await presetViews(t.dir, doc, packs)
  const installedPacks = new Set((mods.find((m) => m.loaderId === EFFECTS_ID)?.meta?.packages ?? '').split('|').filter(Boolean))
  const wanted = effectsWanted(mods)
  const neededFor = (p: EffectPackage) => [...new Set([...wanted, ...view.presets.flatMap((x) => x.missing.map((m) => m.file))].filter((fx) => packageForEffect(packs, fx) === p))]
  view.packages = packs.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    required: p.required,
    defaultOn: p.enabled,
    installed: installedPacks.has(p.name),
    selected: rs.packages ? rs.packages.includes(p.name) || p.required : installedPacks.size ? installedPacks.has(p.name) || p.required : p.enabled || p.required || neededFor(p).length > 0,
    neededFor: neededFor(p),
    repositoryUrl: p.repositoryUrl
  }))
  const last = await readReshadeLog(join(t.dir, 'ReShade.log'))
  if (last) {
    view.lastStart = {
      placeholder: last.placeholder,
      at: last.at,
      version: last.version,
      bits: last.bits,
      module: last.module,
      runtime: last.runtime,
      api: last.api,
      gpu: last.gpu,
      compiled: last.compiled.length,
      failed: last.failed,
      addons: last.addons,
      errors: last.errors.slice(0, 10),
      warnings: last.warnings.slice(0, 10),
      exited: last.exited,
      logFile: join(t.dir, 'ReShade.log')
    }
  }
  return view
}

function saveChoices(gameId: string, req: ReshadeSetupRequest): void {
  const state = integrationState(gameId)
  const rs = { ...(state.reshade ?? {}) }
  if (req.api !== undefined) rs.api = req.api ?? undefined
  if (req.build !== undefined) rs.build = req.build ?? undefined
  if (req.packages !== undefined) rs.packages = req.packages ?? undefined
  saveIntegrationState(gameId, { ...state, reshade: rs })
  forgetInspection(gameId)
}

/**
 * Moves copies of ReShade NexusForge doesn't manage (installed by hand, or under a name the game never loads) into
 * NexusForge's work folder; reshadeRemove puts them back. Only on the user's request (the ReShade tab, a Diagnose fix).
 */
async function moveAsideUnmanaged(gameId: string): Promise<string[]> {
  const { game } = await inspectGame(gameId, true)
  const env = integrationEnv()
  const t = await renderTarget(game, env)
  if (!t) return []
  const managed = listMods(gameId).find((m) => m.loaderId === RESHADE_ID)
  const ours = new Set((managed?.routes ?? []).map((r) => basename(r.to).toLowerCase()))
  const foreign = (await findReshade(t.dir)).filter((c) => !ours.has(c.name.toLowerCase()))
  if (!foreign.length) return []
  if (runningGames().includes(gameId)) throw new Error(`Close ${game.name} first.`)
  const keep = join(env.workDir, 'reshade', 'replaced', gameId.replace(/[^\w.-]+/g, '_'), new Date().toISOString().replace(/[:.]/g, '-'))
  await fsp.mkdir(keep, { recursive: true })
  const moved: Array<{ name: string; backup: string }> = []
  for (const c of foreign) {
    const from = join(t.dir, c.name)
    const to = join(keep, c.name)
    await fsp.rename(from, to).catch(async () => {
      await fsp.copyFile(from, to)
      await fsp.rm(from)
    })
    moved.push({ name: c.name, backup: to })
    log.info(`${game.name}: moved ${from} (ReShade ${c.version ?? ''}, not managed by NexusForge) to ${to}`)
  }
  const state = integrationState(gameId)
  saveIntegrationState(gameId, { ...state, reshade: { ...(state.reshade ?? {}), replaced: [...(state.reshade?.replaced ?? []), ...moved] } })
  forgetInspection(gameId)
  return moved.map((m) => m.name)
}

/** Saves the choices from the ReShade tab and, when asked, installs (or reinstalls) ReShade and the shader packs. */
export async function reshadeSetup(gameId: string, req: ReshadeSetupRequest): Promise<DeployReport | undefined> {
  const mods = listMods(gameId)
  const managed = mods.find((m) => m.loaderId === RESHADE_ID)
  const before = integrationState(gameId).reshade ?? {}
  saveChoices(gameId, req)
  if (req.cleanup && !req.install) {
    await moveAsideUnmanaged(gameId)
    emit('mods:changed', { gameId })
    return undefined
  }
  if (!req.install) {
    emit('mods:changed', { gameId })
    return undefined
  }
  const reshadeChanged = !managed || (req.api !== undefined && (req.api ?? undefined) !== before.api) || (req.build !== undefined && (req.build ?? undefined) !== before.build)
  if (reshadeChanged && req.build === undefined && !before.build) {
    // Taking over a copy installed by hand keeps its build (the add-on build stays the add-on build).
    const { game: g } = await inspectGame(gameId)
    const tt = await renderTarget(g, integrationEnv())
    const ours = new Set((managed?.routes ?? []).map((r) => basename(r.to).toLowerCase()))
    if (tt && (await findReshade(tt.dir)).some((c) => !ours.has(c.name.toLowerCase()) && c.build === 'addon')) saveChoices(gameId, { build: 'addon' })
  }
  // NexusForge's copy replaces one installed by hand (kept as a backup, restored when ReShade is removed again).
  if (reshadeChanged) await moveAsideUnmanaged(gameId)
  const { game, info } = await inspectGame(gameId, true)
  const fx = info.loaders.find((l) => l.id === EFFECTS_ID)
  // Shader packs that came with ReShade's own setup stay; NexusForge doesn't put a second set next to them.
  const t = await renderTarget(game, integrationEnv())
  const handInstalled = !mods.some((m) => m.loaderId === EFFECTS_ID) && t ? (await effectFilesIn(t.dir, [SHADERS_PATH])).size > 0 : false
  const wantFx = req.packages !== undefined || (!mods.some((m) => m.loaderId === EFFECTS_ID) && !handInstalled) || Boolean(fx?.refresh)
  log.info(`ReShade setup for ${gameId}: ${JSON.stringify(req)}`)
  if (reshadeChanged) return installLoader(gameId, RESHADE_ID, undefined, { also: wantFx ? [EFFECTS_ID] : [], force: true })
  if (wantFx) return installLoader(gameId, EFFECTS_ID, undefined, { force: true })
  return undefined
}

/** Changes ReShade.ini (preset, overlay key, performance mode, depth settings). */
export async function reshadeSettings(gameId: string, patch: ReshadeSettingsPatch): Promise<ReshadeView> {
  const { game } = await inspectGame(gameId)
  if (runningGames().includes(gameId)) throw new Error(`Close ${game.name} first: ReShade keeps its settings open while the game runs and writes them back when it closes.`)
  const t = await renderTarget(game, integrationEnv())
  if (!t) throw new Error("NexusForge doesn't know the game's executable.")
  if (patch.presetPath !== undefined && patch.presetPath && !(await fileExists(presetAbs(t.dir, patch.presetPath)))) throw new Error(`${patch.presetPath} doesn't exist next to ${t.exeName}.`)
  if (patch.keyOverlay !== undefined && !/^\d{1,3},[01],[01],[01]$/.test(patch.keyOverlay)) throw new Error('Invalid key.')
  await writeReshadeSettings(t.dir, patch)
  if (patch.presetPath !== undefined) {
    // A preset picked here is never changed automatically again.
    const state = integrationState(gameId)
    saveIntegrationState(gameId, { ...state, reshade: { ...(state.reshade ?? {}), presetPicked: true } })
  }
  log.info(`${game.name}: ReShade.ini ${JSON.stringify(patch)}`)
  return reshadeView(gameId)
}

/** Takes ReShade and the shader packs out of the game (NexusForge's copies only). */
export async function reshadeRemove(gameId: string): Promise<void> {
  const mods = listMods(gameId)
  if (mods.some((m) => m.loaderId === EFFECTS_ID)) await removeLoader(gameId, EFFECTS_ID)
  if (mods.some((m) => m.loaderId === RESHADE_ID)) await removeLoader(gameId, RESHADE_ID)
  const state = integrationState(gameId)
  // Copies NexusForge had moved aside come back where they were, if nothing is there now.
  const { game } = await inspectGame(gameId, true)
  const t = await renderTarget(game, integrationEnv())
  const left: Array<{ name: string; backup: string }> = []
  for (const r of state.reshade?.replaced ?? []) {
    const to = t ? join(t.dir, r.name) : undefined
    if (to && (await fileExists(r.backup)) && !(await fileExists(to))) {
      await fsp.rename(r.backup, to).catch(() => left.push(r))
      log.info(`${game.name}: put ${r.name} back from ${r.backup}`)
    } else if (await fileExists(r.backup)) left.push(r)
  }
  saveIntegrationState(gameId, { ...state, reshade: { ...(state.reshade ?? {}), presetPicked: false, autoPreset: undefined, replaced: left.length ? left : undefined } })
  forgetInspection(gameId)
}
