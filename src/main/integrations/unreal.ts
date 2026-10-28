// Unreal Engine 4/5 games. Two kinds of mods:
// - .pak mods (with .utoc/.ucas on IoStore games) load by themselves from <Project>/Content/Paks/~mods.
// - UE4SS mods: Lua or C++ mods in UE4SS's Mods folder, and Blueprint mods in Content/Paks/LogicMods (loaded by
//   UE4SS's BPModLoaderMod). UE4SS comes from its official GitHub releases and goes next to the game's
//   <Project>-Win64-Shipping.exe as dwmapi.dll + UE4SS.dll. Games on UE 5.4 or newer (or whose version the exe
//   doesn't state) get the "experimental-latest" build, because the 3.0.1 release predates them.
// A UE4SS mod runs when its folder has enabled.txt (or it is switched on in mods.txt); NexusForge writes
// enabled.txt for the mods it deploys and removes it again with them.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DeployManifest, Game, InstalledMod, IntegrationInfo, LaunchCheck, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, LoaderInstallHost, StagedPackage } from './types'
import { antiCheatIn, antiCheatWarning, children, distributionOf, fileExists, folderName, isDocFile, route, skipDocs, unwrap } from './common'
import { releases } from './github'
import { identifyProxy } from './proxy'
import { classifyLoaderPackage, fromGithub, isLoaderPackage, loadersNeeded, verifyLoader, zipLoader, type ZipLoaderSpec } from './zip-loader'
import { fittingAssets } from '../sources/frameworks'
import { safeReaddir } from '../util/fs'
import { readVersionStrings } from '../library/exe-version'

export interface UnrealLayout {
  root: string
  /** <root>/<Project> */
  project: string
  projectName: string
  /** <Project>/Binaries/Win64 (or WinGDK) */
  bin: string
  shipping: string
}

const SHIPPING = /-(Win64|WinGDK)-Shipping\.exe$/i

/** Finds the Unreal project folder and the shipping executable of a game. */
export async function unrealLayout(game: Pick<Game, 'installDir' | 'exePath'>): Promise<UnrealLayout | undefined> {
  if (game.exePath && SHIPPING.test(basename(game.exePath))) {
    const bin = dirname(game.exePath)
    const project = dirname(dirname(bin))
    if (basename(dirname(bin)).toLowerCase() === 'binaries') return { root: dirname(project), project, projectName: basename(project), bin, shipping: game.exePath }
  }
  // The project folder sits next to the launcher .exe; repacks often add one more folder around the game.
  const roots = [...new Set([game.exePath ? dirname(game.exePath) : undefined, game.installDir].filter((x): x is string => Boolean(x)))]
  const inner = (await safeReaddir(game.installDir)).filter((e) => e.isDirectory())
  if (inner.length === 1) roots.push(join(game.installDir, inner[0].name))
  for (const root of roots) {
    for (const e of await safeReaddir(root)) {
      if (!e.isDirectory() || /^(engine|redist|_commonredist|directx)$/i.test(e.name)) continue
      for (const plat of ['Win64', 'WinGDK']) {
        const bin = join(root, e.name, 'Binaries', plat)
        const exe = (await safeReaddir(bin)).find((f) => f.isFile() && SHIPPING.test(f.name))
        if (exe) return { root, project: join(root, e.name), projectName: e.name, bin, shipping: join(bin, exe.name) }
      }
    }
  }
  return undefined
}

/** "++UE5+Release-5.5-CL-40574608" -> { major: 5, minor: 5 }; "UE5-CL-0" -> { major: 5 } */
export function parseUeVersion(raw: string | undefined): { major?: number; minor?: number } {
  if (!raw) return {}
  const full = raw.match(/UE(\d)\+Release-(\d)\.(\d+)/i)
  if (full) return { major: Number(full[2]), minor: Number(full[3]) }
  const major = raw.match(/\bUE(\d)\b|^\+\+UE(\d)/i)
  if (major) return { major: Number(major[1] ?? major[2]) }
  return {}
}

/** UE4SS's folder layout: 3.0.1 keeps UE4SS.dll next to the exe, newer builds in a ue4ss subfolder. */
async function ue4ssDir(bin: string): Promise<{ dir: string; installed: boolean; flavour?: 'stable' | 'experimental' }> {
  if (await fileExists(join(bin, 'ue4ss', 'UE4SS.dll'))) return { dir: join(bin, 'ue4ss'), installed: true, flavour: 'experimental' }
  if (await fileExists(join(bin, 'UE4SS.dll'))) return { dir: bin, installed: true, flavour: 'stable' }
  return { dir: bin, installed: false }
}

/** The engine version string of the shipping exe (NexusForge's game-version reader skips engine versions on purpose). */
async function engineVersion(env: IntegrationEnv, u: UnrealLayout): Promise<{ major?: number; minor?: number }> {
  return parseUeVersion((await env.fileVersion(u.shipping)) ?? (await readVersionStrings(u.shipping).catch(() => undefined))?.version)
}

async function wantsExperimental(env: IntegrationEnv, u: UnrealLayout): Promise<boolean> {
  const v = await engineVersion(env, u)
  if (v.major === 4) return false
  if (v.major === 5 && v.minor !== undefined && v.minor <= 3) return false
  return true
}

export const ue4ssSpec: ZipLoaderSpec = {
  id: 'ue4ss',
  name: 'UE4SS',
  summary: 'Script system for Unreal Engine games: runs Lua and C++ mods and loads Blueprint mods from LogicMods.',
  repo: 'UE4SS-RE/RE-UE4SS',
  target: 'bin',
  targetDir: (game, info) => info?.targets.find((t) => t.id === 'bin')?.dir ?? (game.exePath ? dirname(game.exePath) : game.installDir),
  markers: ['dwmapi.dll'],
  proxy: { file: 'dwmapi.dll', names: ['dwmapi.dll'], owner: 'ue4ss' },
  async present(game, info) {
    const bin = ue4ssSpec.targetDir(game, info)
    const u = await ue4ssDir(bin)
    const missing: string[] = []
    if (!u.installed) missing.push('UE4SS.dll')
    if (!(await fileExists(join(bin, 'dwmapi.dll')))) missing.push('dwmapi.dll')
    return { ok: !missing.length, missing }
  },
  async resolve(env, ctx) {
    const u = await unrealLayout(ctx.game)
    const experimental = u ? await wantsExperimental(env, u) : true
    const list = (await releases(env, 'UE4SS-RE/RE-UE4SS')).filter((r) => (experimental ? r.tag_name === 'experimental-latest' : !r.prerelease))
    const fit = fittingAssets('ue4ss', list, ctx.rt)[0]
    if (!fit) throw new Error(`No ${experimental ? 'experimental' : 'stable'} UE4SS release on GitHub has the UE4SS zip.`)
    const d = fromGithub(fit.release, fit.asset)
    // experimental-latest is a moving tag: its version is the build in the file name.
    if (experimental) d.version = fit.asset.name.replace(/^UE4SS_v|\.zip$/gi, '')
    return d
  },
  async unsupported(game) {
    return (await unrealLayout(game)) ? undefined : `No <Project>/Binaries/Win64/*-Win64-Shipping.exe in ${game.installDir}: this doesn't look like an Unreal Engine game, so UE4SS can't run in it.`
  },
  async warning(game) {
    const u = await unrealLayout(game)
    return antiCheatWarning(await antiCheatIn([game.installDir, ...(u ? [u.project, u.bin] : [])]), 'UE4SS')
  }
}
export const ue4ssLoader = zipLoader(ue4ssSpec)

const PAK = /\.(pak|utoc|ucas|sig)$/i
const STOP = new Set(['content', 'paks', '~mods', 'logicmods', 'binaries', 'mods', 'scripts', 'dlls', 'ue4ss'])

/** UE4SS mod folders in a package: the folder that holds Scripts/main.lua or dlls/main.dll. */
export function ue4ssModDirs(pkg: StagedPackage): string[] {
  const dirs = new Set<string>()
  for (const f of pkg.files) {
    const m = f.rel.match(/^(?:(.*)\/)?(?:scripts\/main\.lua|dlls\/main\.dll)$/i)
    if (m) dirs.add(m[1] ?? '')
  }
  return [...dirs]
}

export function classifyUnreal(pkg: StagedPackage, u: Pick<UnrealLayout, 'projectName'>, modName: string): Classification {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const files = pkg.files
  const root = unwrap(files, new Set([...STOP, u.projectName.toLowerCase()]))
  const pre = root ? `${root}/` : ''
  const rel = (f: string) => f.slice(pre.length)
  const inside = files.filter((f) => f.rel.toLowerCase().startsWith(pre.toLowerCase()))
  const top = children(files, root)
  const proj = u.projectName.toLowerCase()

  // Laid out like the game folder: <Project>/Content/Paks/~mods/…, or like the project folder: Content/…, Binaries/….
  const mirrorsRoot = top.dirs.some((d) => d.toLowerCase() === proj)
  const mirrorsProject = !mirrorsRoot && top.dirs.some((d) => /^(content|binaries)$/i.test(d))
  if (mirrorsRoot || mirrorsProject) {
    routes.push(route(root, mirrorsRoot ? 'game' : 'project'))
    skipped.push(...skipDocs(files, root))
    const needs = inside.some((f) => /(^|\/)(logicmods\/|binaries\/win64\/(ue4ss\/)?mods\/)/i.test(rel(f.rel)))
    return { kind: 'files', routes, skipped, checks, rootPath: root, needsLoader: needs ? 'ue4ss' : undefined }
  }

  const consumed = new Set<string>()
  const modDirs = ue4ssModDirs(pkg).filter((d) => !d || d.toLowerCase().startsWith(pre.toLowerCase()) || d.toLowerCase() === root.toLowerCase())
  for (const d of modDirs) {
    const name = d && d.toLowerCase() !== root.toLowerCase() ? basename(d) : folderName(modName).replace(/\s+/g, '')
    if (/^(mods|ue4ss)$/i.test(name)) continue
    routes.push(route(d, 'ue4ss-mods', name))
    for (const f of files) if (!d || f.rel.toLowerCase().startsWith(`${d.toLowerCase()}/`)) consumed.add(f.rel)
  }
  let logic = false
  for (const f of inside) {
    if (consumed.has(f.rel) || !PAK.test(f.rel)) continue
    const isLogic = /(^|\/)logicmods\//i.test(f.rel)
    logic ||= isLogic
    routes.push(route(f.rel, isLogic ? 'logicmods' : 'paks', basename(f.rel)))
    consumed.add(f.rel)
  }
  const left = inside.filter((f) => !consumed.has(f.rel))
  if (!routes.length) {
    // Nothing NexusForge recognizes: the files go into the game folder as they are laid out.
    routes.push(route(root, 'game'))
    skipped.push(...skipDocs(files, root))
    checks.push({ level: 'warning', code: 'unknown_layout', message: 'No .pak file and no UE4SS mod in this package; its files go into the game folder as they are laid out. If the mod page says otherwise, change the content folder in the mod settings.' })
    return { kind: 'files', routes, skipped, checks, rootPath: root }
  }
  for (const f of left) {
    const name = basename(f.rel)
    skipped.push({ path: f.rel, reason: isDocFile(name) ? 'read-me file, not part of the mod' : 'not a .pak file or part of a UE4SS mod' })
  }
  const paks = routes.filter((r) => r.target === 'paks' && /\.pak$/i.test(r.from)).length
  if (routes.some((r) => r.target === 'paks') && !paks) checks.push({ level: 'warning', message: 'This package has .utoc/.ucas files but no .pak; the game only loads them together with the .pak of the same name.' })
  const needsUe4ss = logic || routes.some((r) => r.target === 'ue4ss-mods')
  if (logic) checks.push({ level: 'info', message: "Blueprint mod (LogicMods): it runs through UE4SS's BPModLoaderMod." })
  return { kind: needsUe4ss ? 'plugin' : 'files', routes, skipped, checks, rootPath: root, needsLoader: needsUe4ss ? 'ue4ss' : undefined }
}

async function modsTxtEnabled(modsDir: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const text = await fsp.readFile(join(modsDir, 'mods.txt'), 'utf8').catch(() => '')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^;:#][^:]*?)\s*:\s*([01])\s*$/)
    if (m) out.set(m[1].toLowerCase(), m[2] === '1')
  }
  return out
}

/** Reads UE4SS.log from the last start. */
export async function readUe4ssLog(bin: string, since: number): Promise<LaunchCheck> {
  const dir = (await ue4ssDir(bin)).dir
  const file = join(dir, 'UE4SS.log')
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return { ran: false, loaded: [], errors: [], logFile: file, at: st.mtimeMs }
    const text = await fsp.readFile(file, 'utf8')
    const loaded = [...new Set([...text.matchAll(/Starting (?:Lua|C\+\+) mod '([^']+)'/g)].map((m) => m[1]))]
    const errors = text
      .split(/\r?\n/)
      .filter((l) => /\[(error|fatal)\]|\berror\b:/i.test(l))
      .slice(0, 20)
    const version = text.match(/UE4SS - v([\w.\-]+)/)?.[1]
    return { ran: true, loader: version ? `UE4SS ${version}` : 'UE4SS', loaded, errors, logFile: file, at: st.mtimeMs }
  } catch {
    return { ran: false, loaded: [], errors: [], logFile: file }
  }
}

export const unrealIntegration: GameIntegration = {
  id: 'unreal',
  revision: 1,
  loadVerifiable: false,
  loaders: [ue4ssLoader],
  async matches(game) {
    return Boolean(await unrealLayout(game))
  },
  async inspect(game, env, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo> {
    const u = await unrealLayout(game)
    const problems: string[] = []
    if (game.missing) problems.push('The install folder is missing.')
    else if (!u) problems.push('The Unreal project folder (with Binaries/Win64/*-Shipping.exe) was not found.')
    const project = u?.project ?? game.installDir
    const bin = u?.bin ?? game.installDir
    const ue = await ue4ssDir(bin)
    const v = u ? await engineVersion(env, u) : {}
    // Where UE4SS keeps its Mods: where it is, or where the build NexusForge would install puts them.
    const modsBase = ue.installed ? ue.dir : u && !(await wantsExperimental(env, u)) ? bin : join(bin, 'ue4ss')
    const info: IntegrationInfo = {
      gameId: game.id,
      integrationId: 'unreal',
      name: `${game.name} · Unreal Engine${v.major ? ` ${v.major}${v.minor !== undefined ? `.${v.minor}` : ''}` : ''}`,
      support: 'partial',
      distribution: await distributionOf(game),
      version: game.version || undefined,
      valid: !problems.length,
      problems,
      targets: [
        { id: 'game', label: 'Game folder', dir: u?.root ?? game.installDir },
        { id: 'project', label: `${u?.projectName ?? 'Project'} folder`, dir: project },
        { id: 'paks', label: '~mods (pak mods)', dir: join(project, 'Content', 'Paks', '~mods'), create: true },
        { id: 'logicmods', label: 'LogicMods (Blueprint mods)', dir: join(project, 'Content', 'Paks', 'LogicMods'), create: true },
        { id: 'bin', label: 'Binaries/Win64', dir: bin },
        { id: 'ue4ss-mods', label: 'UE4SS Mods', dir: join(modsBase, 'Mods'), create: true }
      ],
      loaders: [],
      launchOptions: [{ id: 'default', label: 'Play', available: true, primary: true }],
      capabilities: [
        '.pak mods (with their .utoc/.ucas) go into Content/Paks/~mods, where the game loads them by itself.',
        'Installs UE4SS from its official GitHub release with one click, or by itself when a Lua, C++ or Blueprint (LogicMods) mod needs it; switches those mods on with enabled.txt.',
        'Never replaces a dwmapi.dll that came with the game; files like OnlineFix\'s winmm.dll are left alone.',
        'Packages laid out like the game folder (<Project>/Content/Paks/…) are deployed as they are.'
      ],
      warnings: [],
      limitations: ['NexusForge checks that the files are where Unreal and UE4SS load them, not that a mod works with this game version. Reading UE4SS.log after you play shows which Lua/C++ mods started.'],
      inspectedAt: Date.now()
    }
    info.loaders = [await ue4ssLoader.status(game, info, env, state, mods)]
    const ac = await antiCheatIn([game.installDir, project, bin])
    if (ac) info.warnings.push(antiCheatWarning(ac, 'Mods')!)
    return info
  },
  async classify(pkg, game, info) {
    if (isLoaderPackage(ue4ssSpec, pkg) && pkg.files.some((f) => /(^|\/)ue4ss\.dll$/i.test(f.rel))) return classifyLoaderPackage(ue4ssSpec, pkg, 'dwmapi.dll')
    const u = (await unrealLayout(game)) ?? { projectName: basename(info.targets.find((t) => t.id === 'project')?.dir ?? '') }
    return classifyUnreal(pkg, u, pkg.name)
  },
  async configure(game, info, manifest: DeployManifest, mods, env, host: LoaderInstallHost) {
    // UE4SS mod folders NexusForge deployed get enabled.txt unless mods.txt already decides.
    const modsDir = info.targets.find((t) => t.id === 'ue4ss-mods')?.dir
    if (!modsDir) return
    const state = host.state(game.id)
    const before = state.createdFiles ?? []
    const folders = new Set(manifest.entries.filter((e) => e.target === 'ue4ss-mods' && e.rel.includes('/')).map((e) => e.rel.split('/')[0]))
    const listed = await modsTxtEnabled(modsDir)
    const want = new Set<string>()
    for (const name of folders) {
      if (listed.has(name.toLowerCase())) continue
      const file = join(modsDir, name, 'enabled.txt')
      want.add(file.toLowerCase())
      if (!(await fileExists(file))) await fsp.writeFile(file, '')
    }
    const keep: string[] = []
    for (const f of new Set([...before, ...[...want]])) {
      if (want.has(f.toLowerCase())) {
        keep.push(f)
        continue
      }
      await fsp.rm(f, { force: true }).catch(() => {})
      await fsp.rmdir(dirname(f)).catch(() => {}) // only when empty
    }
    state.createdFiles = keep
    host.saveState(game.id, state)
    void mods
    void env
  },
  async verify(game, info, manifest, mods): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = []
    const deployed = new Set(manifest.entries.map((e) => e.modId))
    const needers = mods.filter((m) => deployed.has(m.id) && loadersNeeded(m).includes('ue4ss'))
    if (needers.length || mods.some((m) => m.loaderId === 'ue4ss' && deployed.has(m.id))) checks.push(...(await verifyLoader(ue4ssSpec, game, info, mods, needers.length ? 'error' : 'warning')))
    const modsDir = info.targets.find((t) => t.id === 'ue4ss-mods')?.dir
    if (modsDir) {
      const listed = await modsTxtEnabled(modsDir)
      const folders = new Set(manifest.entries.filter((e) => e.target === 'ue4ss-mods' && e.rel.includes('/')).map((e) => e.rel.split('/')[0]))
      for (const name of folders) {
        const on = listed.get(name.toLowerCase()) ?? (await fileExists(join(modsDir, name, 'enabled.txt')))
        checks.push({ label: `UE4SS mod ${name} is switched on`, ok: on, level: 'error', detail: on ? undefined : listed.get(name.toLowerCase()) === false ? 'mods.txt has it at 0' : 'no enabled.txt' })
      }
      if (manifest.entries.some((e) => e.target === 'logicmods')) {
        const bp = listed.get('bpmodloadermod')
        checks.push({ label: "UE4SS's BPModLoaderMod is on (it loads LogicMods)", ok: bp !== false && (await fileExists(join(modsDir, 'BPModLoaderMod'))), level: 'error' })
      }
    }
    const paks = manifest.entries.filter((e) => e.target === 'paks' && /\.pak$/i.test(e.rel))
    if (paks.length) checks.push({ label: `${paks.length} .pak mod file(s) in ~mods`, ok: true, level: 'info' })
    const dll = join(info.targets.find((t) => t.id === 'bin')?.dir ?? '', 'dwmapi.dll')
    if (needers.length && (await fileExists(dll))) {
      const who = await identifyProxy(dll, 'dwmapi.dll')
      if (who.owner !== 'ue4ss') checks.push({ label: 'dwmapi.dll is UE4SS', ok: false, level: 'error', detail: `it is ${who.label}` })
    }
    return checks
  },
  async checkLaunch(game, info, since) {
    return readUe4ssLog(info.targets.find((t) => t.id === 'bin')?.dir ?? game.installDir, since)
  }
}
