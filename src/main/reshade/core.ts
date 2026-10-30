// ReShade for every game: NexusForge installs it, keeps it configured and checks it, the way ReShade's own setup
// does it, without running the setup.
//
//   where      next to the executable the game actually runs (an Unreal game's Binaries\Win64\*-Shipping.exe,
//              GTA5.exe rather than PlayGTAV.exe), or the sub folder ReShade's compatibility list names
//   which API  ReShade's compatibility list first, else the DLLs the executable imports (the setup's own rules:
//              DXGI over Direct3D 9, Vulkan over Direct3D 12, Direct3D/Vulkan over OpenGL); DXVK in the folder
//              means Vulkan. The user can override it.
//   DLL name   dxgi.dll (Direct3D 10/11/12), d3d9.dll, opengl32.dll, ddraw.dll, as the setup uses. A file under that
//              name that came with the game (a DXVK, ENB or emulator DLL) is never replaced: NexusForge falls back
//              to d3d11.dll / d3d12.dll, or to ReShade64.asi when an ASI loader is there, or says why it can't.
//   build      the standard build, or the build with full add-on support when a mod needs it (an add-on such as
//              GTA V x Minecraft's MCPassthrough.asi) or the user picks it. The add-on build is for single-player.
//   banned     games ReShade's list marks "Banned=1" (anti-cheat bans ReShade) are refused, as the setup does.
//   ReShade.ini  written after every deployment with the setup's defaults: shader search paths, the depth settings
//              from the compatibility list, Home as the overlay key. Settings the user changed stay as they are.
//   effects    the setup's shader collections (EffectPackages.ini), installed as one "ReShade shader packs" package:
//              the standard effects, SweetFX, plus every package a preset needs.
//   presets    a preset that comes with a mod becomes the active one, until the user picks one themselves.
//
// ReShade and the shader packs are installed like mods (stored by NexusForge, deployed with links or copies,
// recorded, removed again by a purge). ReShade.ini is written by the configure step and taken out again when
// ReShade goes, if NexusForge created it.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { DeployManifest, DiagnosticFinding, Game, InstalledMod, IntegrationInfo, LoaderStatus, VerifyCheck } from '@shared/types'
import type { DiagnoseContext, GameIntegration, IntegrationEnv, IntegrationState, LoaderAdapter, LoaderInstallHost, ReshadeState } from '../integrations/types'
import { antiCheatIn, compareVersions, fileExists } from '../integrations/common'
import { GITHUB_HOSTS } from '../integrations/github'
import { identifyProxy } from '../integrations/proxy'
import { unrealLayout } from '../integrations/unreal'
import { FRAMEWORKS_ID } from '../sources/frameworks'
import { readVersionStrings } from '../library/exe-version'
import { safeReaddir, walkFiles } from '../util/fs'
import { IniDoc } from './ini'
import { compatFor, effectPackages, packageForEffect, type CompatEntry, type EffectPackage } from './lists'
import { readPe, type PeMachine } from './pe'
import { findPresets, isPresetText, effectFilesIn, parsePreset, type FoundPreset } from './presets'
import { readReshadeLog, type ReshadeLog } from './log'
import { RESHADE_SITE, reshadeBinaries, reshadeRelease, type ReshadeBuild } from './release'

export const RESHADE_ID = 'reshade'
export const EFFECTS_ID = 'reshade-effects'
export const RESHADE_MARKER = 'nexusforge-reshade.json'
export const EFFECTS_MARKER = 'nexusforge-effects.json'

export type ReshadeApi = 'dxgi' | 'd3d9' | 'opengl' | 'vulkan' | 'ddraw' | 'd3d10' | 'd3d11' | 'd3d12'

export const API_LABEL: Record<ReshadeApi, string> = {
  dxgi: 'DirectX 10/11/12',
  d3d9: 'DirectX 9',
  opengl: 'OpenGL',
  vulkan: 'Vulkan',
  ddraw: 'DirectDraw',
  d3d10: 'DirectX 10',
  d3d11: 'DirectX 11',
  d3d12: 'DirectX 12'
}

const MODULE: Record<Exclude<ReshadeApi, 'vulkan'>, string> = {
  dxgi: 'dxgi.dll',
  d3d9: 'd3d9.dll',
  opengl: 'opengl32.dll',
  ddraw: 'ddraw.dll',
  d3d10: 'd3d10.dll',
  d3d11: 'd3d11.dll',
  d3d12: 'd3d12.dll'
}

/** Every name ReShade can be loaded under (the setup removes all of them when uninstalling). */
export const RESHADE_MODULES = ['dxgi.dll', 'd3d9.dll', 'd3d10.dll', 'd3d11.dll', 'd3d12.dll', 'opengl32.dll', 'ddraw.dll']

export const SHADERS_PATH = '.\\reshade-shaders\\Shaders\\**'
export const TEXTURES_PATH = '.\\reshade-shaders\\Textures\\**'

/** What NexusForge writes into the package folder of the ReShade it installs. */
export interface ReshadeMarker {
  version: string
  build: ReshadeBuild
  arch: 'x86' | 'x64'
  api: ReshadeApi
  thumbprint?: string
}

export interface EffectsMarker {
  packages: string[]
  installedAt: number
}

// ---------------------------------------------------------------------------
// Where ReShade goes

export interface RenderTarget {
  /** The executable the game runs. */
  exe: string
  exeName: string
  /** ReShade's folder: the executable's folder, or the sub folder the compatibility list names. */
  dir: string
  machine: PeMachine
  imports: string[]
  compat?: CompatEntry
  /** Why this executable (shown in the ReShade tab). */
  note?: string
}

/** Launchers and the game executable they start (path relative to the launcher's folder). */
const LAUNCHERS: Record<string, string> = { 'playgtav.exe': 'GTA5.exe', 'gtavlauncher.exe': 'GTA5.exe', 'beamng.drive.exe': 'Bin64/BeamNG.drive.x64.exe' }

export async function renderTarget(game: Pick<Game, 'exePath' | 'installDir'>, env: Pick<IntegrationEnv, 'fetchText' | 'workDir'>): Promise<RenderTarget | undefined> {
  let exe = game.exePath
  let note: string | undefined
  if (exe && LAUNCHERS[basename(exe).toLowerCase()]) {
    const real = join(dirname(exe), ...LAUNCHERS[basename(exe).toLowerCase()].split('/'))
    if (await fileExists(real)) {
      note = `${basename(exe)} only starts the game; ReShade goes next to ${relative(dirname(exe), real)}.`
      exe = real
    }
  }
  const ue = await unrealLayout(game).catch(() => undefined)
  if (ue && (!exe || exe.toLowerCase() !== ue.shipping.toLowerCase())) {
    note = `Unreal Engine game: ${exe ? `${basename(exe)} only starts ` : ''}${basename(ue.shipping)}${exe ? '' : ' is the game'}, so ReShade goes into ${relative(game.installDir, ue.bin) || ue.bin}.`
    exe = ue.shipping
  }
  if (!exe || !(await fileExists(exe))) return undefined
  const pe = await readPe(exe)
  const compat = await compatFor(env, basename(exe)).catch(() => undefined)
  const dir = compat?.installTarget && !compat.renderApi?.startsWith('Vulkan') ? join(dirname(exe), ...compat.installTarget.split(/[\\/]/)) : dirname(exe)
  return { exe, exeName: basename(exe), dir, machine: pe?.machine ?? 'unknown', imports: pe?.imports ?? [], compat, note }
}

// ---------------------------------------------------------------------------
// Which graphics API

export interface ApiDetection {
  api?: ReshadeApi
  /** Direct3D version behind DXGI, when known ('11', '12'). */
  dx?: string
  source: 'compat' | 'imports' | 'dll' | 'dxvk' | 'none'
  evidence: string
}

const GRAPHICS = (imports: string[]) => ({
  d3d8: imports.some((s) => s.startsWith('d3d8')),
  d3d9: imports.some((s) => s.startsWith('d3d9')),
  dxgi: imports.some((s) => s.startsWith('dxgi') || s.startsWith('d3d1') || s.includes('gfsdk')),
  d3d12: imports.some((s) => s.startsWith('d3d12')),
  d3d11: imports.some((s) => s.startsWith('d3d11')),
  ddraw: imports.some((s) => s.startsWith('ddraw')),
  opengl: imports.some((s) => s.startsWith('opengl32')),
  vulkan: imports.some((s) => s.startsWith('vulkan-1'))
})

/** ReShade setup's choice from a list of imported DLLs. */
export function apiFromImports(imports: string[]): { api?: ReshadeApi; dx?: string; d3d8?: boolean } {
  const g = GRAPHICS(imports)
  const d3d9 = (g.d3d8 || g.d3d9) && !g.dxgi
  const dxgi = g.dxgi && !g.vulkan
  const opengl = g.opengl && !(g.d3d8 || g.d3d9 || g.dxgi || g.vulkan)
  const dx = g.d3d12 ? '12' : g.d3d11 ? '11' : undefined
  if (g.vulkan) return { api: 'vulkan' }
  if (d3d9) return { api: 'd3d9', d3d8: g.d3d8 }
  if (dxgi) return { api: 'dxgi', dx }
  if (opengl) return { api: 'opengl' }
  if (g.ddraw) return { api: 'ddraw' }
  return {}
}

const COMPAT_API: Record<string, ReshadeApi> = { D3D8: 'd3d9', D3D9: 'd3d9', D3D10: 'dxgi', D3D11: 'dxgi', D3D12: 'dxgi', DXGI: 'dxgi', DDraw: 'ddraw', OpenGL: 'opengl', Vulkan: 'vulkan' }

async function productName(file: string): Promise<string | undefined> {
  return (await readVersionStrings(file).catch(() => undefined))?.productName
}

export async function detectApi(t: RenderTarget): Promise<ApiDetection> {
  for (const n of ['d3d9.dll', 'dxgi.dll']) {
    if ((await productName(join(t.dir, n))) === 'DXVK') return { api: 'vulkan', source: 'dxvk', evidence: `${n} in the game folder is DXVK, which turns DirectX into Vulkan.` }
  }
  const c = t.compat?.renderApi
  if (c && COMPAT_API[c]) {
    const v = c.match(/^D3D1([012])$/)
    const forced = t.compat?.forceInstallApi && v ? (c.toLowerCase() as ReshadeApi) : undefined
    return { api: forced ?? COMPAT_API[c], dx: v ? `1${v[1]}` : undefined, source: 'compat', evidence: `ReShade's compatibility list: ${t.exeName} renders with ${c.replace('D3D', 'Direct3D ')}.` }
  }
  const own = apiFromImports(t.imports)
  if (own.api) return { api: own.api, dx: own.dx, source: 'imports', evidence: `${t.exeName} loads ${t.imports.filter((i) => /^(d3d|dxgi|opengl32|vulkan-1|ddraw)/.test(i)).join(', ')}.${own.d3d8 ? ' It uses Direct3D 8, which ReShade only reaches through d3d8to9 (github.com/crosire/d3d8to9).' : ''}` }
  // Unity loads Direct3D at run time (UnityPlayer.dll only imports OpenGL as a fallback): Direct3D 11 is its default.
  const entries = await safeReaddir(dirname(t.exe))
  if (entries.some((e) => e.isFile() && /^unityplayer\.dll$/i.test(e.name)) || entries.some((e) => e.isDirectory() && e.name.toLowerCase() === `${t.exeName.replace(/\.exe$/i, '').toLowerCase()}_data`)) {
    return { api: 'dxgi', dx: '11', source: 'dll', evidence: "Unity game: Unity renders with Direct3D 11 on Windows unless the game's developer picked another API (if ReShade doesn't show up in game, try Direct3D 12 / Vulkan / OpenGL)." }
  }
  // Engines that render from a DLL next to the executable (engine.dll, renderer.dll, …): everything they import
  // together, with the setup's preferences (DirectX over OpenGL).
  const dlls = entries.filter((e) => e.isFile() && /\.dll$/i.test(e.name) && !RESHADE_MODULES.includes(e.name.toLowerCase()))
  dlls.sort((a, b) => Number(/^(engine|render|gfx|graphics)/i.test(b.name)) - Number(/^(engine|render|gfx|graphics)/i.test(a.name)))
  const seen = new Map<string, string>()
  for (const d of dlls.slice(0, 40)) {
    const pe = await readPe(join(dirname(t.exe), d.name))
    for (const i of pe?.imports ?? []) if (/^(d3d|dxgi|opengl32|vulkan-1|ddraw)/.test(i) && !seen.has(i)) seen.set(i, d.name)
  }
  const hit = apiFromImports([...seen.keys()])
  if (hit.api) return { api: hit.api, dx: hit.dx, source: 'dll', evidence: `DLLs next to ${t.exeName} load ${[...seen].map(([i, d]) => `${i} (${d})`).join(', ')}.` }
  return { source: 'none', evidence: `${t.exeName} loads no graphics DLL directly, so NexusForge can't tell which API it uses.` }
}

// ---------------------------------------------------------------------------
// ReShade copies in a folder

export interface ReshadeCopy {
  name: string
  version?: string
  /** Standard (signed) or add-on (unsigned) build. */
  build: ReshadeBuild
}

const ASI_RESHADE = /^reshade(32|64)?\.asi$/i

/** Every ReShade in a folder: under one of its DLL names, or as an .asi for an ASI loader. */
export async function findReshade(dir: string): Promise<ReshadeCopy[]> {
  const out: ReshadeCopy[] = []
  for (const e of await safeReaddir(dir)) {
    if (!e.isFile()) continue
    const lower = e.name.toLowerCase()
    if (!RESHADE_MODULES.includes(lower) && !/\.asi$/i.test(lower)) continue
    const abs = join(dir, e.name)
    const vs = await readVersionStrings(abs).catch(() => undefined)
    // The version resource names it; without one (a stripped or renamed copy) its strings do.
    const isReshade = vs?.productName === 'ReShade' || (!vs?.productName && (ASI_RESHADE.test(e.name) || RESHADE_MODULES.includes(lower)) && (await identifyProxy(abs, e.name)).owner === 'reshade')
    if (!isReshade) continue
    const pe = await readPe(abs)
    out.push({ name: e.name, version: vs?.version?.replace(/,\s*/g, '.'), build: pe?.signed ? 'standard' : 'addon' })
  }
  return out
}

/** An ASI loader (Script Hook V's dinput8.dll, Ultimate ASI Loader) is in the folder. */
async function asiLoaderIn(dir: string): Promise<string | undefined> {
  for (const n of ['dinput8.dll', 'version.dll', 'winmm.dll', 'dsound.dll', 'xinput1_3.dll', 'd3d8.dll', 'winhttp.dll']) {
    if (!(await fileExists(join(dir, n)))) continue
    if ((await identifyProxy(join(dir, n), n)).owner === 'asi-loader') return n
  }
  return undefined
}

/**
 * Games that load their graphics DLLs by full path from System32, so ReShade under dxgi.dll / d3d11.dll is never
 * loaded: ReShade goes in as an ASI plugin there (the game's ASI loader comes with Script Hook V).
 * GTA V: its own ReShade.log shows "Just loaded via LoadLibrary('C:\Windows\System32\dxgi.dll')", a
 * dxgi.dll installed with ReShade's setup never wrote its log, and ReShade64.asi through the ASI loader did.
 */
export const ASI_ONLY: Record<string, { why: string; loader: string }> = {
  'gta5.exe': { why: "GTA V loads dxgi.dll and d3d11.dll straight from Windows' System32 folder, so ReShade under those names is never loaded", loader: 'scripthookv' }
}

/** Names ReShade can go in under for an API, most standard first. */
export async function moduleNames(api: ReshadeApi, dx: string | undefined, dir: string, arch: 'x86' | 'x64', exeName?: string): Promise<string[]> {
  if (api === 'vulkan') return []
  const asi = arch === 'x86' ? 'ReShade32.asi' : 'ReShade64.asi'
  if (exeName && ASI_ONLY[exeName.toLowerCase()]) return [asi]
  const names = [MODULE[api]]
  if (api === 'dxgi') {
    if (dx === '11' || !dx) names.push('d3d11.dll')
    if (dx === '12') names.push('d3d12.dll')
  }
  if (await asiLoaderIn(dir)) names.push(asi)
  return names
}

export interface ModuleChoice {
  name?: string
  /** Files under ReShade's names that belong to something else (kept). */
  taken: Array<{ name: string; label: string }>
  /** The name the user would expect (dxgi.dll) is taken, so ReShade went in as `name`. */
  fallback?: string
}

/** Picks ReShade's file name: one ReShade already uses, else the first free one. `ours` were deployed by NexusForge. */
export async function chooseModule(dir: string, names: string[], ours: string[] = []): Promise<ModuleChoice> {
  const mine = new Set(ours.map((n) => n.toLowerCase()))
  const taken: ModuleChoice['taken'] = []
  let reuse: string | undefined
  for (const n of names) {
    const abs = join(dir, n)
    if (!(await fileExists(abs))) continue
    if (mine.has(n.toLowerCase())) {
      reuse ??= n
      continue
    }
    const p = await identifyProxy(abs, n)
    const pn = await productName(abs)
    if (pn === 'ReShade' || p.owner === 'reshade') reuse ??= n
    else taken.push({ name: n, label: pn === 'DXVK' ? 'DXVK (Vulkan translation layer)' : p.label })
  }
  const free = reuse ?? names.find((n) => !taken.some((t) => t.name.toLowerCase() === n.toLowerCase()))
  return { name: free, taken, fallback: free && free.toLowerCase() !== names[0]?.toLowerCase() && taken.some((t) => t.name.toLowerCase() === names[0].toLowerCase()) ? names[0] : undefined }
}

// ---------------------------------------------------------------------------
// Mods and ReShade

/** Mods that only work with ReShade's add-on build. */
export function addonMods(mods: InstalledMod[]): InstalledMod[] {
  return mods.filter((m) => m.meta?.reshadeAddon === '1')
}

function needs(m: InstalledMod, id: string): boolean {
  return m.needsLoader === id || (m.needsLoaders ?? []).includes(id)
}

/** Effect files presets of the installed mods need that their own packages don't bring. */
export function effectsWanted(mods: InstalledMod[]): string[] {
  const out = new Set<string>()
  for (const m of mods) for (const f of (m.meta?.reshadeEffects ?? '').split(',').map((x) => x.trim()).filter(Boolean)) out.add(f)
  return [...out]
}

const fileListCache = new Map<string, { key: string; files: Set<string> }>()

/** Effect files (lower case) in a mod's storage. */
async function effectsIn(mod: InstalledMod | undefined): Promise<Set<string>> {
  if (!mod) return new Set()
  const key = `${mod.stagingDir}|${mod.updatedAt}`
  const hit = fileListCache.get(mod.id)
  if (hit?.key === key) return hit.files
  const files = new Set((await walkFiles(mod.stagingDir, { limit: 50_000 })).filter((f) => /\.fx$/i.test(f.rel)).map((f) => basename(f.rel).toLowerCase()))
  fileListCache.set(mod.id, { key, files })
  return files
}

/** The setup's default packages, plus the ones that bring effects the installed presets need. */
export function packagesFor(all: EffectPackage[], wanted: string[], chosen?: string[]): { packages: EffectPackage[]; unknown: string[] } {
  const pick = new Set<EffectPackage>()
  if (chosen) for (const n of chosen) {
    const p = all.find((x) => x.name === n)
    if (p) pick.add(p)
  }
  else for (const p of all) if (p.required || p.enabled) pick.add(p)
  for (const p of all) if (p.required) pick.add(p)
  const unknown: string[] = []
  for (const fx of wanted) {
    const p = packageForEffect(all, fx)
    if (p) pick.add(p)
    else unknown.push(fx)
  }
  return { packages: all.filter((p) => pick.has(p)), unknown }
}

// ---------------------------------------------------------------------------
// Loader status

function reshadeState(state: IntegrationState): ReshadeState {
  return state.reshade ?? {}
}

/** The API NexusForge installs for: the user's pick, else the detected one. */
export async function effectiveApi(t: RenderTarget, rs: ReshadeState): Promise<{ api?: ReshadeApi; dx?: string; detected: ApiDetection }> {
  const detected = await detectApi(t)
  const picked = rs.api as ReshadeApi | undefined
  return { api: picked ?? detected.api, dx: picked ? (picked === 'd3d11' ? '11' : picked === 'd3d12' ? '12' : detected.dx) : detected.dx, detected }
}

const VULKAN_NOTE =
  "Vulkan games load ReShade as a system-wide Vulkan layer (registered for all programs), which NexusForge doesn't change. If the game can also run with DirectX, switch it to DirectX in its settings and pick DirectX in the ReShade tab; otherwise use ReShade's own setup from reshade.me."

async function managedModuleNames(mod: InstalledMod | undefined): Promise<string[]> {
  return (mod?.routes ?? []).filter((r) => /\.(dll|asi)$/i.test(r.to)).map((r) => basename(r.to))
}

export const reshadeLoader: LoaderAdapter = {
  id: RESHADE_ID,
  name: 'ReShade',
  async status(game, _info, env, state, mods): Promise<LoaderStatus> {
    const summary = 'Post-processing for the game\'s picture (sharpening, colors, ambient occlusion, …) with presets and shader packs. In game, Home opens its overlay.'
    const managed = mods.find((m) => m.loaderId === RESHADE_ID)
    const required = mods.some((m) => needs(m, RESHADE_ID))
    const t = await renderTarget(game, env)
    const asiOnly = t ? ASI_ONLY[t.exeName.toLowerCase()] : undefined
    const base = { id: RESHADE_ID, name: 'ReShade', summary, required, canRemove: Boolean(managed), via: 'nexusforge' as const, ...(asiOnly ? { requires: [asiOnly.loader] } : {}) }
    if (!t) return { ...base, state: 'unsupported', canInstall: false, canUpdate: false, blocked: "NexusForge doesn't know the game's executable. Set it in the game's Settings tab, then ReShade can be installed next to it." }
    const dir = t.dir
    if (t.compat?.banned) {
      return { ...base, dir, state: 'unsupported', canInstall: false, canUpdate: false, blocked: `ReShade's own compatibility list marks ${t.exeName} as a game whose anti-cheat blocks or bans ReShade. NexusForge doesn't install it there (ReShade's setup refuses too).` }
    }
    if (t.machine !== 'x86' && t.machine !== 'x64') return { ...base, dir, state: 'unsupported', canInstall: false, canUpdate: false, blocked: `${t.exeName} is not a 32- or 64-bit Windows program ReShade can run in.` }
    const arch = t.machine
    const rs = reshadeState(state)
    const copies = await findReshade(dir)
    const ours = await managedModuleNames(managed)
    let latest: string | undefined
    try {
      latest = (await reshadeRelease(env)).version
    } catch {
      // offline
    }
    const wantAddon = addonMods(mods)
    const ac = await antiCheatIn([dirname(t.exe), game.installDir])
    const addonWarn = wantAddon.length || rs.build === 'addon' ? `The add-on build${wantAddon.length ? ` (${wantAddon.map((m) => m.name).join(', ')} needs it)` : ''} is meant for single-player games: online games may treat it as a cheat.` : undefined
    const warning = [ac ? `${ac} is part of this game: use ReShade offline / in single player only.` : undefined, addonWarn].filter(Boolean).join(' ') || undefined
    // In a game that never loads ReShade's DLL names, copies under those names do nothing (they are only noted).
    const live = asiOnly ? copies.filter((c) => ASI_RESHADE.test(c.name)) : copies
    const inert = copies.filter((c) => !live.includes(c))
    const inertNote = inert.length && live.length ? ` ${inert.map((c) => c.name).join(', ')} (also ReShade) is never loaded by the game; the ReShade tab can move it out.` : ''
    if (live.length > 1) {
      return { ...base, dir, latest, state: 'broken', canInstall: false, canUpdate: false, warning, version: live[0].version, detail: `ReShade is in the game folder twice (${live.map((c) => c.name).join(' and ')}), so it would hook the game twice. Keep one of them (the ReShade tab shows which one NexusForge manages).` }
    }
    const { api, dx, detected } = await effectiveApi(t, rs)
    // Not 'unsupported': the ReShade tab can still switch it to DirectX / OpenGL when the game runs with those too.
    if (api === 'vulkan' && !copies.length) return { ...base, dir, latest, state: 'missing', canInstall: false, canUpdate: false, warning, blocked: `${detected.source === 'dxvk' ? detected.evidence + ' ' : ''}${VULKAN_NOTE}` }
    const copy = live[0] ?? copies[0]
    if (copy) {
      const mine = ours.some((n) => n.toLowerCase() === copy.name.toLowerCase())
      if (mine && managed) {
        const version = managed.version
        const build = (managed.meta?.build as ReshadeBuild | undefined) ?? copy.build
        const outdated = Boolean(latest && version && compareVersions(version, latest) < 0)
        const needAddon = wantAddon.length > 0 && build !== 'addon'
        return {
          ...base,
          dir,
          version,
          latest,
          state: outdated || needAddon ? 'outdated' : 'installed',
          canInstall: false,
          canUpdate: outdated || needAddon,
          refresh: needAddon,
          warning,
          proxy: copy.name,
          detail: needAddon
            ? `${wantAddon.map((m) => m.name).join(', ')} needs ReShade with add-on support; the standard build is installed. Updating switches to the add-on build.`
            : `Installed by NexusForge as ${copy.name} (${build === 'addon' ? 'with add-on support' : 'standard build'}${api ? `, ${API_LABEL[api]}` : ''}).${inertNote}`
        }
      }
      // A copy under a name the game never loads (dxgi.dll in GTA V).
      if (asiOnly && !ASI_RESHADE.test(copy.name)) {
        const asi = arch === 'x86' ? 'ReShade32.asi' : 'ReShade64.asi'
        return {
          ...base,
          dir,
          version: copy.version,
          latest,
          state: 'broken',
          via: mine ? 'nexusforge' : 'manual',
          canInstall: true,
          canUpdate: false,
          warning,
          proxy: copy.name,
          detail: `ReShade ${copy.version ?? ''} is in the game folder as ${copy.name}, but ${asiOnly.why}. NexusForge can put it in as ${asi}, which Script Hook V's ASI loader loads (your copy is kept as a backup).`
        }
      }
      return {
        ...base,
        dir,
        version: copy.version,
        latest,
        state: 'installed',
        via: 'manual',
        canInstall: false,
        canUpdate: false,
        warning,
        proxy: copy.name,
        detail: `Installed by hand as ${copy.name} (${copy.build === 'addon' ? 'with add-on support' : 'standard build'}). NexusForge leaves it as it is; the ReShade tab can switch it to a copy NexusForge keeps up to date.${wantAddon.length && copy.build !== 'addon' ? ` ${wantAddon.map((m) => m.name).join(', ')} needs the add-on build.` : ''}${inertNote}`
      }
    }
    if (!api) return { ...base, dir, latest, state: 'missing', canInstall: false, canUpdate: false, warning, blocked: `${detected.evidence} Pick the graphics API in the ReShade tab (the game's settings or its store page usually say: DirectX 9, DirectX 11/12 or OpenGL).` }
    const names = await moduleNames(api, dx, dir, arch, t.exeName)
    const choice = await chooseModule(dir, names, ours)
    if (!choice.name) {
      return { ...base, dir, latest, state: 'missing', canInstall: false, canUpdate: false, warning, blocked: `ReShade loads as ${names.join(' or ')} next to ${t.exeName}, and ${choice.taken.map((x) => `${x.name} is ${x.label}`).join(', ')}. NexusForge doesn't replace files that came with the game.` }
    }
    const fallback = choice.fallback ? ` ${choice.fallback} next to the game is ${choice.taken.find((x) => x.name.toLowerCase() === choice.fallback!.toLowerCase())?.label}; it stays, and ReShade goes in as ${choice.name}.` : ''
    if (managed) return { ...base, dir, version: managed.version, latest, state: 'missing', canInstall: false, canUpdate: false, warning, proxy: choice.name, detail: `In NexusForge storage; it goes into the game with the next deploy.${fallback}` }
    return {
      ...base,
      dir,
      latest,
      state: 'missing',
      canInstall: true,
      canUpdate: false,
      warning,
      proxy: choice.name,
      detail: `NexusForge installs ReShade${latest ? ` ${latest}` : ''} from reshade.me as ${choice.name} (${API_LABEL[api]}${detected.source === 'compat' ? ', from ReShade\'s compatibility list' : detected.source === 'none' || rs.api ? ', picked in the ReShade tab' : ''}).${fallback}${asiOnly ? ` ${asiOnly.why}; as an ASI plugin it loads through Script Hook V's ASI loader (installed with it).` : ''}`
    }
  },
  async install(game, _info, env, host, report, signal) {
    const t = await renderTarget(game, env)
    if (!t) throw new Error("NexusForge doesn't know the game's executable; set it in the game's Settings tab first.")
    if (t.compat?.banned) throw new Error(`ReShade's compatibility list marks ${t.exeName} as banning ReShade; NexusForge doesn't install it there.`)
    if (t.machine !== 'x86' && t.machine !== 'x64') throw new Error(`${t.exeName} is not a program ReShade can run in.`)
    const state = host.state(game.id)
    const rs = reshadeState(state)
    const { api } = await effectiveApi(t, rs)
    if (!api) throw new Error("NexusForge couldn't tell which graphics API the game uses; pick it in the ReShade tab.")
    if (api === 'vulkan') throw new Error(VULKAN_NOTE)
    const mods = (await host.mods?.(game.id)) ?? []
    const build: ReshadeBuild = rs.build ?? (addonMods(mods).length ? 'addon' : 'standard')
    report(`Looking up the newest ReShade on reshade.me…`)
    const bins = await reshadeBinaries(env, build, report, signal)
    const dllName = t.machine === 'x86' ? 'ReShade32.dll' : 'ReShade64.dll'
    const pkg = join(env.workDir, 'reshade', 'packages', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    await fsp.mkdir(pkg, { recursive: true })
    try {
      await fsp.copyFile(join(bins.dir, dllName), join(pkg, dllName))
      const marker: ReshadeMarker = { version: bins.version, build, arch: t.machine, api, thumbprint: bins.thumbprint }
      await fsp.writeFile(join(pkg, RESHADE_MARKER), JSON.stringify(marker, null, 2))
      report(`ReShade ${bins.version} (${build === 'addon' ? 'add-on build' : 'standard build'}, ${t.machine === 'x86' ? '32' : '64'}-bit) checked; adding it to ${game.name}…`)
      await host.installModFile(game.id, pkg, {
        name: 'ReShade',
        version: bins.version,
        source: { sourceId: FRAMEWORKS_ID, modId: RESHADE_ID, versionId: `${bins.version}|${build}|${t.machine}`, url: RESHADE_SITE, name: 'ReShade' }
      })
    } finally {
      await fsp.rm(pkg, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Shader packs

/** Lays a downloaded and extracted shader collection out the way ReShade's setup does. */
export async function layoutEffectPackage(extracted: string, pkg: EffectPackage, out: string, keepExisting: boolean): Promise<number> {
  const files = await walkFiles(extracted, { limit: 50_000 })
  const shadersDir = files.map((f) => f.rel.split('/')).flatMap((parts) => parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1))).find((p) => p[p.length - 1].toLowerCase() === 'shaders')?.join('/')
  const texturesDir = files.map((f) => f.rel.split('/')).flatMap((parts) => parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1))).find((p) => p[p.length - 1].toLowerCase() === 'textures')?.join('/')
  const fxDirs = files.filter((f) => /\.fx$/i.test(f.rel)).map((f) => f.rel.split('/').slice(0, -1).join('/')).sort((a, b) => a.length - b.length)
  const effectsRoot = shadersDir ?? fxDirs[0]
  const imageDirs = files.filter((f) => /\.(png|jpe?g)$/i.test(f.rel)).map((f) => f.rel.split('/').slice(0, -1).join('/')).sort((a, b) => a.length - b.length)
  const texturesRoot = texturesDir ?? imageDirs[0]
  const deny = new Set(pkg.denyEffectFiles.map((f) => f.toLowerCase()))
  const rel = (p: string) => p.replace(/^\.[\\/]/, '').split(/[\\/]/).filter(Boolean)
  let n = 0
  const copy = async (root: string | undefined, dest: string[], filter: (r: string) => boolean) => {
    if (root === undefined) return
    const prefix = root ? `${root}/` : ''
    for (const f of files) {
      if (!f.rel.startsWith(prefix)) continue
      const sub = f.rel.slice(prefix.length)
      if (!filter(sub)) continue
      const to = join(out, ...dest, ...sub.split('/'))
      if (keepExisting && (await fileExists(to))) continue
      await fsp.mkdir(dirname(to), { recursive: true })
      await fsp.copyFile(f.abs, to)
      n++
    }
  }
  await copy(effectsRoot, rel(pkg.installPath), (sub) => /\.(fx|fxh)$/i.test(sub) && !deny.has(basename(sub).toLowerCase()))
  if (texturesRoot !== undefined) await copy(texturesRoot, rel(pkg.textureInstallPath), (sub) => /\.(png|jpe?g|dds|bmp|tga)$/i.test(sub))
  return n
}

export const effectsLoader: LoaderAdapter = {
  id: EFFECTS_ID,
  name: 'ReShade shader packs',
  async status(game, _info, env, state, mods): Promise<LoaderStatus> {
    const managed = mods.find((m) => m.loaderId === EFFECTS_ID)
    const required = mods.some((m) => needs(m, EFFECTS_ID))
    const installed = (managed?.meta?.packages ?? '').split('|').filter(Boolean)
    const t = await renderTarget(game, env)
    const base = {
      id: EFFECTS_ID,
      name: 'ReShade shader packs',
      summary: "The effects ReShade's setup offers (the standard effects, SweetFX by default, more on request), from their authors' GitHub repositories.",
      requires: [RESHADE_ID],
      required,
      canRemove: Boolean(managed),
      via: 'github' as const,
      dir: t ? join(t.dir, 'reshade-shaders') : undefined
    }
    if (!t || t.compat?.banned) return { ...base, state: 'unsupported', canInstall: false, canUpdate: false, blocked: t ? 'ReShade is not installed for this game (its anti-cheat bans ReShade).' : "NexusForge doesn't know the game's executable." }
    // Effects a preset needs that neither the packs nor the game folder have.
    const have = new Set([...(await effectsIn(managed)), ...(await effectFilesIn(t.dir, [SHADERS_PATH]))])
    const missing = effectsWanted(mods).filter((fx) => !have.has(fx.toLowerCase()))
    let fixable: string[] = []
    if (missing.length) {
      const all = await effectPackages(env).catch(() => [] as EffectPackage[])
      fixable = missing.filter((fx) => packageForEffect(all, fx))
    }
    const rs = reshadeState(state)
    if (managed) {
      return {
        ...base,
        version: managed.version,
        state: fixable.length ? 'outdated' : 'installed',
        canInstall: false,
        canUpdate: fixable.length > 0,
        refresh: fixable.length > 0,
        detail: fixable.length ? `A preset needs ${fixable.join(', ')}, which the installed packs don't have; updating adds the packs that do.` : `${installed.join(', ') || 'Installed'}.`
      }
    }
    return {
      ...base,
      state: 'missing',
      canInstall: true,
      canUpdate: false,
      detail: rs.packages?.length ? `Installs ${rs.packages.join(', ')}.` : `Installs ReShade's standard effects and SweetFX${fixable.length ? `, plus the packs with ${fixable.join(', ')}` : ''}.`
    }
  },
  async install(game, _info, env, host, report, signal) {
    const t = await renderTarget(game, env)
    if (!t) throw new Error("NexusForge doesn't know the game's executable.")
    const rs = reshadeState(host.state(game.id))
    const mods = (await host.mods?.(game.id)) ?? []
    report('Reading ReShade\'s list of shader packs…')
    const all = await effectPackages(env)
    if (!all.length) throw new Error("ReShade's list of shader packs (github.com/crosire/reshade-shaders) could not be read.")
    const { packages } = packagesFor(all, effectsWanted(mods), rs.packages)
    const pkgDir = join(env.workDir, 'reshade', 'packages', `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    await fsp.mkdir(pkgDir, { recursive: true })
    try {
      // The standard effects last, so their ReShade.fxh / ReShadeUI.fxh are the ones that stay.
      const order = [...packages.filter((p) => !p.required), ...packages.filter((p) => p.required)]
      let i = 0
      for (const p of order) {
        const zip = join(env.workDir, 'reshade', 'downloads', `${p.id}-${p.name.replace(/[^\w.-]+/g, '_')}.zip`)
        await fsp.mkdir(dirname(zip), { recursive: true })
        report(`Downloading ${p.name}…`, i / order.length)
        await env.download(p.downloadUrl, zip, { allowedHosts: GITHUB_HOSTS, signal })
        const tmp = join(pkgDir, '..', `x-${basename(pkgDir)}-${p.id}`)
        try {
          await env.extract(zip, tmp)
          const n = await layoutEffectPackage(tmp, p, pkgDir, !p.required)
          report(`${p.name}: ${n} file${n === 1 ? '' : 's'}`, (i + 1) / order.length)
        } finally {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
          await fsp.rm(zip, { force: true }).catch(() => {})
        }
        i++
      }
      const marker: EffectsMarker = { packages: packages.map((p) => p.name), installedAt: Date.now() }
      await fsp.writeFile(join(pkgDir, EFFECTS_MARKER), JSON.stringify(marker, null, 2))
      const d = new Date()
      await host.installModFile(game.id, pkgDir, {
        name: 'ReShade shader packs',
        version: `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`,
        source: { sourceId: FRAMEWORKS_ID, modId: EFFECTS_ID, versionId: packages.map((p) => p.id).join(','), url: 'https://github.com/crosire/reshade-shaders', name: 'ReShade shader packs' }
      })
    } finally {
      await fsp.rm(pkgDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// ReShade.ini

/** Writes the setup's defaults into ReShade.ini (only what is missing). Returns true when something changed. */
export function applyIniDefaults(doc: IniDoc, compat?: CompatEntry, copyrightYear?: number, modDefines: string[] = []): boolean {
  let changed = false
  if (!doc.has('GENERAL', 'PreprocessorDefinitions')) {
    const v = compat?.values ?? {}
    // Depth settings a mod's own ReShade.ini brought count when ReShade's list has none for the game.
    const fromMod = (name: string) => (v.DepthReversed === undefined ? modDefines.find((d) => d.split('=')[0].trim() === name)?.split('=')[1]?.trim() : undefined)
    const reversed = v.DepthReversed ?? fromMod('RESHADE_DEPTH_INPUT_IS_REVERSED') ?? (copyrightYear !== undefined ? (copyrightYear >= 2012 ? '1' : '0') : '0')
    changed =
      doc.set('GENERAL', 'PreprocessorDefinitions', [
        `RESHADE_DEPTH_LINEARIZATION_FAR_PLANE=${fromMod('RESHADE_DEPTH_LINEARIZATION_FAR_PLANE') ?? '1000.0'}`,
        `RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN=${v.DepthUpsideDown ?? fromMod('RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN') ?? '0'}`,
        `RESHADE_DEPTH_INPUT_IS_REVERSED=${reversed}`,
        `RESHADE_DEPTH_INPUT_IS_LOGARITHMIC=${v.DepthLogarithmic ?? fromMod('RESHADE_DEPTH_INPUT_IS_LOGARITHMIC') ?? '0'}`
      ]) || changed
    if (['DepthCopyBeforeClears', 'DepthCopyAtClearIndex', 'DrawStatsHeuristic', 'UseAspectRatioHeuristics'].some((k) => v[k] !== undefined)) {
      changed = doc.set('DEPTH', 'DepthCopyBeforeClears', v.DepthCopyBeforeClears ?? '0') || changed
      changed = doc.set('DEPTH', 'DepthCopyAtClearIndex', v.DepthCopyAtClearIndex ?? '0') || changed
      changed = doc.set('DEPTH', 'DrawStatsHeuristic', v.DrawStatsHeuristic ?? '0') || changed
      changed = doc.set('DEPTH', 'UseAspectRatioHeuristics', v.UseAspectRatioHeuristics ?? '1') || changed
    }
  }
  if (!doc.has('INPUT')) {
    changed = doc.set('INPUT', 'KeyOverlay', '36,0,0,0') || changed
    changed = doc.set('INPUT', 'GamepadNavigation', '0') || changed
  }
  if (!doc.has('PROXY')) {
    changed = doc.set('PROXY', 'EnableProxyLibrary', '0') || changed
    changed = doc.set('PROXY', 'ProxyLibrary', '') || changed
  }
  // The shader folder NexusForge and mods deploy into must be searched (recursively, as the setup sets it).
  for (const [key, want] of [
    ['EffectSearchPaths', SHADERS_PATH],
    ['TextureSearchPaths', TEXTURES_PATH]
  ] as const) {
    const cur = doc.getList('GENERAL', key)
    const covered = (cur ?? []).some((p) => p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase() === want.replace(/\\\*\*$/, '').toLowerCase() + '\\**' || p.replace(/[\\/]+/g, '\\').toLowerCase() === want.toLowerCase())
    if (!covered) changed = doc.set('GENERAL', key, [...(cur ?? []).filter((p) => p.replace(/[\\/]+$/, '').toLowerCase() !== want.replace(/\\\*\*$/, '').toLowerCase()), want]) || changed
  }
  if (!doc.has('GENERAL', 'PresetPath')) changed = doc.set('GENERAL', 'PresetPath', '.\\ReShadePreset.ini') || changed
  return changed
}

/** Copyright year of an executable (the setup guesses reversed depth for games from 2012 on). */
async function copyrightYear(exe: string): Promise<number | undefined> {
  const years = (await readVersionStrings(exe).catch(() => undefined))?.copyright?.match(/(?:19|20)\d{2}/g)
  return years ? Number(years[years.length - 1]) : undefined
}

async function readIni(file: string): Promise<IniDoc | undefined> {
  try {
    return IniDoc.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Absolute path of a preset path from ReShade.ini (relative to ReShade's folder). */
export function presetAbs(dir: string, p: string): string {
  return /^[a-z]:[\\/]/i.test(p) ? p : join(dir, ...p.replace(/^\.[\\/]/, '').split(/[\\/]/).filter(Boolean))
}

/** Preset files the deployment put next to ReShade, newest mod first. */
async function deployedPresets(dir: string, info: IntegrationInfo, manifest: DeployManifest, mods: InstalledMod[]): Promise<string[]> {
  const ids = new Set(info.targets.filter((x) => x.dir.toLowerCase() === dir.toLowerCase()).map((x) => x.id))
  const order = new Map(mods.map((m) => [m.id, m.installedAt]))
  const out: Array<{ rel: string; at: number }> = []
  for (const e of manifest.entries) {
    if (!ids.has(e.target) || !/\.ini$/i.test(e.rel) || /^reshade\.ini$/i.test(basename(e.rel))) continue
    try {
      const st = await fsp.stat(join(dir, ...e.rel.split('/')))
      if (st.size > 2 * 1024 * 1024) continue
      if (!isPresetText(await fsp.readFile(join(dir, ...e.rel.split('/')), 'utf8'))) continue
    } catch {
      continue
    }
    out.push({ rel: `.\\${e.rel.replace(/\//g, '\\')}`, at: order.get(e.modId) ?? 0 })
  }
  return out.sort((a, b) => b.at - a.at).map((x) => x.rel)
}

export interface ConfigureResult {
  changed: boolean
  created: boolean
  removed: boolean
  preset?: string
}

/**
 * Keeps ReShade.ini right after a deployment: the setup's defaults when ReShade is there, the preset that came with
 * a mod as the active one (until the user picks one), and ReShade.ini taken out again when ReShade is gone and
 * NexusForge had created it. Never fails a deployment: problems go to the log and to verify.
 */
export async function configureReshade(game: Game, info: IntegrationInfo, manifest: DeployManifest, mods: InstalledMod[], env: IntegrationEnv, host: LoaderInstallHost): Promise<ConfigureResult> {
  const result: ConfigureResult = { changed: false, created: false, removed: false }
  const t = await renderTarget(game, env)
  if (!t) return result
  const state = host.state(game.id)
  const rs = { ...reshadeState(state) }
  const file = join(t.dir, 'ReShade.ini')
  const copies = await findReshade(t.dir)
  const managed = mods.find((m) => m.loaderId === RESHADE_ID)
  const managedLive = Boolean(managed && manifest.entries.some((e) => e.modId === managed.id))
  if (!copies.length) {
    if (rs.createdIni && (await fileExists(file))) {
      const keep = join(env.workDir, 'reshade', 'removed', game.id.replace(/[^\w.-]+/g, '_'), new Date().toISOString().replace(/[:.]/g, '-'))
      await fsp.mkdir(keep, { recursive: true })
      for (const n of ['ReShade.ini', 'ReShade.log']) {
        const from = join(t.dir, n)
        if (await fileExists(from)) await fsp.rename(from, join(keep, n)).catch(async () => {
          await fsp.copyFile(from, join(keep, n))
          await fsp.rm(from, { force: true })
        })
      }
      env.log.info(`ReShade is gone from ${game.name}; moved the ReShade.ini NexusForge had created to ${keep}`)
      result.removed = true
    }
    if (rs.createdIni || rs.autoPreset) {
      rs.createdIni = false
      rs.autoPreset = undefined
      host.saveState(game.id, { ...host.state(game.id), reshade: rs })
    }
    return result
  }
  const existing = await readIni(file)
  const doc = existing ?? new IniDoc()
  result.created = !existing
  const deployed = new Set(manifest.entries.map((e) => e.modId))
  const live = mods.filter((m) => deployed.has(m.id))
  const metaList = (key: string) => [...new Set(live.flatMap((m) => (m.meta?.[key] ?? '').split('|').filter(Boolean)))]
  let changed = applyIniDefaults(doc, t.compat, existing ? undefined : await copyrightYear(t.exe), metaList('reshadeDefines'))
  // Shader folders a mod's own ReShade.ini pointed at (outside reshade-shaders).
  for (const [key, meta] of [
    ['EffectSearchPaths', 'reshadeEffectPaths'],
    ['TextureSearchPaths', 'reshadeTexturePaths']
  ] as const) {
    const cur = doc.getList('GENERAL', key) ?? []
    const add = metaList(meta).filter((p) => !cur.some((c) => c.toLowerCase() === p.toLowerCase()))
    if (add.length) changed = doc.set('GENERAL', key, [...cur, ...add]) || changed
  }
  if (t.compat?.installTarget) {
    // The setup leaves a ReShade.ini next to the executable that points ReShade at its folder.
    const outer = join(dirname(t.exe), 'ReShade.ini')
    const o = (await readIni(outer)) ?? new IniDoc()
    if (o.set('INSTALL', 'BasePath', t.dir)) await fsp.writeFile(outer, o.serialize()).catch((err) => env.log.warn(`could not write ${outer}: ${(err as Error).message}`))
  }
  // The active preset.
  const current = doc.get('GENERAL', 'PresetPath')
  const currentExists = current ? await fileExists(presetAbs(t.dir, current)) : false
  if (!rs.presetPicked) {
    const lower = current?.toLowerCase()
    const isDefault = !lower || lower === '.\\reshadepreset.ini'
    const isOurs = Boolean(rs.autoPreset && lower === rs.autoPreset.toLowerCase())
    const pick = (await deployedPresets(t.dir, info, manifest, mods))[0]
    if (current && currentExists && !isDefault && !isOurs) {
      // A preset picked in ReShade's overlay (or before NexusForge): never changed again.
      rs.presetPicked = true
    } else if (pick && pick.toLowerCase() !== lower) {
      changed = doc.set('GENERAL', 'PresetPath', pick) || changed
      rs.autoPreset = pick
      result.preset = pick
    } else if (pick) {
      rs.autoPreset = pick
    } else if (isOurs && !currentExists) {
      // The mod with the preset is gone: back to ReShade's default preset file.
      changed = doc.set('GENERAL', 'PresetPath', '.\\ReShadePreset.ini') || changed
      rs.autoPreset = undefined
    }
  }
  if (changed) {
    try {
      await fsp.mkdir(t.dir, { recursive: true })
      await fsp.writeFile(file, doc.serialize())
      result.changed = true
      env.log.info(`${result.created ? 'created' : 'updated'} ${file}${result.preset ? ` (active preset ${result.preset})` : ''}`)
    } catch (err) {
      env.log.warn(`could not write ${file}: ${(err as Error).message}`)
    }
  }
  if (result.created && result.changed && managedLive) rs.createdIni = true
  host.saveState(game.id, { ...host.state(game.id), reshade: rs })
  return result
}

/** Changes ReShade.ini values the ReShade tab offers. Returns the new file text. */
export async function writeReshadeSettings(dir: string, patch: { presetPath?: string; keyOverlay?: string; performanceMode?: boolean; depth?: { reversed?: boolean; upsideDown?: boolean; logarithmic?: boolean } }): Promise<void> {
  const file = join(dir, 'ReShade.ini')
  const doc = (await readIni(file)) ?? new IniDoc()
  if (patch.presetPath !== undefined) doc.set('GENERAL', 'PresetPath', patch.presetPath)
  if (patch.keyOverlay !== undefined) doc.set('INPUT', 'KeyOverlay', patch.keyOverlay)
  if (patch.performanceMode !== undefined) doc.set('GENERAL', 'PerformanceMode', patch.performanceMode ? '1' : '0')
  if (patch.depth) {
    const defs = doc.getList('GENERAL', 'PreprocessorDefinitions') ?? []
    const set = (name: string, v: boolean | undefined) => {
      if (v === undefined) return
      const i = defs.findIndex((d) => d.split('=')[0].trim() === name)
      const entry = `${name}=${v ? 1 : 0}`
      if (i >= 0) defs[i] = entry
      else defs.push(entry)
    }
    set('RESHADE_DEPTH_INPUT_IS_REVERSED', patch.depth.reversed)
    set('RESHADE_DEPTH_INPUT_IS_UPSIDE_DOWN', patch.depth.upsideDown)
    set('RESHADE_DEPTH_INPUT_IS_LOGARITHMIC', patch.depth.logarithmic)
    doc.set('GENERAL', 'PreprocessorDefinitions', defs)
  }
  await fsp.writeFile(file, doc.serialize())
}

// ---------------------------------------------------------------------------
// Checks

/** Deployed mods that need ReShade (or are ReShade). */
function reshadeInUse(manifest: DeployManifest, mods: InstalledMod[]): { live: InstalledMod[]; needAddon: InstalledMod[] } {
  const deployed = new Set(manifest.entries.map((e) => e.modId))
  const live = mods.filter((m) => deployed.has(m.id) && (needs(m, RESHADE_ID) || m.loaderId === RESHADE_ID || m.loaderId === EFFECTS_ID))
  return { live, needAddon: addonMods(live) }
}

export async function verifyReshade(game: Game, _info: IntegrationInfo, manifest: DeployManifest, mods: InstalledMod[], env: IntegrationEnv): Promise<VerifyCheck[]> {
  const { live, needAddon } = reshadeInUse(manifest, mods)
  if (!live.length) return []
  const t = await renderTarget(game, env)
  if (!t) return [{ label: 'ReShade has a game executable to load into', ok: false, level: 'warning', detail: "Set the game's executable in its Settings tab." }]
  const checks: VerifyCheck[] = []
  const level = live.some((m) => needs(m, RESHADE_ID)) ? 'error' : 'warning'
  const copies = await findReshade(t.dir)
  checks.push({ label: `ReShade is next to ${t.exeName}`, ok: copies.length > 0, level, detail: copies.length ? copies.map((c) => c.name).join(', ') : `no ReShade in ${t.dir}` })
  if (copies.length > 1) checks.push({ label: 'Only one copy of ReShade', ok: false, level: 'warning', detail: `${copies.map((c) => c.name).join(' and ')} would both hook the game` })
  if (needAddon.length && copies.length) checks.push({ label: 'ReShade has add-on support', ok: copies.some((c) => c.build === 'addon'), level, detail: `${needAddon.map((m) => m.name).join(', ')} needs the add-on build` })
  if (copies.length) {
    const doc = await readIni(join(t.dir, 'ReShade.ini'))
    const paths = doc?.getList('GENERAL', 'EffectSearchPaths') ?? []
    checks.push({ label: 'ReShade.ini searches the shader folder', ok: paths.some((p) => /reshade-shaders[\\/]+shaders/i.test(p)), level: 'warning', detail: doc ? `EffectSearchPaths=${paths.join(',')}` : 'ReShade.ini is missing (ReShade creates one at its first start)' })
  }
  return checks
}

export interface ReshadeDiagnoseInput {
  game: Game
  mods: InstalledMod[]
  enabled: Set<string>
  env: IntegrationEnv
  state: IntegrationState
}

export async function diagnoseReshade(ctx: ReshadeDiagnoseInput): Promise<DiagnosticFinding[]> {
  const out: DiagnosticFinding[] = []
  const t = await renderTarget(ctx.game, ctx.env)
  if (!t) return out
  const copies = await findReshade(t.dir)
  const enabled = ctx.mods.filter((m) => ctx.enabled.has(m.id))
  const managed = ctx.mods.find((m) => m.loaderId === RESHADE_ID)
  if (t.compat?.banned && copies.length) {
    out.push({ code: 'NF-RSH-006', category: 'compatibility', severity: 'warning', confidence: 'confirmed', title: 'ReShade is installed in a game that bans it', detail: `ReShade's compatibility list marks ${t.exeName} as a game whose anti-cheat blocks or bans ReShade, and ${copies.map((c) => c.name).join(', ')} is in the game folder.`, evidence: copies.map((c) => join(t.dir, c.name)), fixes: [], userAction: 'Remove ReShade from this game before playing online.' })
  }
  const asiOnly = ASI_ONLY[t.exeName.toLowerCase()]
  const live = asiOnly ? copies.filter((c) => ASI_RESHADE.test(c.name)) : copies
  const inert = copies.filter((c) => !live.includes(c))
  if (inert.length && asiOnly) {
    out.push({
      code: 'NF-RSH-008',
      category: 'loader',
      severity: live.length ? 'info' : 'error',
      confidence: 'confirmed',
      title: live.length ? 'An unused copy of ReShade is in the game folder' : 'ReShade is installed under a name the game never loads',
      detail: `${inert.map((c) => c.name).join(', ')} is ReShade, but ${asiOnly.why}.${live.length ? ` ReShade runs as ${live[0].name}; the other copy only adds confusion.` : ' It goes in as an ASI plugin instead, loaded by Script Hook V\'s ASI loader.'}`,
      evidence: inert.map((c) => join(t.dir, c.name)),
      fixes: [{ id: 'reshade-setup', label: live.length ? 'Move the unused copy out' : 'Install ReShade as an ASI plugin', description: live.length ? `Moves ${inert.map((c) => c.name).join(', ')} into NexusForge's backup folder (it comes back if you remove ReShade in NexusForge).` : `Moves ${inert.map((c) => c.name).join(', ')} into NexusForge's backup folder and installs ReShade from reshade.me as an ASI plugin (with Script Hook V if it's missing). ReShade.ini and your presets stay.`, consequential: true, params: live.length ? { cleanup: '1' } : {} }]
    })
  }
  if (copies.length) {
    const rlog = await readReshadeLog(join(t.dir, 'ReShade.log'))
    // A later start shows in another log the game (or its loaders) writes at every start.
    let ranAt = 0
    for (const n of ['ScriptHookV.log', 'asiloader.log', 'BepInEx\\LogOutput.log', 'MelonLoader\\Latest.log', 'ue4ss\\UE4SS.log', 'player.log']) {
      const st = await fsp.stat(join(t.dir, n)).catch(() => undefined)
      if (st && st.mtimeMs > ranAt) ranAt = st.mtimeMs
    }
    if (rlog?.placeholder && ranAt > rlog.at + 60_000) {
      out.push({
        code: 'NF-RSH-007',
        category: 'runtime',
        severity: 'error',
        confidence: 'confirmed',
        title: 'ReShade was not loaded at the last start',
        detail: `The game ran after ReShade was installed (${new Date(ranAt).toLocaleString()}), but ReShade.log is still the note ReShade's setup leaves, so the game never loaded ${copies.map((c) => c.name).join(', ')}.${asiOnly ? ` ${asiOnly.why}.` : ' The DLL name probably does not match the API the game uses.'}`,
        evidence: [join(t.dir, 'ReShade.log'), ...copies.map((c) => join(t.dir, c.name))],
        fixes: asiOnly ? [{ id: 'reshade-setup', label: 'Install ReShade as an ASI plugin', description: `Moves ${copies.map((c) => c.name).join(', ')} into NexusForge's backup folder and installs ReShade as an ASI plugin.`, consequential: true, params: {} }] : [],
        userAction: asiOnly ? undefined : 'Pick another graphics API in the ReShade tab and let NexusForge install ReShade under that name.'
      })
    }
  }
  if (live.length > 1) {
    out.push({ code: 'NF-RSH-001', category: 'loader', severity: 'warning', confidence: 'confirmed', title: 'Two copies of ReShade', detail: `${live.map((c) => `${c.name} (${c.version ?? '?'})`).join(' and ')} are both in ${t.dir}; the game loads both and ReShade hooks it twice (doubled overlay, crashes).`, evidence: live.map((c) => join(t.dir, c.name)), fixes: [], userAction: `Keep one: delete or move the other file${managed ? ` (NexusForge manages ${managed.routes?.map((r) => basename(r.to)).join(', ')})` : ''}.` })
  }
  const addon = addonMods(enabled)
  if (addon.length && live.length && !live.some((c) => c.build === 'addon')) {
    out.push({
      code: 'NF-RSH-004',
      category: 'loader',
      severity: 'error',
      confidence: 'confirmed',
      title: 'A mod needs ReShade with add-on support',
      detail: `${addon.map((m) => m.name).join(', ')} is a ReShade add-on, and the ReShade in the game folder (${copies[0].name}) is the standard build, which doesn't load add-ons.`,
      evidence: copies.map((c) => `${join(t.dir, c.name)}: ${c.build} build`),
      modIds: addon.map((m) => m.id),
      fixes: [{ id: 'reshade-setup', label: 'Install ReShade with add-on support', description: `Downloads ReShade with full add-on support from reshade.me and puts it in as ${copies[0].name}${managed ? '' : ' (your current copy is kept as a backup and comes back if you remove ReShade in NexusForge)'}.`, consequential: true, params: { build: 'addon' } }]
    })
  }
  const log = await readReshadeLog(join(t.dir, 'ReShade.log'))
  if (log && copies.length) {
    if (log.version && !log.runtime && log.exited) {
      out.push({ code: 'NF-RSH-002', category: 'runtime', severity: 'warning', confidence: 'likely', title: "ReShade loaded but never attached to the game's picture", detail: `ReShade.log shows ReShade ${log.version} loaded from ${log.module ?? '?'}, but it never set up its overlay on the game's rendering${log.api ? ` (the game created a ${log.api} device)` : ''}. That usually means it went in for the wrong graphics API.`, evidence: [join(t.dir, 'ReShade.log')], fixes: [], userAction: 'Pick the graphics API the game really uses in the ReShade tab (its settings menu usually shows DirectX 11/12 or Vulkan), then start the game again.' })
    }
    if (log.failed.length) {
      out.push({ code: 'NF-RSH-003', category: 'runtime', severity: 'warning', confidence: 'confirmed', title: `${log.failed.length} ReShade effect${log.failed.length === 1 ? '' : 's'} failed to compile`, detail: `${log.failed.map((f) => f.file).join(', ')} did not compile at the last start, so they don't show up in the overlay.`, evidence: log.failed.flatMap((f) => [f.file, ...f.errors.slice(0, 3)]), fixes: [], userAction: 'Update the shader pack that has them (ReShade tab › Shader packs), or switch those effects off in the preset.' })
    }
  }
  // Effects the active preset needs.
  const doc = await readIni(join(t.dir, 'ReShade.ini'))
  const presetPath = doc?.get('GENERAL', 'PresetPath')
  if (copies.length && presetPath && (await fileExists(presetAbs(t.dir, presetPath)))) {
    try {
      const info = parsePreset(await fsp.readFile(presetAbs(t.dir, presetPath), 'utf8'))
      const have = await effectFilesIn(t.dir, doc?.getList('GENERAL', 'EffectSearchPaths') ?? [SHADERS_PATH])
      const missing = info.effects.filter((fx) => !have.has(fx.toLowerCase()))
      if (missing.length) {
        const all = await effectPackages(ctx.env).catch(() => [] as EffectPackage[])
        const pk = [...new Set(missing.map((fx) => packageForEffect(all, fx)?.name).filter((x): x is string => Boolean(x)))]
        const current = (managed && ctx.mods.find((m) => m.loaderId === EFFECTS_ID)?.meta?.packages?.split('|')) || []
        out.push({
          code: 'NF-RSH-005',
          category: 'configuration',
          severity: 'warning',
          confidence: 'confirmed',
          title: 'The active ReShade preset uses effects that are not installed',
          detail: `${basename(presetPath)} switches on ${missing.join(', ')}, which ReShade can't find${pk.length ? `; they come with ${pk.join(', ')}` : ''}.`,
          evidence: [presetAbs(t.dir, presetPath), ...missing],
          fixes: pk.length ? [{ id: 'reshade-setup', label: `Install ${pk.join(', ')}`, description: `Downloads ${pk.join(', ')} from GitHub as part of NexusForge's ReShade shader packs and deploys them.`, consequential: true, params: { packages: [...new Set([...current, ...pk])].join('|') } }] : [],
          userAction: pk.length ? undefined : "Install the shader pack the preset's page names, or pick another preset."
        })
      }
    } catch {
      // unreadable preset: nothing to say
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Every integration gets ReShade

const RESHADE_TARGET = 'reshade'

/** Deploy target id for files that go next to ReShade: the game target when it is the same folder. */
export function reshadeTargetId(info: Pick<IntegrationInfo, 'targets'>, dir: string): string {
  const game = info.targets.find((t) => t.id === 'game')
  return game && game.dir.toLowerCase().replace(/[\\/]+$/, '') === dir.toLowerCase().replace(/[\\/]+$/, '') ? 'game' : RESHADE_TARGET
}

const wrapped = new WeakMap<GameIntegration, GameIntegration>()

/** The integration with ReShade added: its loaders, its deploy target, and its configure / verify / diagnose steps. */
export function withReshade(i: GameIntegration): GameIntegration {
  const hit = wrapped.get(i)
  if (hit) return hit
  const w: GameIntegration = {
    ...i,
    loaders: [...i.loaders, reshadeLoader, effectsLoader],
    async inspect(game, env, state, mods) {
      const info = await i.inspect(game, env, state, mods)
      const t = await renderTarget(game, env).catch(() => undefined)
      // The extra target only exists when a mod uses it, so plans of other games stay as they were.
      if (t && reshadeTargetId(info, t.dir) === RESHADE_TARGET && mods.some((m) => (m.routes ?? []).some((r) => r.target === RESHADE_TARGET))) {
        info.targets.push({ id: RESHADE_TARGET, label: `ReShade (next to ${t.exeName})`, dir: t.dir })
      }
      for (const l of [reshadeLoader, effectsLoader]) {
        try {
          info.loaders.push(await l.status(game, info, env, state, mods))
        } catch (err) {
          env.log.warn(`${game.name}: ${l.name} status failed: ${(err as Error).message}`)
        }
      }
      return info
    },
    async configure(game, info, manifest, mods, env, host) {
      await i.configure?.(game, info, manifest, mods, env, host)
      await configureReshade(game, info, manifest, mods, env, host).catch((err) => env.log.warn(`${game.name}: ReShade configuration failed: ${(err as Error).message}`))
    },
    async verify(game, info, manifest, mods, env) {
      return [...((await i.verify?.(game, info, manifest, mods, env)) ?? []), ...(await verifyReshade(game, info, manifest, mods, env).catch(() => []))]
    },
    async diagnose(ctx: DiagnoseContext) {
      return [...((await i.diagnose?.(ctx)) ?? []), ...(await diagnoseReshade(ctx).catch(() => []))]
    }
  }
  wrapped.set(i, w)
  return w
}

// ---------------------------------------------------------------------------
// What the ReShade tab shows

export interface PresetView {
  path: string
  name: string
  active: boolean
  techniques: number
  missing: Array<{ file: string; pack?: string }>
}

export async function presetViews(dir: string, doc: IniDoc | undefined, packs: EffectPackage[]): Promise<PresetView[]> {
  // Without a PresetPath ReShade uses ReShadePreset.ini next to ReShade.ini.
  const active = (doc?.get('GENERAL', 'PresetPath') || 'ReShadePreset.ini').toLowerCase()
  const have = await effectFilesIn(dir, doc?.getList('GENERAL', 'EffectSearchPaths') ?? [SHADERS_PATH])
  const list: FoundPreset[] = await findPresets(dir)
  return list.map((p) => ({
    path: p.path,
    name: p.name,
    active: Boolean(active && (p.path.toLowerCase() === active || presetAbs(dir, active).toLowerCase() === p.abs.toLowerCase())),
    techniques: p.info.techniques.length,
    missing: p.info.effects.filter((fx) => !have.has(fx.toLowerCase())).map((file) => ({ file, pack: packageForEffect(packs, file)?.name }))
  }))
}

export { readIni, type ReshadeLog }
