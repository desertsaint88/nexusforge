// Cyberpunk 2077, any copy (GOG, Steam, Epic, or a game folder on a drive).
//
// Mods are laid out like the game folder (archive/pc/mod, bin/x64/plugins/cyber_engine_tweaks/mods, r6/scripts,
// r6/tweaks, red4ext/plugins) and need the community frameworks their files show: Cyber Engine Tweaks for CET
// Lua mods, redscript for .reds scripts, RED4ext for its plugins, ArchiveXL for .xl files, TweakXL for tweaks.
// All of them come from their official GitHub releases, laid out from the game root, and are installed with one
// click or by themselves when a mod needs them. CET loads through bin/x64/version.dll (an Ultimate ASI Loader)
// and RED4ext through bin/x64/winmm.dll; a DLL of that name that came with the game is never replaced.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo, LaunchCheck, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationState, StagedPackage } from './types'
import { children, distributionOf, fileExists, folderName, isDocFile, route, skipDocs, unwrap } from './common'
import { classifyLoaderPackage, isLoaderPackage, loadersNeeded, verifyLoader, zipLoader, type ZipLoaderSpec } from './zip-loader'
import { safeReaddir } from '../util/fs'

/** The game root: the exe lives in <root>/bin/x64. */
export function cyberpunkRoot(game: Pick<Game, 'exePath' | 'installDir'>): string {
  if (game.exePath && /^cyberpunk2077\.exe$/i.test(basename(game.exePath))) {
    const x64 = dirname(game.exePath)
    if (basename(x64).toLowerCase() === 'x64' && basename(dirname(x64)).toLowerCase() === 'bin') return dirname(dirname(x64))
  }
  return game.installDir
}

const root = (game: Game) => cyberpunkRoot(game)
const VERSION_NOTE = 'Cyberpunk frameworks are built for one game patch; after a game update (or on an older patch) they need the matching release. Their logs (shown after you play) say when the versions don\'t match.'

function spec(s: Omit<ZipLoaderSpec, 'target' | 'targetDir'>): ZipLoaderSpec {
  return { target: 'game', targetDir: root, ...s }
}

export const CP_LOADERS: ZipLoaderSpec[] = [
  spec({
    id: 'cet',
    name: 'Cyber Engine Tweaks',
    summary: 'Lua mods, console and overlay (mods in bin/x64/plugins/cyber_engine_tweaks/mods).',
    repo: 'maximegmd/CyberEngineTweaks',
    markers: ['bin/x64/plugins/cyber_engine_tweaks.asi'],
    proxy: { file: 'bin/x64/version.dll', names: ['version.dll', 'winhttp.dll', 'dinput8.dll', 'dsound.dll'], owner: 'asi-loader' }
  }),
  spec({
    id: 'red4ext',
    name: 'RED4ext',
    summary: 'Script extender; ArchiveXL, TweakXL and Codeware run on it.',
    repo: 'WopsS/RED4ext',
    markers: ['red4ext/RED4ext.dll'],
    proxy: { file: 'bin/x64/winmm.dll', names: ['winmm.dll'], owner: 'red4ext' }
  }),
  spec({ id: 'redscript', name: 'redscript', summary: 'Compiles .reds script mods (r6/scripts) when the game starts.', repo: 'jac3km4/redscript', markers: ['engine/tools/scc.exe'] }),
  spec({ id: 'archivexl', name: 'ArchiveXL', summary: 'New items, appearances and resources (.xl files).', repo: 'psiberx/cp2077-archive-xl', markers: ['red4ext/plugins/ArchiveXL/ArchiveXL.dll'], requires: ['red4ext', 'redscript'] }),
  spec({ id: 'tweakxl', name: 'TweakXL', summary: 'TweakDB changes (r6/tweaks).', repo: 'psiberx/cp2077-tweak-xl', markers: ['red4ext/plugins/TweakXL/TweakXL.dll'], requires: ['red4ext', 'redscript'] }),
  spec({ id: 'codeware', name: 'Codeware', summary: 'Library many redscript mods build on.', repo: 'psiberx/cp2077-codeware', markers: ['red4ext/plugins/Codeware/Codeware.dll'], requires: ['red4ext', 'redscript'] })
]
const LOADERS = CP_LOADERS.map((s) => zipLoader(s))

const TOP = new Set(['archive', 'bin', 'r6', 'red4ext', 'engine', 'mods'])

/** Frameworks a mod's files show it needs. */
export function cyberpunkNeeds(files: string[]): string[] {
  const out = new Set<string>()
  for (const raw of files) {
    const f = raw.toLowerCase()
    if (/(^|\/)bin\/x64\/plugins\/cyber_engine_tweaks\/mods\//.test(f)) out.add('cet')
    if (/(^|\/)r6\/scripts\/.*\.reds$/.test(f) || /\.reds$/.test(f)) out.add('redscript')
    if (/(^|\/)red4ext\/plugins\//.test(f)) out.add('red4ext')
    if (/\.xl$/.test(f)) out.add('archivexl')
    if (/(^|\/)r6\/tweaks\//.test(f)) out.add('tweakxl')
  }
  return [...out]
}

export function classifyCyberpunk(pkg: StagedPackage, modName: string): Classification {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const r = unwrap(pkg.files, TOP)
  const pre = r ? `${r}/` : ''
  const top = children(pkg.files, r)
  const name = folderName(modName)
  const inside = pkg.files.filter((f) => f.rel.toLowerCase().startsWith(pre.toLowerCase())).map((f) => f.rel.slice(pre.length))
  if (top.dirs.some((d) => TOP.has(d.toLowerCase()))) {
    // Laid out like the game folder.
    for (const d of top.dirs) routes.push(route(`${pre}${d}`, 'game', d))
    for (const f of top.files) {
      if (isDocFile(f) || /\.(png|jpe?g)$/i.test(f)) skipped.push({ path: `${pre}${f}`, reason: 'read-me or preview file, not part of the mod' })
      else if (/\.archive$/i.test(f) || /\.xl$/i.test(f)) routes.push(route(`${pre}${f}`, 'archive-mods', f))
      else routes.push(route(`${pre}${f}`, 'game', f))
    }
    if (top.dirs.some((d) => d.toLowerCase() === 'mods') && inside.some((f) => /^mods\/[^/]+\/info\.json$/i.test(f))) {
      checks.push({ level: 'warning', code: 'redmod', message: 'This is a REDmod mod (mods/<name>/info.json): the game only loads it when started with -modded after REDmod has deployed it (REDmod is a free DLC).' })
    }
  } else if (inside.some((f) => /(^|\/)init\.lua$/i.test(f))) {
    // A bare CET mod folder.
    const initDir = inside.find((f) => /(^|\/)init\.lua$/i.test(f))!.replace(/\/?init\.lua$/i, '')
    routes.push(route(initDir ? `${pre}${initDir}` : r, 'game', `bin/x64/plugins/cyber_engine_tweaks/mods/${initDir ? basename(initDir) : name}`))
  } else {
    for (const f of inside) {
      const full = `${pre}${f}`
      if (/\.(archive|xl)$/i.test(f)) routes.push(route(full, 'archive-mods', basename(f)))
      else if (/\.reds$/i.test(f)) routes.push(route(full, 'game', `r6/scripts/${name}/${basename(f)}`))
      else if (/\.(yaml|yml|tweak)$/i.test(f)) routes.push(route(full, 'game', `r6/tweaks/${name}/${basename(f)}`))
      else if (!f.includes('/') && isDocFile(f)) skipped.push({ path: full, reason: 'read-me file, not part of the mod' })
      else skipped.push({ path: full, reason: 'not an .archive, .xl, .reds or tweak file, and the package is not laid out like the game folder' })
    }
    if (!routes.length) {
      routes.push(route(r, 'game'))
      skipped.length = 0
      skipped.push(...skipDocs(pkg.files, r))
      checks.push({ level: 'warning', code: 'unknown_layout', message: 'NexusForge doesn\'t recognize this layout; the files go into the game folder as they are. If the mod page says otherwise, change the content folder in the mod settings.' })
    }
  }
  const needs = cyberpunkNeeds(routes.flatMap((x) => (x.to ? [x.to, x.from] : [x.from])).concat(inside))
  return { kind: needs.length ? 'plugin' : 'files', routes, skipped, checks, rootPath: r, needsLoader: needs[0], needsLoaders: needs.slice(1) }
}

async function newest(dir: string, re: RegExp): Promise<string | undefined> {
  let best: { f: string; t: number } | undefined
  for (const e of await safeReaddir(dir)) {
    if (!e.isFile() || !re.test(e.name)) continue
    const t = (await fsp.stat(join(dir, e.name)).catch(() => undefined))?.mtimeMs ?? 0
    if (!best || t > best.t) best = { f: join(dir, e.name), t }
  }
  return best?.f
}

async function logCheck(file: string | undefined, since: number, loader: string): Promise<LaunchCheck | undefined> {
  if (!file) return undefined
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return undefined
    const text = await fsp.readFile(file, 'utf8')
    const errors = text
      .split(/\r?\n/)
      .filter((l) => /\[(error|critical)\]|\berror\b/i.test(l))
      .slice(0, 10)
    return { ran: true, loader, loaded: [], errors, logFile: file, at: st.mtimeMs }
  } catch {
    return undefined
  }
}

export const cyberpunkIntegration: GameIntegration = {
  id: 'cyberpunk2077',
  revision: 1,
  loadVerifiable: false,
  loaders: LOADERS,
  async matches(game) {
    if (game.platform === 'steam' && game.platformId === '1091500') return true
    return Boolean(game.exePath && /^cyberpunk2077\.exe$/i.test(basename(game.exePath)))
  },
  async inspect(game, env, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo> {
    const dir = root(game)
    const exe = join(dir, 'bin', 'x64', 'Cyberpunk2077.exe')
    const problems: string[] = []
    if (game.missing) problems.push('The install folder is missing.')
    else if (!(await fileExists(exe))) problems.push(`bin\\x64\\Cyberpunk2077.exe was not found in ${dir}.`)
    const info: IntegrationInfo = {
      gameId: game.id,
      integrationId: 'cyberpunk2077',
      name: 'Cyberpunk 2077 · CET / RED4ext',
      support: 'partial',
      distribution: await distributionOf(game),
      version: (await env.fileVersion(exe)) ?? (game.version || undefined),
      valid: !problems.length,
      problems,
      targets: [
        { id: 'game', label: 'Game folder', dir },
        { id: 'archive-mods', label: 'archive/pc/mod', dir: join(dir, 'archive', 'pc', 'mod'), create: true }
      ],
      loaders: [],
      launchOptions: [{ id: 'default', label: 'Play', available: true, primary: true }],
      capabilities: [
        'Installs Cyber Engine Tweaks, RED4ext, redscript, ArchiveXL, TweakXL and Codeware from their official GitHub releases with one click, or by itself when a mod\'s files need them (RED4ext and redscript before the ones built on them).',
        'Mods laid out like the game folder are deployed as they are; loose .archive files go to archive/pc/mod, .reds scripts to r6/scripts.',
        'Never replaces a version.dll / winmm.dll that came with the game.'
      ],
      warnings: [],
      limitations: [VERSION_NOTE, 'REDmod mods need the game started with -modded after REDmod deployed them; NexusForge doesn\'t run REDmod.'],
      inspectedAt: Date.now()
    }
    for (const l of LOADERS) info.loaders.push(await l.status(game, info, env, state, mods))
    return info
  },
  async classify(pkg) {
    for (const s of CP_LOADERS) if (isLoaderPackage(s, pkg)) return classifyLoaderPackage(s, pkg, s.proxy ? basename(s.proxy.file) : undefined)
    return classifyCyberpunk(pkg, pkg.name)
  },
  async verify(game, info, manifest, mods): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = []
    const deployed = new Set(manifest.entries.map((e) => e.modId))
    const live = mods.filter((m) => deployed.has(m.id))
    const need = new Set(live.flatMap((m) => loadersNeeded(m)))
    for (const id of [...need]) for (const r of CP_LOADERS.find((s) => s.id === id)?.requires ?? []) need.add(r)
    for (const s of CP_LOADERS) {
      if (!need.has(s.id) && !live.some((m) => m.loaderId === s.id)) continue
      checks.push(...(await verifyLoader(s, game, info, mods, need.has(s.id) ? 'error' : 'warning')))
    }
    return checks
  },
  async checkLaunch(game, _info, since) {
    const dir = root(game)
    const logs = (
      await Promise.all([
        logCheck(join(dir, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'cyber_engine_tweaks.log'), since, 'Cyber Engine Tweaks'),
        logCheck(await newest(join(dir, 'red4ext', 'logs'), /\.log$/i), since, 'RED4ext'),
        logCheck(join(dir, 'r6', 'logs', 'redscript_rCURRENT.log'), since, 'redscript')
      ])
    ).filter((x): x is LaunchCheck => Boolean(x))
    if (!logs.length) return { ran: false, loaded: [], errors: [] }
    return { ran: true, loader: logs.map((l) => l.loader).join(' + '), loaded: [], errors: logs.flatMap((l) => l.errors.map((e) => `${l.loader}: ${e}`)), logFile: logs[0].logFile, at: Math.max(...logs.map((l) => l.at ?? 0)) }
  }
}
