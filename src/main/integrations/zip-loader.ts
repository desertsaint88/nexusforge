// Mod loaders that come as one official .zip laid out like the game folder (MelonLoader, UE4SS, Cyber Engine
// Tweaks, RED4ext, redscript, ArchiveXL, TweakXL, Codeware, Script Hook V .NET, Script Hook V).
//
// They are installed like a mod: downloaded from the publisher's release channel (SHA-256 checked when the
// publisher states one), unpacked into NexusForge's storage, then deployed with everything else, so the deploy
// engine records every file, backs up whatever it replaces, and a purge takes the loader out again. Proxy DLLs
// go in under a name nothing else in the game folder uses (see proxy.ts).

import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Game, InstalledMod, IntegrationInfo, LoaderStatus, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, IntegrationEnv, IntegrationState, LoaderAdapter, StagedPackage } from './types'
import { children, compareVersions, fileExists, isDocFile, route } from './common'
import { releases, sha256Of, type GhAsset, type GhRelease } from './github'
import { chooseProxy, describeTaken, proxyNote, type ProxyChoice, type ProxyOwner } from './proxy'
import { FRAMEWORKS_ID, fittingAssets, gameRuntime, type GameRuntime } from '../sources/frameworks'
import type { WalkEntry } from '../util/fs'

export interface LoaderDownload {
  url: string
  fileName: string
  version: string
  tag?: string
  sha256?: string
  size?: number
  pageUrl?: string
  prerelease?: boolean
  headers?: Record<string, string>
  allowedHosts?: string[]
}

export interface ZipLoaderContext {
  game: Game
  info?: IntegrationInfo
  rt: GameRuntime
}

export interface ZipLoaderSpec {
  id: string
  name: string
  summary: string
  /** GitHub repository with the official releases (asset choice: sources/frameworks.ts). */
  repo?: string
  /** Release lookup for loaders not published on GitHub, or with special rules. */
  resolve?(env: IntegrationEnv, ctx: ZipLoaderContext): Promise<LoaderDownload>
  /** Deploy target the package root goes to. */
  target: string
  /** Absolute folder of that target for a game (for status checks before inspection). */
  targetDir(game: Game, info?: IntegrationInfo): string
  /** Files (relative to the target) that show the loader is in place; also how its own package is recognized. */
  markers: string[]
  /** A package is this loader only if it also has these files (default: the markers) and none matching notInPackage. */
  packageMarkers?: string[]
  notInPackage?: RegExp
  /** Overrides the marker check for the installed loader (layouts that differ between releases). */
  present?(game: Game, info?: IntegrationInfo): Promise<{ ok: boolean; missing: string[] }>
  /** File in the package whose version is the loader's version (relative to the package root). */
  versionFile?: string
  /** The proxy DLL (path in the package, relative to the root) and every name the loader can run under. */
  proxy?: { file: string; names: string[]; owner: ProxyOwner }
  /** Package paths (relative to the root) that are not deployed, and why. */
  leaveOut?: Array<[RegExp, string]>
  /** Other loaders this one needs (installed first). */
  requires?: string[]
  /** Why it can't go into this game (wrong engine, unsupported version, …). */
  unsupported?(game: Game, env: IntegrationEnv, ctx: ZipLoaderContext): Promise<string | undefined>
  /** Extra warning shown with the loader (anti-cheat, version notes). */
  warning?(game: Game, env: IntegrationEnv, ctx: ZipLoaderContext): Promise<string | undefined>
}

// ---------------------------------------------------------------------------
// Package routing

/**
 * Routes a whole folder of a package to a target, except one file: the folders on the way to it are split up so
 * the file can go in under another name.
 */
export function routesExcept(files: WalkEntry[], root: string, except: string, target: string, toPrefix = ''): ModRoute[] {
  const out: ModRoute[] = []
  const j = (a: string, b: string) => (a ? `${a}/${b}` : b)
  const parts = except.split('/')
  let from = root
  let to = toPrefix
  for (let i = 0; i < parts.length; i++) {
    const c = children(files, from)
    const last = i === parts.length - 1
    for (const d of c.dirs) if (last || d.toLowerCase() !== parts[i].toLowerCase()) out.push(route(j(from, d), target, j(to, d)))
    for (const f of c.files) if (!(last && f.toLowerCase() === parts[i].toLowerCase())) out.push(route(j(from, f), target, j(to, f)))
    if (last) break
    const next = c.dirs.find((d) => d.toLowerCase() === parts[i].toLowerCase())
    if (!next) break
    from = j(from, next)
    to = j(to, next)
  }
  return out
}

/** The folder of a package that holds every marker file (the loader's root), if any. */
export function findMarkerRoot(files: WalkEntry[], markers: string[]): string | undefined {
  if (!markers.length) return undefined
  const first = markers[0].toLowerCase()
  const roots = new Set<string>()
  for (const f of files) {
    const rel = f.rel.toLowerCase()
    if (rel === first) roots.add('')
    else if (rel.endsWith(`/${first}`)) roots.add(f.rel.slice(0, f.rel.length - first.length - 1))
  }
  const lower = new Set(files.map((f) => f.rel.toLowerCase()))
  const sorted = [...roots].sort((a, b) => a.length - b.length)
  return sorted.find((r) => markers.every((m) => lower.has((r ? `${r}/${m}` : m).toLowerCase())))
}

/** The package is this loader (downloaded by NexusForge, or the same archive from a mod site). */
export function isLoaderPackage(spec: Pick<ZipLoaderSpec, 'id' | 'markers' | 'packageMarkers' | 'notInPackage'>, pkg: StagedPackage): boolean {
  if (pkg.source?.sourceId === FRAMEWORKS_ID && pkg.source.modId === spec.id) return true
  if (pkg.loaderHint === spec.id) return true
  const root = findMarkerRoot(pkg.files, spec.packageMarkers ?? spec.markers)
  if (root === undefined) return false
  // A mod that bundles a copy of the loader is still a mod (an .asi next to ScriptHookV.dll, scripts next to SHVDN).
  if (spec.notInPackage && pkg.files.some((f) => spec.notInPackage!.test(f.rel))) return false
  // Little else besides the loader: read-me files at most.
  const outside = pkg.files.filter((f) => !(root ? f.rel.toLowerCase().startsWith(`${root.toLowerCase()}/`) : true) && !isDocFile(basename(f.rel)))
  return outside.length === 0
}

/** Lays a loader's own package out onto its target, with the proxy under the chosen name. */
export function classifyLoaderPackage(spec: ZipLoaderSpec, pkg: StagedPackage, proxyName?: string): Classification {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const root = findMarkerRoot(pkg.files, spec.markers) ?? (spec.proxy ? (findMarkerRoot(pkg.files, [spec.proxy.file]) ?? '') : '')
  const prefix = root ? `${root}/` : ''
  const top = children(pkg.files, root)
  for (const f of top.files) if (isDocFile(f) || /^(license|third_party_licenses)/i.test(f)) skipped.push({ path: prefix + f, reason: 'read-me or license file' })
  for (const f of pkg.files) {
    if (!f.rel.toLowerCase().startsWith(prefix.toLowerCase())) continue
    const sub = f.rel.slice(prefix.length)
    for (const [re, reason] of spec.leaveOut ?? []) if (re.test(sub)) skipped.push({ path: f.rel, reason })
  }
  let routes: ModRoute[]
  if (spec.proxy && proxyName && proxyName.toLowerCase() !== basename(spec.proxy.file).toLowerCase()) {
    const p = spec.proxy.file
    routes = routesExcept(pkg.files, root, p, spec.target)
    const dir = dirname(p).replace(/\\/g, '/')
    routes.push(route(prefix + p, spec.target, dir === '.' ? proxyName : `${dir}/${proxyName}`))
  } else {
    routes = [route(root, spec.target)]
  }
  if (spec.proxy && !proxyName) checks.push({ level: 'error', code: 'proxy_taken', message: `Every file name ${spec.name} can load under is already used by another file in the game folder.` })
  return { kind: 'loader', loaderId: spec.id, routes, skipped, checks, rootPath: root, name: spec.name }
}

// ---------------------------------------------------------------------------
// The adapter

async function githubDownload(env: IntegrationEnv, spec: ZipLoaderSpec, rt: GameRuntime, pick?: (r: GhRelease) => boolean): Promise<LoaderDownload> {
  const list = (await releases(env, spec.repo!)).filter((r) => !pick || pick(r))
  const fit = fittingAssets(spec.id, list, rt)[0]
  if (!fit) throw new Error(`No ${spec.name} release on GitHub fits this game.`)
  return fromGithub(fit.release, fit.asset)
}

export function fromGithub(rel: GhRelease, asset: GhAsset): LoaderDownload {
  return {
    url: asset.browser_download_url,
    fileName: asset.name,
    version: rel.tag_name.replace(/^v/i, ''),
    tag: rel.tag_name,
    sha256: sha256Of(asset),
    size: asset.size,
    pageUrl: rel.html_url,
    prerelease: rel.prerelease
  }
}

export function resolveDownload(env: IntegrationEnv, spec: ZipLoaderSpec, ctx: ZipLoaderContext): Promise<LoaderDownload> {
  if (spec.resolve) return spec.resolve(env, ctx)
  return githubDownload(env, spec, ctx.rt)
}

/** Where the proxy goes and which names NexusForge itself put there for this loader. */
export async function proxyChoiceFor(spec: ZipLoaderSpec, game: Game, mods: InstalledMod[], info?: IntegrationInfo): Promise<ProxyChoice | undefined> {
  if (!spec.proxy) return undefined
  const dir = join(spec.targetDir(game, info), dirname(spec.proxy.file))
  const managed = mods.find((m) => m.loaderId === spec.id)
  const ours = (managed?.routes ?? []).filter((r) => /\.dll$/i.test(r.to) && r.from.toLowerCase().endsWith(basename(spec.proxy!.file).toLowerCase())).map((r) => basename(r.to))
  return chooseProxy(dir, spec.proxy.names, spec.proxy.owner, ours.length ? ours : managed ? [basename(spec.proxy.file)] : [])
}

async function missingMarkers(spec: ZipLoaderSpec, game: Game, info?: IntegrationInfo): Promise<string[]> {
  if (spec.present) return (await spec.present(game, info)).missing
  const dir = spec.targetDir(game, info)
  const missing: string[] = []
  for (const m of spec.markers) if (!(await fileExists(join(dir, ...m.split('/'))))) missing.push(m)
  return missing
}

export async function markersPresent(spec: ZipLoaderSpec, game: Game, info?: IntegrationInfo): Promise<boolean> {
  return !(await missingMarkers(spec, game, info)).length
}

export function zipLoader(spec: ZipLoaderSpec): LoaderAdapter & { spec: ZipLoaderSpec } {
  return {
    id: spec.id,
    name: spec.name,
    spec,
    async status(game, info, env, _state: IntegrationState, mods): Promise<LoaderStatus> {
      const rt = await gameRuntime(game)
      const ctx = { game, info, rt }
      const dir = spec.targetDir(game, info)
      const managed = mods.find((m) => m.loaderId === spec.id)
      const required = mods.some((m) => loadersNeeded(m).includes(spec.id))
      const present = await markersPresent(spec, game, info)
      // 'manual' only for a loader that is there without NexusForge; otherwise where it comes (or came) from.
      const official = spec.repo ? ('github' as const) : ('nexusforge' as const)
      const base = { id: spec.id, name: spec.name, dir, required, summary: spec.summary, requires: spec.requires, canRemove: Boolean(managed), via: managed || !present ? official : ('manual' as const) }
      const unsupported = await spec.unsupported?.(game, env, ctx)
      if (unsupported) return { ...base, state: 'unsupported', canInstall: false, canUpdate: false, blocked: unsupported }
      const warning = await spec.warning?.(game, env, ctx)
      let latest: string | undefined
      try {
        latest = (await resolveDownload(env, spec, ctx)).version
      } catch {
        // offline or no fitting release: no update info
      }
      const proxy = await proxyChoiceFor(spec, game, mods, info)
      const proxyOk = !spec.proxy || Boolean(proxy?.existing)
      const version = managed?.version
      if (present && proxyOk) {
        const outdated = Boolean(managed && latest && version && compareVersions(version, latest) < 0)
        return {
          ...base,
          version,
          latest,
          state: outdated ? 'outdated' : 'installed',
          canInstall: false,
          canUpdate: outdated,
          warning,
          proxy: proxy?.existing,
          detail: managed ? `Installed by NexusForge${proxy?.existing ? ` (loads through ${proxy.existing})` : ''}` : 'Installed by hand (NexusForge leaves it alone)'
        }
      }
      if (spec.proxy && !proxy?.name) {
        return {
          ...base,
          state: present ? 'broken' : 'missing',
          canInstall: false,
          canUpdate: false,
          warning,
          blocked: `${spec.name} loads through a DLL next to the game's .exe, and every name it can use is already taken by files that came with this copy of the game: ${describeTaken(proxy?.taken ?? [])}. NexusForge does not replace them, because the game needs them to start.`
        }
      }
      const note = proxy ? proxyNote(spec.name, proxy, basename(spec.proxy!.file)) : undefined
      if (managed) return { ...base, version, latest, state: 'missing', canInstall: false, canUpdate: false, warning, proxy: proxy?.name, detail: `In NexusForge storage; it goes into the game with the next deploy.${note ? ` ${note}` : ''}` }
      return {
        ...base,
        latest,
        state: present ? 'broken' : 'missing',
        canInstall: true,
        canUpdate: false,
        warning,
        proxy: proxy?.name,
        detail: [present ? `Parts of ${spec.name} are there, but it is not complete.` : `NexusForge installs ${spec.name}${latest ? ` ${latest}` : ''} from its official release.`, note].filter(Boolean).join(' ')
      }
    },
    async install(game, info, env, host, report, signal) {
      const rt = await gameRuntime(game)
      const ctx = { game, info, rt }
      const blocked = await spec.unsupported?.(game, env, ctx)
      if (blocked) throw new Error(blocked)
      report(`Looking up the newest ${spec.name} release…`)
      const dl = await resolveDownload(env, spec, ctx)
      const file = join(env.workDir, 'loaders', dl.fileName)
      await fsp.mkdir(dirname(file), { recursive: true })
      report(`Downloading ${dl.fileName}…`, 0)
      await env.download(dl.url, file, { sha256: dl.sha256, size: dl.size, signal, headers: dl.headers, allowedHosts: dl.allowedHosts, onProgress: (r, t) => report(`Downloading ${dl.fileName}…`, t ? r / t : undefined) })
      report(dl.sha256 ? 'Download matches the SHA-256 the publisher states' : dl.size ? 'Download size checked (the publisher states no checksum)' : 'Downloaded (the publisher states no checksum)')
      try {
        await host.installModFile(game.id, file, {
          name: spec.name,
          version: dl.version,
          source: { sourceId: FRAMEWORKS_ID, modId: spec.id, versionId: `${dl.tag ?? dl.version}|${dl.fileName}`, url: dl.pageUrl, name: spec.name }
        })
      } finally {
        await fsp.rm(file, { force: true }).catch(() => {})
      }
    }
  }
}

/** Checks after deploying: the loader's files are where the game loads them, and the proxy is the loader's. */
export async function verifyLoader(spec: ZipLoaderSpec, game: Game, info: IntegrationInfo, mods: InstalledMod[], level: 'error' | 'warning'): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = []
  const missing = await missingMarkers(spec, game, info)
  checks.push({ label: `${spec.name} is in place`, ok: !missing.length, level, detail: missing.length ? `missing: ${missing.join(', ')}` : undefined })
  if (spec.proxy) {
    const p = await proxyChoiceFor(spec, game, mods, info)
    checks.push({ label: `${spec.name} loads through ${p?.existing ?? basename(spec.proxy.file)}`, ok: Boolean(p?.existing), level, detail: p?.existing ? undefined : `the ${spec.proxy.names.join(' / ')} next to the game is not ${spec.name}'s` })
  }
  return checks
}

/** Mods that need a loader, and the loaders they need (deduplicated, in install order). */
export function loadersNeeded(cls: Pick<Classification, 'needsLoader' | 'needsLoaders'>): string[] {
  return [...new Set([cls.needsLoader, ...(cls.needsLoaders ?? [])].filter((x): x is string => Boolean(x)))]
}
