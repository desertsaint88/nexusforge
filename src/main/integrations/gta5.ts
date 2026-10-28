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
// - Script Hook V .NET's last stable release (3.6.0, 2022) can't run scripts built against API 3.7; its log says
//   "Unable to resolve API version 3.7.0" for them. When the log shows that, NexusForge offers the official
//   nightly build (github.com/scripthookvdotnet/scripthookvdotnet-nightly, SHA-256 checked) as the update.
// - Save games go into the save folder of this copy: Documents\Rockstar Games\GTA V\Profiles\<id> (Rockstar), or
//   Public Documents\Socialclub\RUNE\GTA V\<UserId> for copies with RUNE's Social Club emulator
//   (socialclub_emu.ini + RUNE64.dll next to GTA5.exe). GTA V takes the slot from the file name (SGTA500NN = slot
//   NN+1), so a save goes into a free slot and never replaces one the player has.
// Script Hook V closes the game when it goes online; mods are for story mode.

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { DeployTarget, DiagnosticFinding, Game, InstalledMod, IntegrationInfo, LaunchCheck, ModCheck, ModRoute, RuntimeFileResult, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, StagedPackage } from './types'
import { gameDir } from './bepinex'
import { antiCheatIn, children, compareVersions, dirExists, distributionOf, fileExists, isDocFile, route, unwrap } from './common'
import { releases, sha256Of } from './github'
import { fileStrings, identifyProxy } from './proxy'
import { classifyLoaderPackage, fromGithub, isLoaderPackage, loadersNeeded, verifyLoader, zipLoader, type LoaderDownload, type ZipLoaderSpec } from './zip-loader'
import { findPreset } from '../library/presets'
import { fittingAssets } from '../sources/frameworks'
import { runtimeNeeds } from '../mods/runtime'
import { safeReaddir } from '../util/fs'

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

const SHVDN_REPO = 'scripthookvdotnet/scripthookvdotnet'
const SHVDN_NIGHTLY_REPO = 'scripthookvdotnet/scripthookvdotnet-nightly'
const NIGHTLY_ASSET = /^ScriptHookVDotNet-v([\d.]+)-nightly\.(\d+)\.zip$/i

/** The Script Hook V .NET API version the last start asked for (from its log), if newer than what is installed. */
function shvdnApiNeeded(state?: IntegrationState): string | undefined {
  return runtimeNeeds(state?.lastLaunch).shvdn
}

/** Newest official nightly build (published by the project's own bot, with a SHA-256 digest). */
async function shvdnNightly(env: IntegrationEnv): Promise<LoaderDownload | undefined> {
  for (const rel of await releases(env, SHVDN_NIGHTLY_REPO)) {
    const asset = rel.assets.find((a) => NIGHTLY_ASSET.test(a.name))
    if (asset && sha256Of(asset)) return { ...fromGithub(rel, asset), prerelease: true }
  }
  return undefined
}

export const shvdnSpec: ZipLoaderSpec = {
  id: 'shvdn',
  name: 'Script Hook V .NET',
  summary: 'Runs C# / VB scripts (.dll, .cs, .vb) from the scripts folder. Builds on Script Hook V.',
  repo: SHVDN_REPO,
  target: 'game',
  targetDir: (game) => gameDir(game),
  markers: ['ScriptHookVDotNet.asi'],
  packageMarkers: ['ScriptHookVDotNet.asi', 'ScriptHookVDotNet3.dll'],
  notInPackage: /(^|\/)scripts\//i,
  requires: ['scripthookv'],
  leaveOut: [
    [/\.xml$/i, 'API documentation for script authors'],
    [/^(Docs|Licenses)\//i, 'documentation and license texts'],
    [/\.pdb$/i, 'debug symbols']
  ],
  // The stable release, unless the last start showed a script that needs a newer API: then the official nightly.
  async resolve(env, ctx): Promise<LoaderDownload> {
    const need = shvdnApiNeeded(ctx.state)
    const fit = fittingAssets('shvdn', await releases(env, SHVDN_REPO), ctx.rt)[0]
    const stable = fit ? fromGithub(fit.release, fit.asset) : undefined
    if (stable && (!need || compareVersions(stable.version, need) >= 0)) return stable
    const nightly = await shvdnNightly(env)
    if (nightly && (!need || compareVersions(nightly.version, need) >= 0)) return nightly
    if (stable && !need) return stable
    throw new Error(need ? `No Script Hook V .NET build supports API ${need} yet (newest nightly: ${nightly?.version ?? 'none'}).` : 'No Script Hook V .NET release on GitHub fits this game.')
  },
  async warning(_game, _env, ctx) {
    const need = shvdnApiNeeded(ctx.state)
    if (need) return `A script needs Script Hook V .NET API ${need} (ScriptHookVDotNet.log: "Unable to resolve API version ${need}"). The last stable release is 3.6.0, so NexusForge installs the official nightly build (scripthookvdotnet-nightly on GitHub, SHA-256 checked) as the update.`
    return 'Its last stable GitHub release (3.6.0) is from 2022. If ScriptHookVDotNet.log says "Unable to resolve API version", NexusForge offers the official nightly build.'
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
/** Folders of the game itself that a package may bring files for. */
const GAME_FOLDERS = new Set(['scripts', 'mods', 'lml', 'plugins', 'update', 'x64', 'common', 'redux', 'menyoostuff'])
/** Source code that comes with a script mod: not used by the game (in scripts\ SHVDN would even compile it twice). */
const SOURCE_DIR = /^\(?(source|src|source ?code)\)?$/i

async function onlySource(pkg: StagedPackage, dir: string): Promise<boolean> {
  const files = pkg.files.filter((f) => f.rel.toLowerCase().startsWith(`${dir.toLowerCase()}/`))
  return files.length > 0 && files.every((f) => /\.(cs|vb|csproj|vbproj|sln|resx|config|md|txt)$/i.test(f.rel) || /\/(\(optional\)|properties)\//i.test(f.rel))
}

export async function classifyGta(pkg: StagedPackage, game: Game): Promise<Classification> {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const needs = new Set<string>()
  const oiv = pkg.files.filter((f) => /\.oiv$/i.test(f.rel))
  if (oiv.length) {
    checks.push({ level: 'error', code: 'oiv', message: `OpenIV package (${basename(oiv[0].rel)}): only OpenIV's Package Installer can install it, because it edits the game's archives. Open it with OpenIV.`, userAction: 'Install it with OpenIV (Package Installer); NexusForge cannot.' })
    return { kind: 'files', routes, skipped, checks, rootPath: '' }
  }
  const root = unwrap(pkg.files, GTA_DIRS)
  const top = children(pkg.files, root)
  const j = (a: string, b: string) => (a ? `${a}/${b}` : b)
  // A Script Hook V .NET script at the top: its data folders belong next to it in scripts\ (the convention scripts
  // follow, e.g. Zombies V reads scripts\ZombiesV\*.ini and scripts\ZombiesVSounds).
  let topScript = false
  for (const f of top.files) if (await isDotNetScript(pkg, j(root, f))) topScript = true
  for (const d of top.dirs) {
    const lower = d.toLowerCase()
    if (SOURCE_DIR.test(d) && (await onlySource(pkg, j(root, d)))) {
      skipped.push({ path: j(root, d), reason: "the mod's source code; the game doesn't use it (Script Hook V .NET would compile .cs files in scripts\\ a second time)" })
    } else if (topScript && !GAME_FOLDERS.has(lower)) {
      routes.push(route(j(root, d), 'scripts', d))
    } else if (lower === 'scripts') {
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
    } else routes.push(route(rel, topScript ? 'scripts' : 'game', f))
  }
  if (!routes.length) checks.push({ level: 'error', code: 'empty', message: 'Nothing to install besides read-me files and loader DLLs.' })
  void game
  const list = [...needs]
  return { kind: list.length ? 'plugin' : 'files', routes, skipped, checks, rootPath: root, needsLoader: list[0], needsLoaders: list.slice(1) }
}

// ---------------------------------------------------------------------------
// Save games

export interface GtaSaveFolder {
  dir: string
  /** "RUNE Social Club emulator (UserId 1010…)", "Rockstar profile 1A2B3C4D" */
  label: string
  /** Why NexusForge thinks this is where the game reads saves. */
  evidence: string
}

const SAVE_NAME = /^SGTA5\d{4}$/i

async function hasGtaProfileFiles(dir: string): Promise<boolean> {
  return (await safeReaddir(dir)).some((e) => e.isFile() && (SAVE_NAME.test(e.name) || /^(pc_settings\.bin|cfg\.dat)$/i.test(e.name)))
}

/**
 * The folder this copy of GTA V (Legacy) reads story saves from, when the files on disk show it: undefined when
 * there is none yet, or several candidates (then `ambiguous` lists them and nothing is guessed).
 */
export async function gtaSaveFolder(game: Game, env: Pick<IntegrationEnv, 'documents' | 'publicDocuments'>): Promise<{ folder?: GtaSaveFolder; ambiguous?: string[]; note?: string }> {
  const dir = gameDir(game)
  if (await fileExists(join(dir, 'GTA5_Enhanced.exe'))) return { note: 'GTA V Enhanced keeps saves elsewhere; NexusForge only knows the Legacy save folders.' }
  // RUNE's Social Club emulator: socialclub_emu.ini (UserId=…) next to GTA5.exe, saves in Public Documents.
  let ini = ''
  try {
    ini = await fsp.readFile(join(dir, 'socialclub_emu.ini'), 'utf8')
  } catch {
    // no emulator ini
  }
  const userId = ini.match(/^\s*UserId\s*=\s*(\d+)\s*$/im)?.[1]
  if (userId && env.publicDocuments && (await fileExists(join(dir, 'RUNE64.dll')))) {
    const d = join(env.publicDocuments, 'Socialclub', 'RUNE', 'GTA V', userId)
    if (await hasGtaProfileFiles(d)) return { folder: { dir: d, label: `Social Club emulator profile ${userId}`, evidence: `socialclub_emu.ini (UserId=${userId}) and RUNE64.dll next to GTA5.exe; the game has written ${d}` } }
    return { note: `This copy uses RUNE's Social Club emulator (UserId ${userId}); its save folder ${d} doesn't exist yet. Start the game once and save.` }
  }
  // Rockstar's own profiles: Documents\Rockstar Games\GTA V\Profiles\<id>.
  const profiles = join(env.documents, 'Rockstar Games', 'GTA V', 'Profiles')
  const found: string[] = []
  for (const e of await safeReaddir(profiles)) if (e.isDirectory() && (await hasGtaProfileFiles(join(profiles, e.name)))) found.push(join(profiles, e.name))
  if (found.length === 1) return { folder: { dir: found[0], label: `Rockstar profile ${basename(found[0])}`, evidence: `the only GTA V profile folder with saves or settings in ${profiles}` } }
  if (found.length > 1) return { ambiguous: found, note: `${found.length} GTA V profile folders have saves (${found.map((f) => basename(f)).join(', ')}); NexusForge doesn't guess which one you play with.` }
  return { note: (await dirExists(profiles)) ? `No GTA V profile in ${profiles} has saves yet; start the game once and save.` : 'No GTA V save folder found yet; start the game once and save.' }
}

/** Save files of a package, grouped by save (SGTA50015 + SGTA50015.bak), in their new slot names. */
export async function gtaSaveRoutes(saveFiles: string[], target: Pick<DeployTarget, 'dir'>): Promise<{ routes: ModRoute[]; checks: ModCheck[] }> {
  const routes: ModRoute[] = []
  const checks: ModCheck[] = []
  const used = new Set<number>()
  for (const e of await safeReaddir(target.dir)) {
    const m = e.isFile() && e.name.match(/^SGTA500(\d{2})$/i)
    if (m) used.add(Number(m[1]))
  }
  const saves = saveFiles.filter((f) => SAVE_NAME.test(basename(f)))
  if (!saves.length) {
    checks.push({ level: 'error', code: 'savegame', message: 'No GTA V story save (SGTA500NN) in this package.', userAction: "Open the mod's folder and copy the save where the mod page says." })
    return { routes, checks }
  }
  for (const s of saves) {
    const want = Number(basename(s).slice(-2))
    let slot = want <= 15 && !used.has(want) ? want : -1
    for (let n = 0; slot < 0 && n <= 15; n++) if (!used.has(n)) slot = n
    if (slot < 0) {
      checks.push({ level: 'error', code: 'save_slots_full', message: 'All 16 story save slots of this profile are in use; NexusForge never overwrites one of your saves.', userAction: 'Delete or move a save you no longer need from the save folder, then deploy again.' })
      return { routes: [], checks }
    }
    used.add(slot)
    const name = `SGTA500${String(slot).padStart(2, '0')}`
    routes.push(route(s, 'saves', name))
    const bak = saveFiles.find((f) => f.toLowerCase() === `${s.toLowerCase()}.bak`)
    if (bak) routes.push(route(bak, 'saves', `${name}.bak`))
    checks.push({
      level: 'info',
      code: 'save_slot',
      message: slot === want ? `Goes into save slot ${slot + 1} (${name}), which is free.` : `Goes into save slot ${slot + 1} (${name}): slot ${want + 1} already has one of your saves, which stays as it is. GTA V takes the slot from the file name.`
    })
  }
  return { routes, checks }
}

// ---------------------------------------------------------------------------
// The loaders' logs after a start

/**
 * Script Hook V .NET's log, per script assembly: "Loading assembly X.dll ..." starts an assembly; "Unable to
 * resolve API version A.B.C" or an [ERROR] line after it means it failed; "Instantiating script" / "Started script"
 * means it runs. Assemblies with neither stay out (unknown).
 */
export function parseShvdnLog(text: string): RuntimeFileResult[] {
  const out = new Map<string, RuntimeFileResult & { state?: 'ok' | 'failed' }>()
  let current: (RuntimeFileResult & { state?: 'ok' | 'failed' }) | undefined
  const note = (r: RuntimeFileResult, line: string) => {
    const l = line.trim()
    if (r.evidence.length < 6 && !r.evidence.includes(l)) r.evidence.push(l)
  }
  for (const line of text.split(/\r?\n/)) {
    const load = line.match(/Loading assembly ['"]?([^'"\r\n]+?\.dll)['"]?(?:\s|\.{3}|$)/i)
    if (load) {
      const file = basename(load[1].replace(/\\/g, '/'))
      current = out.get(file.toLowerCase()) ?? { file, ok: false, evidence: [] }
      out.set(file.toLowerCase(), current)
      note(current, line)
      continue
    }
    if (!current) continue
    const api = line.match(/Unable to resolve API version ([\d.]+)/i)
    if (api) {
      current.state = 'failed'
      current.needs = { loaderId: 'shvdn', version: api[1].replace(/\.$/, '') }
      note(current, line)
    } else if (/\[ERROR\]/i.test(line) && /(fail|unable|exception|could not)/i.test(line)) {
      current.state = 'failed'
      note(current, line)
    } else if (/(Instantiating|Started) script/i.test(line)) {
      if (current.state !== 'failed') current.state = 'ok'
      note(current, line)
    }
  }
  return [...out.values()].filter((r) => r.state).map(({ state, ...r }) => ({ ...r, ok: state === 'ok' }))
}

/** Script Hook V's log: every script it registers ("Registering script 'X.asi'") was loaded. */
export function parseShvLog(text: string): RuntimeFileResult[] {
  const out: RuntimeFileResult[] = []
  for (const m of text.matchAll(/^.*Registering script '([^']+)'.*$/gm)) if (!out.some((r) => r.file === m[1])) out.push({ file: basename(m[1].replace(/\\/g, '/')), ok: true, evidence: [m[0].trim()] })
  return out
}

async function readLog(file: string, since: number): Promise<{ text: string; at: number } | undefined> {
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return undefined
    return { text: await fsp.readFile(file, 'utf8'), at: st.mtimeMs }
  } catch {
    return undefined
  }
}

const ERROR_LINE = /\b(ERROR|FATAL|CRITICAL)\b|\[ERROR\]/i

export async function gtaLaunchCheck(dir: string, since: number): Promise<LaunchCheck> {
  const shv = await readLog(join(dir, 'ScriptHookV.log'), since)
  const net = await readLog(join(dir, 'ScriptHookVDotNet.log'), since)
  if (!shv && !net) return { ran: false, loaded: [], errors: [], logFile: join(dir, 'ScriptHookV.log') }
  const files = [...(shv ? parseShvLog(shv.text) : []), ...(net ? parseShvdnLog(net.text) : [])]
  const errors = [shv, net].flatMap((l) => (l ? l.text.split(/\r?\n/).filter((x) => ERROR_LINE.test(x)) : [])).slice(0, 20)
  return {
    ran: true,
    loader: shv && net ? 'Script Hook V + .NET' : shv ? 'Script Hook V' : 'Script Hook V .NET',
    loaded: files.filter((f) => f.ok).map((f) => f.file),
    errors,
    files,
    logFile: net ? join(dir, 'ScriptHookVDotNet.log') : join(dir, 'ScriptHookV.log'),
    at: Math.max(shv?.at ?? 0, net?.at ?? 0)
  }
}

// ---------------------------------------------------------------------------
// The integration

export const gta5Integration: GameIntegration = {
  id: 'gta5',
  // 2: save games into the save folder, script data folders into scripts\, source code left out.
  revision: 2,
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
    const saves = await gtaSaveFolder(game, env)
    const targets: DeployTarget[] = [
      { id: 'game', label: 'Game folder', dir },
      { id: 'scripts', label: 'scripts', dir: join(dir, 'scripts'), create: true }
    ]
    if (saves.folder) targets.push({ id: 'saves', label: `Save games (${saves.folder.label})`, dir: saves.folder.dir, userData: true })
    const info: IntegrationInfo = {
      gameId: game.id,
      integrationId: 'gta5',
      name: `GTA V ${enhanced ? 'Enhanced' : 'Legacy'} · Script Hook V`,
      support: 'partial',
      distribution: await distributionOf(game),
      version,
      valid: !problems.length,
      problems,
      targets,
      loaders: [],
      launchOptions: [{ id: 'default', label: 'Play', available: true, primary: true }],
      capabilities: [
        'Installs Script Hook V (dev-c.com, after checking that it supports this GTA5.exe version) and Script Hook V .NET (GitHub) with one click, or by itself when a mod needs them.',
        '.asi plugins go next to GTA5.exe, .NET scripts and their data folders into scripts\\. Copies of ScriptHookV.dll or an ASI loader inside a mod, and source code, stay out.',
        saves.folder ? `Save games go into ${saves.folder.dir} (${saves.folder.label}), into a free slot; your own saves are never replaced.` : 'Save games are only deployed once NexusForge has found the save folder of this copy.',
        'After a start, ScriptHookV.log and ScriptHookVDotNet.log show which scripts loaded and which failed (and why).',
        'The version.dll of copies that have a Social Club emulator, and every other DLL that came with the game, stays as it is.'
      ],
      warnings: [],
      limitations: [
        'OpenIV packages (.oiv) and archive replacements need OpenIV; NexusForge can\'t install those.',
        "dev-c.com publishes no checksum for Script Hook V; the zip is checked for the files its install note lists. Script Hook V closes the game when it goes online.",
        ...(saves.note ? [saves.note] : [])
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
  saveRoutes: (_pkg, saveFiles, target) => gtaSaveRoutes(saveFiles, target),
  async verify(game, info, manifest, mods): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = []
    const deployed = new Set(manifest.entries.map((e) => e.modId))
    const live = mods.filter((m) => deployed.has(m.id))
    const need = new Set(live.flatMap((m) => loadersNeeded(m)))
    if (need.has('scripthookv') || live.some((m) => m.loaderId === 'scripthookv')) checks.push(...(await verifyLoader(shvSpec, game, info, mods, need.has('scripthookv') ? 'error' : 'warning')))
    if (need.has('shvdn') || live.some((m) => m.loaderId === 'shvdn')) checks.push(...(await verifyLoader(shvdnSpec, game, info, mods, need.has('shvdn') ? 'error' : 'warning')))
    const shv = info.loaders.find((l) => l.id === 'scripthookv')
    if (shv?.blocked && need.has('scripthookv')) checks.push({ label: 'Script Hook V supports this game version', ok: false, level: 'warning', detail: shv.blocked })
    const net = info.loaders.find((l) => l.id === 'shvdn')
    if (need.has('shvdn') && net?.state === 'outdated') checks.push({ label: 'Script Hook V .NET is new enough for the scripts', ok: false, level: 'warning', detail: net.warning ?? `Update to ${net.latest}.` })
    return checks
  },
  checkLaunch: (game, _info, since) => gtaLaunchCheck(gameDir(game), since),
  async diagnose(ctx): Promise<DiagnosticFinding[]> {
    const out: DiagnosticFinding[] = []
    const saveMods = ctx.mods.filter((m) => m.kind === 'savegame' && ctx.enabled.has(m.id))
    const target = ctx.info.targets.find((t) => t.id === 'saves')
    if (saveMods.length && !target) {
      const s = await gtaSaveFolder(ctx.game, ctx.env)
      out.push({
        code: 'NF-GTA-001',
        category: 'installation',
        severity: 'warning',
        confidence: 'confirmed',
        title: 'Save folder of this copy not found',
        detail: `${saveMods.map((m) => m.name).join(', ')} can't be deployed: ${s.note ?? 'NexusForge found no save folder for this copy of GTA V.'}`,
        evidence: s.ambiguous ?? [s.note ?? ''],
        modIds: saveMods.map((m) => m.id),
        fixes: [],
        userAction: s.ambiguous ? 'Copy the save into the profile folder you play with by hand.' : 'Start GTA V once and save in story mode, then run Diagnose again.'
      })
    }
    // Saves from before revision 2 sit next to GTA5.exe, where the game never reads them.
    const dir = gameDir(ctx.game)
    const stray = (ctx.manifest?.entries ?? []).filter((e) => e.target === 'game' && SAVE_NAME.test(basename(e.rel)))
    if (stray.length) {
      out.push({
        code: 'NF-GTA-002',
        category: 'deployment',
        severity: 'warning',
        confidence: 'confirmed',
        title: 'A save game was deployed into the game folder',
        detail: `${stray.map((e) => e.rel).join(', ')} is in ${dir}; GTA V only reads saves from its profile folder${target ? ` (${target.dir})` : ''}. Deploying again moves it there (into a free slot).`,
        evidence: stray.map((e) => join(dir, e.rel)),
        modIds: [...new Set(stray.map((e) => e.modId))],
        fixes: [{ id: 'deploy', label: 'Deploy again', description: `Takes ${stray.map((e) => e.rel).join(', ')} out of the game folder${target ? ` and puts the save into ${target.dir}, in a free slot` : ''}.`, consequential: true }]
      })
    }
    return out
  }
}
