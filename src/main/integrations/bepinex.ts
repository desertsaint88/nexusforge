// Unity games modded through BepInEx: the loader sits next to the game's .exe (winhttp.dll + doorstop_config.ini
// + BepInEx/core) and loads plugin DLLs from BepInEx/plugins. Mod packages come in every shape (a bare DLL,
// a Thunderstore package, a full BepInEx/ tree, or a DLL with a second copy of BepInEx inside); they are all
// mapped onto that layout here. BepInEx itself comes from its official GitHub releases, in the build that fits
// the game (Mono or IL2CPP, 64- or 32-bit), and is deployed like a mod, so purging removes it cleanly.

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo, LaunchCheck, LoaderStatus, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, LoaderAdapter, StagedPackage } from './types'
import { children, compareVersions, distributionOf, fileExists, folderName, isDocFile, route, under, unwrap } from './common'
import { fittingAssets, gameRuntime, type GameRuntime } from '../sources/frameworks'
import { releases, sha256Of } from './github'
import { chooseProxy, describeTaken, proxyFiles, proxyNote, type ProxyFile } from './proxy'
import { routesExcept } from './zip-loader'
import type { WalkEntry } from '../util/fs'

export interface BepInExGameSpec {
  id: string
  name: string
  steam: string[]
  names: RegExp[]
  /** Main executable (used to recognize copies outside Steam). */
  exe?: string
  support: 'full' | 'partial'
  /** BepInEx major version this game's mods are made for ('auto': 5 for Mono builds, 6 for IL2CPP). */
  major: 5 | 6 | 'auto'
  /** Whatever major version is installed is fine (games NexusForge has no rules for). */
  flexibleMajor?: boolean
  capabilities?: string[]
  limitations?: string[]
}

const LOADER_FILES = new Set(['winhttp.dll', 'version.dll', 'doorstop_config.ini', '.doorstop_version', 'changelog.txt'])
const BEPINEX_DIRS = new Set(['bepinex', 'plugins', 'patchers', 'config', 'core', 'monomod'])
// Written by BepInEx while the game runs; a mod author's copies of them must not overwrite the user's.
const RUNTIME_JUNK = /^bepinex\/(logoutput\.log|cache\/.*|.*\.log)$/i

/** Folders of a package that contain a complete BepInEx (BepInEx/core with the loader DLLs). */
export function findLoaderRoots(files: WalkEntry[]): string[] {
  const roots = new Set<string>()
  for (const f of files) {
    const m = f.rel.match(/^(?:(.*)\/)?bepinex\/core\/(bepinex(\.core|\.preloader(\.core)?)?\.dll)$/i)
    if (m) roots.add(m[1] ?? '')
  }
  return [...roots].sort((a, b) => a.length - b.length)
}

function bepinexMajor(files: WalkEntry[], root: string): 5 | 6 | undefined {
  const p = root ? `${root.toLowerCase()}/` : ''
  if (files.some((f) => f.rel.toLowerCase() === `${p}bepinex/core/bepinex.core.dll`)) return 6
  if (files.some((f) => f.rel.toLowerCase() === `${p}bepinex/core/bepinex.dll`)) return 5
  return undefined
}

const isUnder = (rel: string, prefix: string) => !prefix || rel.toLowerCase() === prefix.toLowerCase() || rel.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)

/**
 * Maps a package onto the BepInEx layout. `modName` names the plugin folder (BepInEx/plugins/<modName>/).
 */
export function classifyBepInEx(pkg: StagedPackage, modName: string, spec?: Pick<BepInExGameSpec, 'major' | 'name' | 'flexibleMajor'>, proxyName?: string): Classification {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const files = pkg.files
  const loaderRoots = findLoaderRoots(files)
  const content = files.filter((f) => !loaderRoots.some((r) => isUnder(f.rel, r)))
  const meaningful = content.filter((f) => !isDocFile(basename(f.rel)) && !(f.rel.includes('/') ? false : f.rel.toLowerCase() === 'manifest.json' || f.rel.toLowerCase() === 'icon.png'))

  // --- the package is BepInEx itself -----------------------------------
  if (loaderRoots.length && !meaningful.length) {
    const root = loaderRoots[0]
    const major = bepinexMajor(files, root)
    for (const f of under(files, root)) {
      if (RUNTIME_JUNK.test(f.sub)) skipped.push({ path: f.rel, reason: 'written by BepInEx while the game runs' })
      else if (!f.sub.includes('/') && (isDocFile(f.sub) || f.sub.toLowerCase() === 'changelog.txt')) skipped.push({ path: f.rel, reason: 'read-me file' })
    }
    for (const f of content) if (isDocFile(basename(f.rel)) || /^(manifest\.json|icon\.png)$/i.test(f.rel)) skipped.push({ path: f.rel, reason: 'package information' })
    if (spec && !spec.flexibleMajor && spec.major !== 'auto' && major && major !== spec.major) {
      checks.push({ level: 'error', code: 'bepinex_major', message: `This is BepInEx ${major}, but ${spec.name} mods are made for BepInEx ${spec.major}.` })
    }
    const proxyFile = children(files, root).files.find((f) => f.toLowerCase() === 'winhttp.dll')
    if (proxyName && proxyFile && proxyName.toLowerCase() !== 'winhttp.dll') {
      // winhttp.dll is used by a file that came with the game: Doorstop goes in under its other name.
      routes.push(...routesExcept(files, root, proxyFile, 'game'), route(root ? `${root}/${proxyFile}` : proxyFile, 'game', proxyName))
    } else {
      routes.push(route(root, 'game'))
    }
    return { kind: 'loader', loaderId: 'bepinex', routes, skipped, checks, rootPath: root, name: 'BepInEx', meta: major ? { bepinexMajor: String(major) } : undefined }
  }

  // --- a mod (maybe with a second copy of BepInEx inside) ---------------
  for (const r of loaderRoots) {
    const major = bepinexMajor(files, r)
    skipped.push({ path: r || '.', reason: `a copy of BepInEx${major ? ` ${major}` : ''} bundled with the mod; NexusForge installs and updates BepInEx itself` })
  }
  const root = unwrap(content, BEPINEX_DIRS)
  const top = children(content, root)
  const join2 = (a: string, b: string) => (a ? `${a}/${b}` : b)
  const pluginDir = `BepInEx/plugins/${folderName(modName)}`
  const isThunderstore = top.files.some((f) => f.toLowerCase() === 'manifest.json')
  const bepinexDir = top.dirs.find((d) => d.toLowerCase() === 'bepinex')

  const skipTop = (f: string, reason: string) => skipped.push({ path: join2(root, f), reason })
  if (bepinexDir) {
    // Laid out like the game folder already: BepInEx/plugins/…, maybe with extra game-folder files.
    routes.push(route(join2(root, bepinexDir), 'game', 'BepInEx'))
    for (const f of under(content, join2(root, bepinexDir))) if (RUNTIME_JUNK.test(`bepinex/${f.sub}`)) skipped.push({ path: f.rel, reason: 'written by BepInEx while the game runs' })
    for (const d of top.dirs) if (d !== bepinexDir) routes.push(route(join2(root, d), 'game', d))
    for (const f of top.files) {
      if (LOADER_FILES.has(f.toLowerCase())) skipTop(f, 'part of BepInEx; NexusForge installs BepInEx itself')
      else if (isDocFile(f) || (isThunderstore && /^(manifest\.json|icon\.png)$/i.test(f))) skipTop(f, 'read-me file, not part of the mod')
      else routes.push(route(join2(root, f), 'game', f))
    }
    if (top.dirs.length > 1 || top.files.some((f) => !LOADER_FILES.has(f.toLowerCase()) && !isDocFile(f))) {
      checks.push({ level: 'info', message: 'Besides its BepInEx files this mod also puts files into the game folder.' })
    }
  } else if (top.dirs.some((d) => BEPINEX_DIRS.has(d.toLowerCase()))) {
    // Thunderstore / r2modman layout: plugins/, patchers/, config/ at the top.
    for (const d of top.dirs) {
      const lower = d.toLowerCase()
      const from = join2(root, d)
      if (lower === 'plugins') routes.push(route(from, 'game', pluginDir))
      else if (lower === 'patchers') routes.push(route(from, 'game', `BepInEx/patchers/${folderName(modName)}`))
      else if (lower === 'monomod') routes.push(route(from, 'game', `BepInEx/monomod/${folderName(modName)}`))
      else if (lower === 'config') routes.push(route(from, 'game', 'BepInEx/config'))
      else if (lower === 'core') routes.push(route(from, 'game', 'BepInEx/core'))
      else routes.push(route(from, 'game', `${pluginDir}/${d}`))
    }
    for (const f of top.files) {
      if (isDocFile(f) || /^(manifest\.json|icon\.png)$/i.test(f)) skipTop(f, 'package information, not part of the mod')
      else if (LOADER_FILES.has(f.toLowerCase())) skipTop(f, 'part of BepInEx; NexusForge installs BepInEx itself')
      else routes.push(route(join2(root, f), 'game', `${pluginDir}/${f}`))
    }
  } else {
    // A plugin DLL (with whatever it needs next to it): it all goes into its own plugin folder.
    for (const d of top.dirs) routes.push(route(join2(root, d), 'game', `${pluginDir}/${d}`))
    for (const f of top.files) {
      if (isDocFile(f)) skipTop(f, 'read-me file, not part of the mod')
      else if (LOADER_FILES.has(f.toLowerCase())) skipTop(f, 'part of BepInEx; NexusForge installs BepInEx itself')
      else routes.push(route(join2(root, f), 'game', `${pluginDir}/${f}`))
    }
  }

  const routedDlls = content.filter((f) => /\.dll$/i.test(f.rel) && routes.some((r) => isUnder(f.rel, r.from)) && !skipped.some((s) => isUnder(f.rel, s.path)))
  if (!routes.length) {
    checks.push({ level: 'error', code: 'empty', message: 'The package has nothing to install besides read-me files and BepInEx itself.' })
  } else if (!routedDlls.length) {
    checks.push({
      level: 'warning',
      code: 'no_plugin',
      message: `No plugin (.dll) in this package. Its files went to ${bepinexDir ? 'the BepInEx folder' : pluginDir}; if the mod page says they belong somewhere else, change the content folder in the mod's settings.`
    })
  }
  if (spec && !spec.flexibleMajor && spec.major !== 'auto' && loaderRoots.length) {
    const major = bepinexMajor(files, loaderRoots[0])
    if (major && major !== spec.major) checks.push({ level: 'warning', message: `The mod bundles BepInEx ${major}; ${spec.name} uses BepInEx ${spec.major}.` })
  }
  return { kind: 'plugin', needsLoader: 'bepinex', routes, skipped, checks, rootPath: root }
}

// ---------------------------------------------------------------------------
// The loader

export function gameDir(game: Pick<Game, 'exePath' | 'installDir'>): string {
  return game.exePath ? dirname(game.exePath) : game.installDir
}

/** Names Unity Doorstop (BepInEx's preloader) works under. */
export const DOORSTOP_NAMES = ['winhttp.dll', 'version.dll']

interface BepInExFiles {
  core?: string
  major?: 5 | 6
  proxy?: string
  /** Doorstop names used by other files. */
  foreign?: ProxyFile[]
  ini?: string
  enabled?: boolean
}

export async function bepinexFiles(dir: string): Promise<BepInExFiles> {
  const out: BepInExFiles = {}
  if (await fileExists(join(dir, 'BepInEx', 'core', 'BepInEx.Core.dll'))) {
    out.core = join(dir, 'BepInEx', 'core', 'BepInEx.Core.dll')
    out.major = 6
  } else if (await fileExists(join(dir, 'BepInEx', 'core', 'BepInEx.dll'))) {
    out.core = join(dir, 'BepInEx', 'core', 'BepInEx.dll')
    out.major = 5
  }
  // Only Doorstop counts: a winhttp.dll / version.dll that came with the game (an emulator, Social Club) is not BepInEx.
  const proxies = await proxyFiles(dir, DOORSTOP_NAMES)
  const own = proxies.find((p) => p.owner === 'bepinex')
  if (own) out.proxy = join(dir, own.name)
  out.foreign = proxies.filter((p) => p.owner !== 'bepinex')
  const ini = join(dir, 'doorstop_config.ini')
  if (await fileExists(ini)) {
    out.ini = ini
    const text = await fsp.readFile(ini, 'utf8').catch(() => '')
    const v = text.match(/^\s*enabled\s*=\s*(\S+)/im)?.[1]
    out.enabled = v === undefined ? true : /^(true|1|yes)$/i.test(v)
  }
  return out
}

export function majorFor(spec: Pick<BepInExGameSpec, 'major'>, rt: GameRuntime): 5 | 6 {
  return spec.major === 'auto' ? (rt.unity === 'il2cpp' ? 6 : 5) : spec.major
}

async function pickRelease(env: IntegrationEnv, rt: GameRuntime, major: 5 | 6) {
  const list = (await releases(env, 'BepInEx/BepInEx')).filter((r) => r.tag_name.replace(/^v/i, '').startsWith(`${major}.`))
  return fittingAssets('bepinex', list, rt)[0]
}

/** Where Doorstop goes in this game folder: winhttp.dll, or version.dll when winhttp.dll came with the game. */
export async function doorstopChoice(game: Game, mods: InstalledMod[]) {
  const managed = mods.find((m) => m.loaderId === 'bepinex')
  const ours = (managed?.routes ?? []).filter((r) => /winhttp\.dll$/i.test(r.from) && /\.dll$/i.test(r.to)).map((r) => basename(r.to))
  return chooseProxy(gameDir(game), DOORSTOP_NAMES, 'bepinex', ours.length ? ours : managed ? ['winhttp.dll'] : [])
}

export function bepinexLoader(spec: Pick<BepInExGameSpec, 'major' | 'name' | 'flexibleMajor'>): LoaderAdapter {
  return {
    id: 'bepinex',
    name: 'BepInEx',
    async status(game, _info, env, _state, mods): Promise<LoaderStatus> {
      const dir = gameDir(game)
      const f = await bepinexFiles(dir)
      const managed = mods.find((m) => m.loaderId === 'bepinex')
      const required = mods.some((m) => m.needsLoader === 'bepinex' || (m.needsLoaders ?? []).includes('bepinex'))
      const rt = await gameRuntime(game)
      const major = majorFor(spec, rt)
      let latest: string | undefined
      try {
        latest = (await pickRelease(env, rt, major))?.release.tag_name.replace(/^v/i, '')
      } catch {
        // offline: no update info
      }
      const version = f.core ? ((await env.fileVersion(f.core)) ?? managed?.version) : managed?.version
      const base = {
        id: 'bepinex',
        name: `BepInEx ${major}`,
        latest,
        dir,
        required,
        canRemove: Boolean(managed),
        via: managed || !(f.core || f.proxy) ? ('github' as const) : ('manual' as const),
        summary: 'Plugin loader for Unity games: loads the DLLs in BepInEx/plugins when the game starts.'
      }
      if (!rt.unity) {
        return { ...base, state: 'unsupported', canInstall: false, canUpdate: false, blocked: `${game.name} doesn't look like a Unity game (no Managed folder or GameAssembly.dll), so BepInEx can't run in it.` }
      }
      if (f.core && f.proxy && f.ini) {
        const outdated = Boolean(latest && version && f.major === major && compareVersions(version, latest) < 0)
        if (!spec.flexibleMajor && f.major && f.major !== major) {
          return { ...base, version, state: 'broken', canInstall: true, canUpdate: true, detail: `BepInEx ${f.major} is installed, but ${spec.name} mods need BepInEx ${major}.` }
        }
        if (f.enabled === false) return { ...base, version, state: 'broken', canInstall: true, canUpdate: false, detail: 'doorstop_config.ini has "enabled = false", so BepInEx never starts.' }
        const through = basename(f.proxy).toLowerCase() !== 'winhttp.dll' ? ` (loads through ${basename(f.proxy)})` : ''
        return { ...base, version, state: outdated ? 'outdated' : 'installed', canInstall: false, canUpdate: outdated && Boolean(managed), proxy: through ? basename(f.proxy) : undefined, detail: managed ? `Installed by NexusForge${through}` : `Installed by hand${through} (NexusForge leaves it alone)` }
      }
      const choice = await doorstopChoice(game, mods)
      if (!choice.name) {
        return {
          ...base,
          state: f.core ? 'broken' : 'missing',
          canInstall: false,
          canUpdate: false,
          blocked: `BepInEx starts through winhttp.dll or version.dll next to the game's .exe, and both names are already used by files that came with this copy of the game: ${describeTaken(choice.taken)}. NexusForge does not replace them, because the game needs them to start. MelonLoader can load under more names; check whether the mod also has a MelonLoader version.`
        }
      }
      const note = proxyNote('BepInEx', choice, 'winhttp.dll')
      if (managed) {
        return { ...base, version: managed.version, state: 'missing', canInstall: false, canUpdate: false, proxy: choice.name, detail: `In NexusForge storage; it goes into the game with the next deploy.${note ? ` ${note}` : ''}` }
      }
      if (f.core || f.proxy) return { ...base, version, state: 'broken', canInstall: true, canUpdate: false, proxy: choice.name, detail: `Parts of BepInEx are missing from the game folder.${note ? ` ${note}` : ''}` }
      return { ...base, state: 'missing', canInstall: true, canUpdate: false, proxy: choice.name, detail: `Unity ${rt.unity === 'il2cpp' ? 'IL2CPP' : 'Mono'} ${rt.arch} build: NexusForge installs the matching BepInEx ${major}.${note ? ` ${note}` : ''}` }
    },
    async install(game, _info, env, host, report, signal) {
      const rt = await gameRuntime(game)
      if (!rt.unity) throw new Error(`${game.name} is not a Unity game; BepInEx can't be installed.`)
      const major = majorFor(spec, rt)
      report('Looking up the newest BepInEx release on GitHub…')
      const pick = await pickRelease(env, rt, major)
      if (!pick) throw new Error(`No BepInEx ${major} release on GitHub fits this game (Unity ${rt.unity} ${rt.arch}).`)
      const file = join(env.workDir, 'loaders', pick.asset.name)
      await fsp.mkdir(dirname(file), { recursive: true })
      report(`Downloading ${pick.asset.name}…`, 0)
      const sha256 = sha256Of(pick.asset)
      await env.download(pick.asset.browser_download_url, file, { sha256, size: pick.asset.size, signal, onProgress: (r, t) => report(`Downloading ${pick.asset.name}…`, t ? r / t : undefined) })
      report(sha256 ? 'Download matches the SHA-256 GitHub published' : 'Download size checked (GitHub published no checksum)')
      await host.installModFile(game.id, file, {
        name: 'BepInEx',
        version: pick.release.tag_name.replace(/^v/i, ''),
        source: { sourceId: 'frameworks', modId: 'bepinex', versionId: `${pick.release.tag_name}|${pick.asset.name}`, url: pick.release.html_url, name: 'BepInEx' }
      })
      await fsp.rm(file, { force: true })
    }
  }
}
/** Reads BepInEx's LogOutput.log written by the last start of the game. */
export async function readBepInExLog(dir: string, since: number): Promise<LaunchCheck> {
  const file = join(dir, 'BepInEx', 'LogOutput.log')
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return { ran: false, loaded: [], errors: [], logFile: file, at: st.mtimeMs }
    const text = await fsp.readFile(file, 'utf8')
    const loaded = [...text.matchAll(/^\[(?:Info|Message)\s*:\s*BepInEx\]\s+Loading \[(.+?)\]\s*$/gm)].map((m) => m[1])
    const errors = text
      .split(/\r?\n/)
      .filter((l) => /^\[(Error|Fatal)\s*:/.test(l))
      .slice(0, 20)
    const version = text.match(/BepInEx (\d+\.\d+\.\d+(?:\.\d+)?)/)?.[1]
    return { ran: true, loader: version ? `BepInEx ${version}` : 'BepInEx', loaded, errors, logFile: file, at: st.mtimeMs }
  } catch {
    return { ran: false, loaded: [], errors: [], logFile: file }
  }
}

function matchesSpec(spec: BepInExGameSpec, game: Game): boolean {
  if (game.platform === 'steam' && game.platformId && spec.steam.includes(game.platformId)) return true
  if (spec.names.some((r) => r.test(game.name) || (game.storeName ? r.test(game.storeName) : false))) return true
  return Boolean(spec.exe && game.exePath && basename(game.exePath).toLowerCase() === spec.exe.toLowerCase())
}

/** The integration for one BepInEx game (or, with `anyUnityWithBepInEx`, for Unity games that already have it). */
export function bepinexIntegration(spec: BepInExGameSpec, opts: { anyUnityWithBepInEx?: boolean } = {}): GameIntegration {
  const loader = bepinexLoader(spec)
  const integration: GameIntegration = {
    id: spec.id,
    revision: 1,
    loadVerifiable: true,
    loaders: [loader],
    async matches(game) {
      if (matchesSpec(spec, game)) return true
      if (!opts.anyUnityWithBepInEx) return false
      const f = await bepinexFiles(gameDir(game))
      return Boolean(f.core) && Boolean((await gameRuntime(game)).unity)
    },
    async inspect(game, env, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo> {
      const dir = gameDir(game)
      const rt = await gameRuntime(game)
      const problems: string[] = []
      if (game.missing) problems.push('The install folder is missing.')
      else if (!game.exePath || !(await fileExists(game.exePath))) problems.push(`The game executable${spec.exe ? ` (${spec.exe})` : ''} was not found in ${game.installDir}. Set it in the game settings.`)
      else if (!rt.unity) problems.push('No Unity Managed folder or GameAssembly.dll next to the executable; this does not look like the Unity game NexusForge expects.')
      const distribution = await distributionOf(game)
      let version = game.platform === 'steam' ? undefined : game.version || undefined
      if (game.platform === 'steam' && game.platformId) {
        const app = await env.steam.app(game.platformId).catch(() => undefined)
        if (app?.buildId) version = `Steam build ${app.buildId}`
      }
      const name = opts.anyUnityWithBepInEx && !matchesSpec(spec, game) ? game.name : spec.name
      const info: IntegrationInfo = {
        gameId: game.id,
        integrationId: spec.id,
        name: `${name} · BepInEx`,
        support: spec.support,
        distribution,
        version,
        valid: !problems.length,
        problems,
        targets: [{ id: 'game', label: 'Game folder', dir }],
        loaders: [],
        launchOptions: [],
        capabilities: spec.capabilities ?? [
          `Installs BepInEx ${majorFor(spec, rt)} (official GitHub release, ${rt.unity === 'il2cpp' ? 'IL2CPP' : 'Mono'} ${rt.arch}) when a mod needs it; a winhttp.dll that came with the game stays, BepInEx then uses version.dll.`,
          'Puts plugin DLLs into BepInEx/plugins/<mod>/, leaves read-me files and second copies of BepInEx out.',
          'Checks after deploying that BepInEx and every plugin are in place, and reads BepInEx\'s log after you play.'
        ],
        warnings: [],
        limitations: spec.limitations ?? [],
        inspectedAt: Date.now()
      }
      info.loaders = [await loader.status(game, info, env, state, mods)]
      const deployedLoader = info.loaders[0].state === 'installed' || info.loaders[0].state === 'outdated'
      info.launchOptions = [
        { id: 'modded', label: 'Play', description: deployedLoader ? 'With BepInEx and your mods' : 'BepInEx is not in the game yet', available: true, primary: true },
        {
          id: 'vanilla',
          label: 'Play without mods',
          description: 'Starts the game with BepInEx switched off for this one start (--doorstop-enabled false); nothing is removed.',
          available: deployedLoader,
          reason: deployedLoader ? undefined : 'BepInEx is not installed, so the game always starts without mods.'
        }
      ]
      if (game.modding.targetDir && game.modding.targetDir.toLowerCase() !== dir.toLowerCase()) {
        info.warnings.push(`The game settings deploy into ${game.modding.targetDir}, but BepInEx must sit next to the game's .exe; NexusForge deploys into ${dir}.`)
      }
      return info
    },
    async classify(pkg, _game, info) {
      return classifyBepInEx(pkg, pkg.name, spec, info.loaders.find((l) => l.id === 'bepinex')?.proxy)
    },
    async verify(game, info, manifest, mods): Promise<VerifyCheck[]> {
      const dir = gameDir(game)
      const f = await bepinexFiles(dir)
      const deployedIds = new Set(manifest.entries.map((e) => e.modId))
      const plugins = mods.filter((m) => m.needsLoader === 'bepinex' && deployedIds.has(m.id))
      const checks: VerifyCheck[] = []
      if (!plugins.length && !deployedIds.size) return checks
      checks.push({ label: 'BepInEx is in the game folder', ok: Boolean(f.core && f.proxy && f.ini), level: plugins.length ? 'error' : 'warning', detail: f.core ? (f.proxy ? (f.ini ? undefined : 'doorstop_config.ini is missing') : 'Doorstop (winhttp.dll or version.dll) is missing') : 'BepInEx/core is missing' })
      const want = majorFor(spec, await gameRuntime(game))
      if (f.core && !spec.flexibleMajor) checks.push({ label: `BepInEx ${f.major} matches what ${spec.name} mods need`, ok: f.major === want, level: 'error', detail: f.major !== want ? `Installed: BepInEx ${f.major}, needed: ${want}` : undefined })
      if (f.ini) checks.push({ label: 'BepInEx is switched on (doorstop_config.ini)', ok: f.enabled !== false, level: 'error' })
      for (const m of plugins) {
        const own = manifest.entries.filter((e) => e.modId === m.id)
        const dlls = own.filter((e) => /\.dll$/i.test(e.rel))
        const inPlugins = dlls.filter((e) => /^bepinex\/(plugins|patchers)\//i.test(e.rel))
        checks.push({
          label: `${m.name}: plugin is where BepInEx loads it`,
          ok: !dlls.length || inPlugins.length > 0,
          level: dlls.length ? 'error' : 'info',
          detail: dlls.length ? (inPlugins.length ? `${inPlugins.length} DLL(s) in BepInEx/plugins` : `DLL(s) outside BepInEx/plugins: ${dlls.map((d) => d.rel).join(', ')}`) : 'no DLL in this mod'
        })
      }
      void info
      return checks
    },
    async launch(game, info, variant, env) {
      if (variant !== 'vanilla') return undefined
      if (!info.launchOptions.find((o) => o.id === 'vanilla')?.available) return undefined
      const args = ['--doorstop-enabled', 'false']
      if (game.platform === 'steam' && game.platformId) {
        const root = await env.steam.root()
        if (root) return { spec: { kind: 'exe', exe: join(root, 'steam.exe'), args: ['-applaunch', game.platformId, ...args] }, followDir: gameDir(game) }
      }
      if (!game.exePath) return undefined
      return { spec: { kind: 'exe', exe: game.exePath, args, cwd: gameDir(game) } }
    },
    async checkLaunch(game, _info, since) {
      return readBepInExLog(gameDir(game), since)
    }
  }
  return integration
}

/** Unity games with BepInEx-based modding NexusForge knows. */
export const BEPINEX_GAMES: BepInExGameSpec[] = [
  { id: 'valheim', name: 'Valheim', steam: ['892970'], names: [/^valheim$/i], exe: 'valheim.exe', support: 'partial', major: 5 },
  { id: 'lethal-company', name: 'Lethal Company', steam: ['1966720'], names: [/^lethal company$/i], exe: 'Lethal Company.exe', support: 'partial', major: 5 },
  { id: 'risk-of-rain-2', name: 'Risk of Rain 2', steam: ['632360'], names: [/^risk of rain 2$/i], exe: 'Risk of Rain 2.exe', support: 'partial', major: 5 }
]

/** Unity games that already have BepInEx in their folder (installed by hand or by NexusForge). */
export const unityWithBepInEx = bepinexIntegration(
  { id: 'unity-bepinex', name: 'Unity game', steam: [], names: [], support: 'partial', major: 5, flexibleMajor: true, limitations: ['NexusForge has no game-specific rules for this game; it follows BepInEx\'s standard layout.'] },
  { anyUnityWithBepInEx: true }
)
