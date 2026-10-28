// Grand Theft Auto V (Legacy and Enhanced), any copy: Steam, Rockstar, Epic, or a game folder on a drive.
//
// - Script Hook V (Alexander Blade, dev-c.com) is the base of nearly every script mod. dev-c.com only offers the
//   newest build, which supports exactly the patches its page lists; NexusForge reads that page, compares it with
//   GTA5.exe's version, and installs the official zip as its install note says (the contents of bin\ into the game
//   folder; the sample NativeTrainer.asi is left out). Its dinput8.dll / xinput1_4.dll are the ASI loader.
//   The download wants dev-c.com's page as Referer, as when the Download link is clicked there.
// - Script Hook V .NET (GitHub) runs C#/VB scripts from the scripts folder.
// - .asi plugins go next to GTA5.exe; .NET scripts into scripts\.
// - OpenIV packages (.oiv) and "mods" folder replacements need OpenIV, which NexusForge can't drive.
// Script Hook V closes the game when it goes online; mods are for story mode.

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo, LaunchCheck, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, StagedPackage } from './types'
import { gameDir } from './bepinex'
import { antiCheatIn, children, compareVersions, distributionOf, fileExists, isDocFile, route, unwrap } from './common'
import { fileStrings, identifyProxy } from './proxy'
import { classifyLoaderPackage, isLoaderPackage, loadersNeeded, verifyLoader, zipLoader, type LoaderDownload, type ZipLoaderSpec } from './zip-loader'
import { findPreset } from '../library/presets'

const DEVC_PAGE = 'https://www.dev-c.com/gtav/scripthookv/'
const DEVC_HOSTS = ['www.dev-c.com', 'dev-c.com']

export interface ShvRelease {
  file: string
  url: string
  version: string
  /** Game versions it supports ("1.0.3889.0" Legacy, "1.0.1158.13" Enhanced). */
  patches: string[]
  released?: string
}

/** Reads the newest Script Hook V and the patches it supports from dev-c.com's page. */
export function parseDevcPage(html: string): ShvRelease | undefined {
  const href = html.match(/href="(\/files\/(ScriptHookV_[\d._]+\.zip))"/i)
  if (!href) return undefined
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
  const patches = text.match(/Supported patches\s+([\d.]+(?:\s*\/\s*[\d.]+)*)/i)?.[1].split('/').map((s) => s.trim()) ?? []
  const version = text.match(/Version\s+v([\d.]+(?:\s*\/\s*[\d.]+)?)/i)?.[1].replace(/\s+/g, '') ?? href[2].replace(/^ScriptHookV_|\.zip$/g, '').replace('_', '/')
  return { file: href[2], url: `https://www.dev-c.com${href[1]}`, version, patches, released: text.match(/Released\s+(\d{1,2} \w{3} \d{4})/)?.[1] }
}

let devcCache: { at: number; rel: ShvRelease } | undefined
async function devcRelease(env: IntegrationEnv): Promise<ShvRelease> {
  if (devcCache && Date.now() - devcCache.at < 30 * 60_000) return devcCache.rel
  const rel = parseDevcPage(await env.fetchText(DEVC_PAGE))
  if (!rel) throw new Error("dev-c.com's Script Hook V page has no download link NexusForge recognizes.")
  devcCache = { at: Date.now(), rel }
  return rel
}

export function clearDevcCache(): void {
  devcCache = undefined
}

export function gtaExe(game: Pick<Game, 'exePath' | 'installDir'>): string {
  const dir = gameDir(game)
  return game.exePath && /^gta5(_enhanced)?\.exe$/i.test(basename(game.exePath)) ? game.exePath : join(dir, 'GTA5.exe')
}

async function gtaVersion(game: Game, env: IntegrationEnv): Promise<string | undefined> {
  const exe = gtaExe(game)
  return (await env.fileVersion(exe)) ?? (await env.fileVersion(join(gameDir(game), 'GTA5_Enhanced.exe'))) ?? undefined
}

export const shvSpec: ZipLoaderSpec = {
  id: 'scripthookv',
  name: 'Script Hook V',
  summary: 'Runs GTA V script mods (.asi plugins), with the ASI loader that loads them.',
  target: 'game',
  targetDir: (game) => gameDir(game),
  markers: ['ScriptHookV.dll'],
  packageMarkers: ['ScriptHookV.dll', 'dinput8.dll'],
  notInPackage: /^(?!(.*\/)?NativeTrainer\.asi$).*\.asi$/i,
  proxy: { file: 'dinput8.dll', names: ['dinput8.dll'], owner: 'asi-loader' },
  leaveOut: [[/^NativeTrainer\.asi$/i, "Script Hook V's sample trainer (copy it next to GTA5.exe yourself if you want it)"]],
  async resolve(env): Promise<LoaderDownload> {
    const rel = await devcRelease(env)
    return { url: rel.url, fileName: rel.file, version: rel.version, pageUrl: DEVC_PAGE, headers: { Referer: DEVC_PAGE }, allowedHosts: DEVC_HOSTS }
  },
  async unsupported(game, env) {
    let rel: ShvRelease
    try {
      rel = await devcRelease(env)
    } catch {
      return undefined // offline: checked again when installing
    }
    const v = await gtaVersion(game, env)
    if (!v || !rel.patches.length || rel.patches.some((p) => compareVersions(p, v) === 0)) return undefined
    return `Script Hook V v${rel.version} supports GTA V ${rel.patches.join(' and ')}; this copy is ${v}. dev-c.com only offers the newest Script Hook V, so the game has to be on one of those patches (Script Hook V usually follows a new patch within days).`
  },
  async warning(game) {
    const ac = await antiCheatIn([gameDir(game)])
    return `Story mode only: Script Hook V closes the game when it goes online.${ac ? ` Its args.txt starts the game with -nobattleye, as its install note says (BattlEye only guards online play).` : ''}`
  }
}

export const shvdnSpec: ZipLoaderSpec = {
  id: 'shvdn',
  name: 'Script Hook V .NET',
  summary: 'Runs C# / VB scripts (.dll, .cs, .vb) from the scripts folder. Builds on Script Hook V.',
  repo: 'scripthookvdotnet/scripthookvdotnet',
  target: 'game',
  targetDir: (game) => gameDir(game),
  markers: ['ScriptHookVDotNet.asi'],
  packageMarkers: ['ScriptHookVDotNet.asi', 'ScriptHookVDotNet3.dll'],
  notInPackage: /(^|\/)scripts\//i,
  requires: ['scripthookv'],
  leaveOut: [[/\.xml$/i, 'API documentation for script authors']],
  async warning() {
    return 'Its last GitHub release (3.6.0) is from 2022; if ScriptHookVDotNet.log shows errors after a game patch, the Script Hook V .NET page has newer nightly builds.'
  }
}

export const shvLoader = zipLoader(shvSpec)
export const shvdnLoader = zipLoader(shvdnSpec)

/** DLLs and source files written against Script Hook V .NET. */
async function isDotNetScript(pkg: StagedPackage, rel: string): Promise<boolean> {
  if (/\.(cs|vb)$/i.test(rel)) return true
  if (!/\.dll$/i.test(rel)) return false
  try {
    return /ScriptHookVDotNet|GTA\.Native/.test(await fileStrings(join(pkg.dir, rel), 4 * 1024 * 1024))
  } catch {
    return false
  }
}

const GTA_DIRS = new Set(['scripts', 'mods', 'lml', 'plugins'])

export async function classifyGta(pkg: StagedPackage, game: Game): Promise<Classification> {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const needs = new Set<string>()
  const oiv = pkg.files.filter((f) => /\.oiv$/i.test(f.rel))
  if (oiv.length) {
    checks.push({ level: 'error', code: 'oiv', message: `OpenIV package (${basename(oiv[0].rel)}): only OpenIV's Package Installer can install it, because it edits the game's archives. Open it with OpenIV.` })
    return { kind: 'files', routes, skipped, checks, rootPath: '' }
  }
  const root = unwrap(pkg.files, GTA_DIRS)
  const top = children(pkg.files, root)
  const j = (a: string, b: string) => (a ? `${a}/${b}` : b)
  for (const d of top.dirs) {
    const lower = d.toLowerCase()
    if (lower === 'scripts') {
      routes.push(route(j(root, d), 'scripts'))
      const sub = pkg.files.filter((f) => f.rel.toLowerCase().startsWith(`${j(root, d).toLowerCase()}/`))
      let dotnet = false
      for (const f of sub) if (await isDotNetScript(pkg, f.rel)) dotnet = true
      needs.add('scripthookv')
      if (dotnet) needs.add('shvdn')
    } else if (lower === 'mods') {
      routes.push(route(j(root, d), 'game', 'mods'))
      checks.push({ level: 'warning', code: 'openiv_mods', message: 'This mod replaces game archives through the "mods" folder, which only works with OpenIV.asi (OpenIV › Tools › ASI Manager). NexusForge puts the files there but can\'t install OpenIV.asi.' })
    } else if (lower === 'lml') {
      routes.push(route(j(root, d), 'game', 'lml'))
      checks.push({ level: 'warning', code: 'lml', message: "This mod is for Lenny's Mod Loader (the lml folder); it only works with LML installed." })
    } else {
      routes.push(route(j(root, d), 'game', d))
    }
  }
  for (const f of top.files) {
    const rel = j(root, f)
    if (isDocFile(f)) skipped.push({ path: rel, reason: 'read-me file, not part of the mod' })
    else if (/^(dinput8|xinput1_4|dsound|version)\.dll$/i.test(f)) skipped.push({ path: rel, reason: 'an ASI loader / proxy DLL; NexusForge installs Script Hook V and its ASI loader itself' })
    else if (/^ScriptHookV\.dll$/i.test(f)) skipped.push({ path: rel, reason: 'a copy of Script Hook V; NexusForge installs the version that fits the game' })
    else if (/\.asi$/i.test(f)) {
      routes.push(route(rel, 'game', f))
      needs.add('scripthookv')
    } else if (await isDotNetScript(pkg, rel)) {
      routes.push(route(rel, 'scripts', f))
      needs.add('scripthookv')
      needs.add('shvdn')
    } else routes.push(route(rel, 'game', f))
  }
  if (!routes.length) checks.push({ level: 'error', code: 'empty', message: 'Nothing to install besides read-me files and loader DLLs.' })
  void game
  const list = [...needs]
  return { kind: list.length ? 'plugin' : 'files', routes, skipped, checks, rootPath: root, needsLoader: list[0], needsLoaders: list.slice(1) }
}

async function readLog(file: string, since: number, loader: string, loadedRe: RegExp): Promise<LaunchCheck> {
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return { ran: false, loaded: [], errors: [], logFile: file, at: st.mtimeMs }
    const text = await fsp.readFile(file, 'utf8')
    const loaded = [...new Set([...text.matchAll(loadedRe)].map((m) => m[1]))]
    const errors = text
      .split(/\r?\n/)
      .filter((l) => /\b(ERROR|FATAL|CRITICAL)\b|\[ERROR\]/i.test(l))
      .slice(0, 20)
    return { ran: true, loader, loaded, errors, logFile: file, at: st.mtimeMs }
  } catch {
    return { ran: false, loaded: [], errors: [], logFile: file }
  }
}

export const gta5Integration: GameIntegration = {
  id: 'gta5',
  revision: 1,
  loadVerifiable: false,
  loaders: [shvLoader, shvdnLoader],
  async matches(game) {
    if (game.platform === 'steam' && (game.platformId === '271590' || game.platformId === '3240220')) return true
    if (game.exePath && /^gta5(_enhanced)?\.exe$/i.test(basename(game.exePath))) return true
    return findPreset(game)?.sources?.nexus === 'gta5' && (await fileExists(join(gameDir(game), 'GTA5.exe')))
  },
  async inspect(game, env, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo> {
    const dir = gameDir(game)
    const exe = gtaExe(game)
    const problems: string[] = []
    if (game.missing) problems.push('The install folder is missing.')
    else if (!(await fileExists(exe)) && !(await fileExists(join(dir, 'GTA5_Enhanced.exe')))) problems.push(`GTA5.exe was not found in ${dir}.`)
    const version = await gtaVersion(game, env)
    const enhanced = /enhanced/i.test(basename(exe)) || (await fileExists(join(dir, 'GTA5_Enhanced.exe')))
    const info: IntegrationInfo = {
      gameId: game.id,
      integrationId: 'gta5',
      name: `GTA V ${enhanced ? 'Enhanced' : 'Legacy'} · Script Hook V`,
      support: 'partial',
      distribution: await distributionOf(game),
      version,
      valid: !problems.length,
      problems,
      targets: [
        { id: 'game', label: 'Game folder', dir },
        { id: 'scripts', label: 'scripts', dir: join(dir, 'scripts'), create: true }
      ],
      loaders: [],
      launchOptions: [{ id: 'default', label: 'Play', available: true, primary: true }],
      capabilities: [
        'Installs Script Hook V (dev-c.com, after checking that it supports this GTA5.exe version) and Script Hook V .NET (GitHub) with one click, or by itself when a mod needs them.',
        '.asi plugins go next to GTA5.exe, .NET scripts into scripts\\. Copies of ScriptHookV.dll or an ASI loader inside a mod stay out.',
        'The version.dll of copies that have a Social Club emulator, and every other DLL that came with the game, stays as it is.'
      ],
      warnings: [],
      limitations: [
        'OpenIV packages (.oiv) and archive replacements need OpenIV; NexusForge can\'t install those.',
        "dev-c.com publishes no checksum for Script Hook V; the zip is checked for the files its install note lists. Script Hook V closes the game when it goes online."
      ],
      inspectedAt: Date.now()
    }
    info.loaders = [await shvLoader.status(game, info, env, state, mods), await shvdnLoader.status(game, info, env, state, mods)]
    return info
  },
  async classify(pkg, game, info) {
    if (isLoaderPackage(shvSpec, pkg)) {
      const c = classifyLoaderPackage(shvSpec, pkg, 'dinput8.dll')
      // An xinput1_4.dll that came with the game stays; Script Hook V's own copy is then left out.
      const x = join(gameDir(game), 'xinput1_4.dll')
      if ((await fileExists(x)) && (await identifyProxy(x, 'xinput1_4.dll')).owner !== 'asi-loader') {
        c.skipped.push({ path: `${c.rootPath ? `${c.rootPath}/` : ''}xinput1_4.dll`, reason: 'the game folder has its own xinput1_4.dll, which stays' })
      }
      const dinput = info.loaders.find((l) => l.id === 'scripthookv')
      if (dinput && !dinput.proxy) c.skipped.push({ path: `${c.rootPath ? `${c.rootPath}/` : ''}dinput8.dll`, reason: 'dinput8.dll in the game folder belongs to something else and stays' })
      return c
    }
    if (isLoaderPackage(shvdnSpec, pkg)) return classifyLoaderPackage(shvdnSpec, pkg)
    return classifyGta(pkg, game)
  },
  async verify(game, info, manifest, mods): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = []
    const deployed = new Set(manifest.entries.map((e) => e.modId))
    const live = mods.filter((m) => deployed.has(m.id))
    const need = new Set(live.flatMap((m) => loadersNeeded(m)))
    if (need.has('scripthookv') || live.some((m) => m.loaderId === 'scripthookv')) checks.push(...(await verifyLoader(shvSpec, game, info, mods, need.has('scripthookv') ? 'error' : 'warning')))
    if (need.has('shvdn') || live.some((m) => m.loaderId === 'shvdn')) checks.push(...(await verifyLoader(shvdnSpec, game, info, mods, need.has('shvdn') ? 'error' : 'warning')))
    const shv = info.loaders.find((l) => l.id === 'scripthookv')
    if (shv?.blocked && need.has('scripthookv')) checks.push({ label: 'Script Hook V supports this game version', ok: false, level: 'warning', detail: shv.blocked })
    return checks
  },
  async checkLaunch(game, _info, since) {
    const dir = gameDir(game)
    const shv = await readLog(join(dir, 'ScriptHookV.log'), since, 'Script Hook V', /Registering script '([^']+)'/g)
    const net = await readLog(join(dir, 'ScriptHookVDotNet.log'), since, 'Script Hook V .NET', /Loading script(?: file)? ['"]?([^'"\r\n]+)['"]?/g)
    if (shv.ran && net.ran) return { ...shv, loader: 'Script Hook V + .NET', loaded: [...shv.loaded, ...net.loaded], errors: [...shv.errors, ...net.errors] }
    return shv.ran ? shv : net
  }
}

