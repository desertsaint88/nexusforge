// Terraria and tModLoader.
//
// Facts this follows (tModLoader wiki "tModLoader guide for players" and its source, branch 1.4.4, 2026-10):
// - tModLoader is a separate program next to vanilla Terraria, never files copied into Terraria's folder.
//   Steam: the free app 1281930 (needs Terraria owned on Steam). GOG: tModLoader.zip from the official GitHub
//   releases, unpacked into a "tModLoader" folder next to or inside the Terraria folder, started with
//   start-tModLoader.bat (which fetches the .NET runtime it needs on the first start).
// - tModLoader checks the Terraria copy itself when it starts (Engine/InstallVerifier.cs): Steam installs through
//   the Steam client and Terraria ownership; GOG installs by the MD5 of an unmodified Terraria.exe of the exact
//   Terraria version that tModLoader release is made for. NexusForge never works around that check; for copies
//   that are neither, it says so and supports what vanilla Terraria loads (worlds, characters, resource packs).
// - Saves: Documents\My Games\Terraria (vanilla) and Documents\My Games\Terraria\tModLoader (stable;
//   tModLoader-preview / tModLoader-1.4.3 for those branches; <install>\tModLoader with savehere.txt).
//   Mods are <saves>\Mods\*.tmod, switched on by name in <saves>\Mods\enabled.json (a JSON list).
// - Worlds/characters are separate for tModLoader (Worlds/Players under its save folder, .twld/.tplr next to them).

import { createReadStream, promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { DeployManifest, DeployTarget, Game, InstalledMod, IntegrationInfo, LaunchCheck, LoaderStatus, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationEnv, IntegrationState, LoaderAdapter, LoaderInstallHost, StagedPackage, StepReporter, SteamApp } from './types'
import { children, compareVersions, dirExists, fileExists, folderName, gogInfo, isDocFile, route } from './common'
import { latestRelease, releases, sha256Of, type GhRelease } from './github'
import { readTmod, tmlFamily, tmlNewer, type TmodInfo } from './tmod'
import { readJson, renameDir, writeJsonAtomic } from '../util/fs'

export const TERRARIA_APP = '105600'
export const TML_APP = '1281930'
export const TERRARIA_GOG = '1207665503'
const TML_REPO = 'tModLoader/tModLoader'

// ---------------------------------------------------------------------------
// Where things are

export interface TmlInstall {
  dir: string
  via: 'steam' | 'github' | 'manual'
  version?: string
  /** Save folder name under My Games\Terraria. */
  saveFolder: 'tModLoader' | 'tModLoader-preview' | 'tModLoader-1.4.3'
  /** savehere.txt: saves live inside the install folder. */
  portable: boolean
  steam?: SteamApp
  /** Steam has it, but it is still downloading or needs an update. */
  pending?: boolean
}

export type TerrariaDistribution = 'steam' | 'gog' | 'other'

export async function terrariaDistribution(game: Game): Promise<TerrariaDistribution> {
  if (game.platform === 'steam' && game.platformId === TERRARIA_APP) return 'steam'
  if (game.platform === 'gog') return 'gog'
  const gog = await gogInfo(game.installDir)
  if (gog && (gog.gameId === TERRARIA_GOG || /terraria/i.test(gog.name ?? ''))) return 'gog'
  return 'other'
}

function vanillaSaves(env: IntegrationEnv): string {
  return join(env.documents, 'My Games', 'Terraria')
}

export function tmlSaves(env: IntegrationEnv, tml: TmlInstall): string {
  return tml.portable ? join(tml.dir, tml.saveFolder) : join(vanillaSaves(env), tml.saveFolder)
}

/**
 * tModLoader's own version (year.month.patch.build). Its DLL's version resource leads with the Terraria version
 * and carries tModLoader's after a "+" ("1.4.4.9+2026.08.3.0|2026.08|stable|…"), so the year-based part is taken.
 */
export function parseTmlVersion(raw: string | undefined): string | undefined {
  return raw?.match(/\b(20\d\d\.\d{1,2}\.\d+(?:\.\d+)?)\b/)?.[1]
}

async function tmlVersion(env: IntegrationEnv, dir: string, fallback?: string): Promise<string | undefined> {
  return parseTmlVersion(await env.fileVersion(join(dir, 'tModLoader.dll'))) ?? fallback
}

/** Where tModLoader is installed for this Terraria, if it is. */
export async function findTml(game: Game, env: IntegrationEnv, state: IntegrationState): Promise<TmlInstall | undefined> {
  const dist = await terrariaDistribution(game)
  const folderFor = (preview: boolean, legacy: boolean): TmlInstall['saveFolder'] => (legacy ? 'tModLoader-1.4.3' : preview ? 'tModLoader-preview' : 'tModLoader')
  if (dist === 'steam') {
    const app = await env.steam.app(TML_APP).catch(() => undefined)
    if (app && (await dirExists(app.dir))) {
      const beta = (app.betaKey ?? '').toLowerCase()
      return {
        dir: app.dir,
        via: 'steam',
        version: await tmlVersion(env, app.dir),
        saveFolder: folderFor(beta.includes('preview'), beta.includes('1.4.3')),
        portable: await fileExists(join(app.dir, 'savehere.txt')),
        steam: app,
        pending: !(app.stateFlags & 4) || Boolean(app.stateFlags & 2) || !(await fileExists(join(app.dir, 'tModLoader.dll')))
      }
    }
  }
  const rec = state.loaders.tmodloader
  const candidates: Array<{ dir: string; via: TmlInstall['via'] }> = []
  if (rec?.dir) candidates.push({ dir: rec.dir, via: rec.via === 'github' ? 'github' : 'manual' })
  candidates.push({ dir: join(dirname(game.installDir), 'tModLoader'), via: 'manual' }, { dir: join(game.installDir, 'tModLoader'), via: 'manual' })
  for (const c of candidates) {
    if (!(await fileExists(join(c.dir, 'tModLoader.dll')))) continue
    const ours = rec?.dir && rec.dir.toLowerCase() === c.dir.toLowerCase()
    const preview = ours ? Boolean(rec?.prerelease || /preview/i.test(rec?.tag ?? '')) : false
    return {
      dir: c.dir,
      via: ours ? (rec!.via === 'github' ? 'github' : 'manual') : 'manual',
      version: await tmlVersion(env, c.dir, ours ? rec?.version : undefined),
      saveFolder: folderFor(preview, false),
      portable: await fileExists(join(c.dir, 'savehere.txt'))
    }
  }
  return undefined
}

/** Where a GitHub tModLoader goes: next to a folder called "Terraria" (as the wiki shows), else inside it (tModLoader looks in its parent folder too). */
export async function tmlInstallDir(game: Game, dist?: TerrariaDistribution): Promise<string> {
  // Copies outside a store keep it inside their own folder (no new folder next to the games in a library folder).
  if (dist !== 'other' && basename(game.installDir).toLowerCase() === 'terraria') {
    const side = join(dirname(game.installDir), 'tModLoader')
    if (!(await dirExists(side)) || (await fileExists(join(side, 'tModLoader.dll')))) return side
  }
  return join(game.installDir, 'tModLoader')
}

/** The Terraria version a tModLoader release verifies GOG installs against (its InstallVerifier.cs). */
export async function requiredTerrariaVersion(env: IntegrationEnv, tag: string): Promise<string | undefined> {
  try {
    const src = await env.fetchText(`https://raw.githubusercontent.com/${TML_REPO}/${encodeURIComponent(tag)}/patches/tModLoader/Terraria/ModLoader/Engine/InstallVerifier.cs`)
    return src.match(/TerrariaVersion\s*=\s*"([\d.]+)"/)?.[1]
  } catch {
    return undefined
  }
}

/** The Windows hashes a tModLoader release's InstallVerifier.cs accepts for Terraria.exe in its "GoG" mode. */
export function parseVerifier(src: string): { terrariaVersion?: string; hashes: string[] } {
  const terrariaVersion = src.match(/TerrariaVersion\s*=\s*"([\d.]+)"/)?.[1]
  // The Windows block comes first in the static constructor.
  const gog = src.match(/gogHash\s*=\s*ToByteArray\("([0-9a-f]{32})"\)/i)?.[1]
  const steam = src.match(/steamHash\s*=\s*ToByteArray\("([0-9a-f]{32})"\)/i)?.[1]
  const steamAccepted = /HashMatchesFile\(\s*vanillaExePath\s*,\s*steamHash\s*\)/.test(src)
  return { terrariaVersion, hashes: [gog, steamAccepted ? steam : undefined].filter((x): x is string => Boolean(x)).map((h) => h.toLowerCase()) }
}

async function md5File(file: string): Promise<string> {
  const h = createHash('md5')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

export interface TmlVerdict {
  ok: boolean
  release?: GhRelease
  /** Terraria version the picked release is made for. */
  terrariaVersion?: string
  /** The newest release, when an older one had to be picked. */
  newest?: string
  reason?: string
}

const verdicts = new Map<string, { at: number; v: TmlVerdict }>()

/**
 * What tModLoader's own start check (Engine/InstallVerifier.cs) will say about this Terraria folder, for copies
 * that are not in a Steam library: with steam_api.dll next to Terraria.exe it starts in Steam mode (Steam client
 * and Terraria ownership); without, it accepts an unmodified Terraria.exe of exactly the version a release is
 * made for (the GOG build's or the Steam build's MD5). NexusForge picks the newest release that accepts this
 * Terraria.exe, so tModLoader starts; it never patches that check.
 */
export async function tmlVerdict(game: Game, env: IntegrationEnv): Promise<TmlVerdict> {
  const exe = join(game.installDir, 'Terraria.exe')
  if (await fileExists(join(game.installDir, 'steam_api.dll'))) {
    return {
      ok: false,
      reason:
        'This Terraria folder has steam_api.dll, so tModLoader starts in Steam mode and checks through the Steam client that you own Terraria on Steam. NexusForge does not change how tModLoader checks the copy. Worlds, characters and resource packs work without tModLoader.'
    }
  }
  if (!(await fileExists(exe))) return { ok: false, reason: `Terraria.exe was not found in ${game.installDir}.` }
  let md5: string
  try {
    md5 = await md5File(exe)
  } catch (err) {
    return { ok: false, reason: `Terraria.exe could not be read (${(err as Error).message}).` }
  }
  const list = (await releases(env, TML_REPO)).filter((r) => !r.prerelease && r.assets.some((a) => a.name === 'tModLoader.zip')).slice(0, 10)
  const key = `${md5}|${list.map((r) => r.tag_name).join(',')}`
  const hit = verdicts.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v
  let newestVersion: string | undefined
  let v: TmlVerdict | undefined
  for (const rel of list) {
    let parsed: ReturnType<typeof parseVerifier>
    try {
      parsed = parseVerifier(await env.fetchText(`https://raw.githubusercontent.com/${TML_REPO}/${encodeURIComponent(rel.tag_name)}/patches/tModLoader/Terraria/ModLoader/Engine/InstallVerifier.cs`))
    } catch {
      continue
    }
    newestVersion ??= parsed.terrariaVersion
    if (parsed.hashes.includes(md5)) {
      v = { ok: true, release: rel, terrariaVersion: parsed.terrariaVersion, newest: rel === list[0] ? undefined : list[0].tag_name }
      break
    }
  }
  v ??= {
    ok: false,
    reason: `tModLoader only starts with an unmodified Terraria.exe of the exact version a release is made for${newestVersion ? ` (the newest is made for Terraria ${newestVersion})` : ''}, and this Terraria.exe${game.version ? ` (${game.version})` : ''} matches none of the last ${list.length} releases. A Terraria.exe that was changed is refused by tModLoader itself; NexusForge does not patch that check. With an unmodified Terraria of that version in this folder, NexusForge can set tModLoader up.`
  }
  verdicts.set(key, { at: Date.now(), v })
  return v
}

/** For tests: forget remembered verdicts. */
export function clearTmlVerdicts(): void {
  verdicts.clear()
}
// ---------------------------------------------------------------------------
// The loader

async function waitForSteamApp(env: IntegrationEnv, appId: string, report: StepReporter, signal?: AbortSignal, timeoutMs = 45 * 60_000): Promise<SteamApp> {
  const until = Date.now() + timeoutMs
  let seen = false
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled (Steam keeps downloading in the background).')
    const app = await env.steam.app(appId).catch(() => undefined)
    if (app) {
      seen = true
      const done = Boolean(app.stateFlags & 4) && !(app.stateFlags & 2) && (await fileExists(join(app.dir, 'tModLoader.dll')))
      if (done) return app
      const total = app.bytesToDownload ?? 0
      report(total ? 'Steam is downloading tModLoader…' : 'Steam is preparing tModLoader…', total ? (app.bytesDownloaded ?? 0) / total : undefined)
    } else {
      report('Confirm the installation in the Steam window (Install button).')
    }
    if (Date.now() > until) {
      throw new Error(seen ? 'Steam did not finish installing tModLoader in time; it continues in Steam. Deploy again when it is done.' : 'Steam did not start installing tModLoader. Check that Steam is running and that you own Terraria on Steam.')
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
}

async function installFromGithub(game: Game, env: IntegrationEnv, host: LoaderInstallHost, report: StepReporter, signal?: AbortSignal, picked?: GhRelease): Promise<void> {
  report(picked ? `tModLoader ${picked.tag_name} accepts this Terraria.exe…` : 'Looking up the newest tModLoader release on GitHub…')
  const rel: GhRelease = picked ?? (await latestRelease(env, TML_REPO))
  const asset = rel.assets.find((a) => a.name === 'tModLoader.zip')
  if (!asset) throw new Error(`tModLoader ${rel.tag_name} has no tModLoader.zip on GitHub.`)
  // GOG copies are verified against exactly one Terraria version; check before downloading 60 MB.
  const required = picked ? undefined : await requiredTerrariaVersion(env, rel.tag_name)
  if (required && game.version && compareVersions(game.version, required) !== 0) {
    throw new Error(`tModLoader ${rel.tag_name} needs Terraria ${required}, this copy is ${game.version}. Update Terraria (GOG Galaxy or the newest GOG installer) and try again.`)
  }
  const zip = join(env.workDir, 'loaders', `tModLoader-${rel.tag_name}.zip`)
  await fsp.mkdir(dirname(zip), { recursive: true })
  const sha256 = sha256Of(asset)
  await env.download(asset.browser_download_url, zip, { sha256, size: asset.size, signal, onProgress: (r, t) => report(`Downloading tModLoader ${rel.tag_name}…`, t ? r / t : undefined) })
  report(sha256 ? 'Download matches the SHA-256 GitHub published' : 'Download size checked (no published checksum)')

  const dest = await tmlInstallDir(game, await terrariaDistribution(game))
  const state = host.state(game.id)
  const existing = await fileExists(join(dest, 'tModLoader.dll'))
  const ours = state.loaders.tmodloader?.via === 'github' && state.loaders.tmodloader.dir?.toLowerCase() === dest.toLowerCase()
  if (existing && !ours) throw new Error(`${dest} already has a tModLoader that NexusForge did not install. Update it the way you installed it, or remove that folder first.`)

  const tag = randomBytes(3).toString('hex')
  const fresh = `${dest}.nf-new-${tag}`
  const old = `${dest}.nf-old-${tag}`
  report('Unpacking…')
  await env.extract(zip, fresh)
  try {
    // Some releases wrap everything in a Build folder (the wiki says to bring its contents up one level).
    let root = fresh
    for (let i = 0; i < 2 && !(await fileExists(join(root, 'tModLoader.dll'))); i++) {
      const c = await fsp.readdir(root, { withFileTypes: true })
      const only = c.length === 1 && c[0].isDirectory() ? c[0].name : c.find((e) => e.isDirectory() && e.name.toLowerCase() === 'build')?.name
      if (!only) break
      root = join(root, only)
    }
    for (const need of ['tModLoader.dll', 'start-tModLoader.bat']) {
      if (!(await fileExists(join(root, need)))) throw new Error(`The tModLoader download is missing ${need}; nothing was installed.`)
    }
    if (existing) {
      // Keep what the old install had on its own: the .NET runtime it fetched, and portable saves.
      await renameDir(dest, old)
      for (const keep of ['dotnet', 'savehere.txt', 'tModLoader', 'tModLoader-preview']) {
        if ((await fileExists(join(old, keep))) && !(await fileExists(join(root, keep)))) await renameDir(join(old, keep), join(root, keep)).catch(() => {})
      }
    }
    try {
      // A virus scanner holds freshly unpacked DLLs for a moment (EPERM on the folder rename); renameDir waits, then copies.
      await renameDir(root, dest)
    } catch (err) {
      if (existing) await renameDir(old, dest).catch(() => {})
      throw err
    }
    if (existing) await fsp.rm(old, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(fresh, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(zip, { force: true }).catch(() => {})
  }
  state.loaders.tmodloader = { via: 'github', dir: dest, version: rel.tag_name.replace(/^v/i, ''), tag: rel.tag_name, prerelease: rel.prerelease, sha256, installedAt: Date.now() }
  host.saveState(game.id, state)
  report(`tModLoader ${rel.tag_name} installed in ${dest}`)
}

export const tmodloaderLoader: LoaderAdapter = {
  id: 'tmodloader',
  name: 'tModLoader',
  async status(game, info, env, state, mods): Promise<LoaderStatus> {
    const dist = await terrariaDistribution(game)
    const tml = await findTml(game, env, state)
    const required = mods.some((m) => m.needsLoader === 'tmodloader')
    const base = { id: 'tmodloader', name: 'tModLoader', required, dir: tml?.dir, version: tml?.version }
    let latest: string | undefined
    if (dist === 'gog' || dist === 'other' || tml?.via === 'github') {
      try {
        latest = (await latestRelease(env, TML_REPO)).tag_name.replace(/^v/i, '')
      } catch {
        // offline
      }
    }
    if (tml?.via === 'steam') {
      if (tml.pending) return { ...base, via: 'steam', state: 'broken', canInstall: true, canUpdate: false, canRemove: false, detail: 'Steam is still downloading or updating tModLoader.' }
      return { ...base, via: 'steam', state: 'installed', canInstall: false, canUpdate: false, canRemove: true, detail: 'Installed through Steam (Steam keeps it up to date).' }
    }
    if (tml) {
      const outdated = Boolean(latest && tml.version && tmlNewer(latest, tml.version))
      const ours = tml.via === 'github'
      return {
        ...base,
        via: ours ? 'github' : 'manual',
        latest,
        state: outdated ? 'outdated' : 'installed',
        canInstall: false,
        canUpdate: outdated && ours,
        canRemove: ours,
        detail: ours ? `Installed by NexusForge from GitHub in ${tml.dir}` : `Installed by hand in ${tml.dir} (NexusForge doesn't change it)`
      }
    }
    if (dist === 'steam') {
      return { ...base, via: 'steam', state: 'missing', canInstall: true, canUpdate: false, canRemove: false, detail: 'NexusForge installs tModLoader through Steam (free for Terraria owners).' }
    }
    // GOG and copies outside a store: what tModLoader's own start check will say decides.
    let v: TmlVerdict | undefined
    try {
      v = await tmlVerdict(game, env)
    } catch {
      v = undefined // offline: checked again when installing
    }
    void info
    if (v && !v.ok) {
      const steamCopy = await env.steam.app(TERRARIA_APP).catch(() => undefined)
      return { ...base, state: 'unsupported', canInstall: false, canUpdate: false, canRemove: false, blocked: `${v.reason}${steamCopy ? ' Terraria is also in your Steam library: NexusForge can set tModLoader up there.' : ''}` }
    }
    const where = dist === 'gog' ? 'next to this GOG Terraria' : 'inside this Terraria folder'
    const detail = v?.ok
      ? `tModLoader ${v.release!.tag_name} accepts this Terraria.exe (unmodified Terraria ${v.terrariaVersion ?? ''}); NexusForge installs its official tModLoader.zip ${where}.${v.newest ? ` The newest tModLoader (${v.newest}) is made for a newer Terraria; after updating Terraria NexusForge installs that one.` : ''}`
      : `NexusForge installs the official tModLoader.zip from GitHub ${where} (the Terraria.exe check runs when installing).`
    return { ...base, via: 'github', latest: v?.release?.tag_name.replace(/^v/i, '') ?? latest, state: 'missing', canInstall: true, canUpdate: false, canRemove: false, detail }
  },
  async install(game, _info, env, host, report, signal) {
    const dist = await terrariaDistribution(game)
    if (dist === 'steam') {
      if (!(await env.steam.root())) throw new Error('Steam is not installed.')
      report('Opening Steam to install tModLoader…')
      await env.openUrl(`steam://install/${TML_APP}`)
      const app = await waitForSteamApp(env, TML_APP, report, signal)
      report(`tModLoader installed by Steam in ${app.dir}`)
      return
    }
    report("Checking which tModLoader release accepts this Terraria.exe…")
    const v = await tmlVerdict(game, env)
    if (!v.ok) throw new Error(v.reason)
    return installFromGithub(game, env, host, report, signal, v.release)
  },
  async remove(game, _info, env, host) {
    const state = host.state(game.id)
    const tml = await findTml(game, env, state)
    if (!tml) return
    if (tml.via === 'steam') {
      await env.openUrl(`steam://uninstall/${TML_APP}`)
      return
    }
    if (tml.via !== 'github') throw new Error('This tModLoader was installed by hand; NexusForge leaves it alone.')
    if (tml.portable) throw new Error(`This tModLoader keeps your modded saves inside its folder (savehere.txt). Move ${tmlSaves(env, tml)} somewhere safe first.`)
    await fsp.rm(tml.dir, { recursive: true, force: true })
    delete state.loaders.tmodloader
    host.saveState(game.id, state)
  }
}

// ---------------------------------------------------------------------------
// Packages

const lower = (s: string) => s.toLowerCase()
const stem = (f: string) => basename(f).replace(/\.[^.]+$/, '')

/** Picks, per mod name, the .tmod built for the installed tModLoader (Workshop items keep one per version folder). */
export function pickTmods(files: string[], infos: Map<string, TmodInfo>, installed?: string): string[] {
  const byName = new Map<string, string[]>()
  for (const f of files) {
    const name = infos.get(f)?.name ?? stem(f)
    byName.set(name, [...(byName.get(name) ?? []), f])
  }
  const out: string[] = []
  for (const list of byName.values()) {
    const sorted = [...list].sort((a, b) => {
      const va = infos.get(a)?.builtFor ?? '0'
      const vb = infos.get(b)?.builtFor ?? '0'
      return tmlNewer(va, vb) ? -1 : tmlNewer(vb, va) ? 1 : 0
    })
    const fits = installed
      ? sorted.filter((f) => {
          const v = infos.get(f)?.builtFor ?? '0'
          return tmlFamily(v) === tmlFamily(installed) && !tmlNewer(v, installed)
        })
      : sorted
    out.push((fits[0] ?? sorted[0])!)
  }
  return out
}

export async function classifyTerraria(pkg: StagedPackage, tmlVersionInstalled: string | undefined, tmlAvailable: boolean): Promise<Classification> {
  const routes: ModRoute[] = []
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const meta: Record<string, string> = {}
  const files = pkg.files.map((f) => f.rel)
  const taken = new Set<string>()
  const take = (f: string) => taken.add(lower(f))

  // tModLoader mods
  const tmodFiles = files.filter((f) => /\.tmod$/i.test(f))
  const infos = new Map<string, TmodInfo>()
  for (const f of tmodFiles) {
    try {
      infos.set(f, await readTmod(join(pkg.dir, f)))
    } catch (err) {
      checks.push({ level: 'error', code: 'tmod_damaged', message: `${basename(f)} is not a readable tModLoader mod: ${(err as Error).message}. Download it again.` })
    }
    take(f)
  }
  const chosen = pickTmods(tmodFiles.filter((f) => infos.has(f)), infos, tmlVersionInstalled)
  const names: string[] = []
  for (const f of chosen) {
    const info = infos.get(f)!
    const name = info.name ?? stem(f)
    names.push(name)
    routes.push(route(f, 'tml-mods', `${name}.tmod`))
    if (!info.hashOk) checks.push({ level: 'error', code: 'tmod_damaged', message: `${name}.tmod is damaged (its checksum does not match). Download it again.` })
    if (tmlVersionInstalled) {
      if (tmlFamily(info.builtFor) !== tmlFamily(tmlVersionInstalled)) {
        checks.push({
          level: 'error',
          code: 'tml_family',
          message: `${name} was built for tModLoader ${info.builtFor} (Terraria ${tmlFamily(info.builtFor)}); the installed tModLoader ${tmlVersionInstalled} is for Terraria ${tmlFamily(tmlVersionInstalled)}. Get the mod's version for Terraria ${tmlFamily(tmlVersionInstalled)}.`
        })
      } else if (tmlNewer(info.builtFor, tmlVersionInstalled)) {
        checks.push({ level: 'warning', code: 'tml_newer', message: `${name} was built with a newer tModLoader (${info.builtFor}) than the installed one (${tmlVersionInstalled}). Update tModLoader if it doesn't load.` })
      }
    }
  }
  for (const f of tmodFiles) if (!chosen.includes(f) && infos.has(f)) skipped.push({ path: f, reason: `older build (${infos.get(f)!.builtFor}); the one for your tModLoader is used` })
  if (names.length) {
    meta.tmodNames = names.join(',')
    const first = infos.get(chosen[0])!
    meta.tmlBuiltFor = first.builtFor
    if (first.version) meta.tmodVersion = first.version
    // Mods these need (modReferences), apart from the ones in the same package.
    const needs = new Set<string>()
    for (const f of chosen) for (const r of infos.get(f)!.refs ?? []) if (!names.includes(r.name)) needs.add(r.name)
    if (needs.size) {
      meta.tmodNeeds = [...needs].join(',')
      checks.push({ level: 'info', code: 'tmod_refs', message: `Needs ${[...needs].join(', ')} in tModLoader too. NexusForge switches ${needs.size === 1 ? 'it' : 'them'} on when ${needs.size === 1 ? 'it is' : 'they are'} installed (through NexusForge, the Workshop or tModLoader's Mods folder).` })
    }
  }

  // Worlds and characters (.twld/.tplr are tModLoader's extra data, which makes them modded saves)
  const hasTwin = (f: string, ext: string) => files.some((x) => lower(x) === lower(f.replace(/\.[^.]+$/, ext)))
  for (const f of files.filter((x) => /\.wld$/i.test(x))) {
    const modded = hasTwin(f, '.twld')
    routes.push(route(f, modded ? 'tml-worlds' : 'worlds', basename(f)))
    take(f)
    if (modded) {
      const twin = files.find((x) => lower(x) === lower(f.replace(/\.wld$/i, '.twld')))!
      routes.push(route(twin, 'tml-worlds', basename(twin)))
      take(twin)
    }
  }
  for (const f of files.filter((x) => /\.plr$/i.test(x))) {
    const modded = hasTwin(f, '.tplr')
    const target = modded ? 'tml-players' : 'players'
    routes.push(route(f, target, basename(f)))
    take(f)
    if (modded) {
      const twin = files.find((x) => lower(x) === lower(f.replace(/\.plr$/i, '.tplr')))!
      routes.push(route(twin, target, basename(twin)))
      take(twin)
    }
    // The character's map folder has the character's file name.
    const mapDir = f.replace(/\.plr$/i, '')
    if (files.some((x) => lower(x).startsWith(`${lower(mapDir)}/`))) {
      routes.push(route(mapDir, target, basename(mapDir)))
      for (const x of files) if (lower(x).startsWith(`${lower(mapDir)}/`)) take(x)
    }
  }
  for (const f of files) if (/\.(wld|plr|twld|tplr)\.bak\d*$/i.test(f) || /\.bak\d*$/i.test(f)) {
    if (!taken.has(lower(f))) {
      skipped.push({ path: f, reason: 'backup copy the game made' })
      take(f)
    }
  }

  // Resource packs: a folder with pack.json (or the package itself)
  const packs = files.filter((f) => /(^|\/)pack\.json$/i.test(f)).map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))
  for (const p of packs) {
    const name = folderName(p ? basename(p) : pkg.name)
    routes.push(route(p, 'resourcepacks', name))
    for (const f of files) if (!p || lower(f).startsWith(`${lower(p)}/`)) take(f)
  }

  // The rest: read-me files are left out; loose game files only when they replace Terraria's Content.
  const rest = files.filter((f) => !taken.has(lower(f)))
  const contentDir = children(pkg.files.filter((f) => rest.includes(f.rel)), '').dirs.find((d) => lower(d) === 'content')
  for (const f of rest) {
    if (contentDir && lower(f).startsWith('content/')) continue
    skipped.push({ path: f, reason: isDocFile(basename(f)) ? 'read-me file, not part of the mod' : 'not something Terraria or tModLoader loads (no .tmod, world, character or resource pack)' })
  }
  if (contentDir) {
    routes.push(route(contentDir, 'game', 'Content'))
    checks.push({ level: 'warning', code: 'replaces_content', message: "This mod replaces Terraria's own Content files (the old way of texture packs). NexusForge backs the originals up and restores them on purge; a resource pack does the same without touching the game." })
  }

  const usesTml = routes.some((r) => r.target.startsWith('tml-'))
  if (usesTml && !tmlAvailable) {
    checks.push({ level: 'info', code: 'needs_tml', message: 'Needs tModLoader. It is not set up for this Terraria yet; see the setup panel.' })
  }
  if (!routes.length && !checks.some((c) => c.level === 'error')) {
    checks.push({ level: 'error', code: 'empty', message: 'Nothing in this package is Terraria content (.tmod mod, world, character or resource pack).' })
  }
  const kind = names.length ? 'tmod' : routes.some((r) => /worlds$/.test(r.target)) ? 'world' : routes.some((r) => /players$/.test(r.target)) ? 'player' : packs.length ? 'resourcepack' : 'files'
  const first = chosen[0] ? infos.get(chosen[0]) : undefined
  return {
    kind,
    routes,
    skipped,
    checks,
    needsLoader: usesTml ? 'tmodloader' : undefined,
    meta: Object.keys(meta).length ? meta : undefined,
    name: chosen.length === 1 && first?.displayName ? plainChat(first.displayName) : undefined,
    version: first?.version,
    rootPath: ''
  }
}

/** Display names may carry Terraria chat tags ("[c/FF0000:Calamity] Mod"); keep the text. */
export function plainChat(s: string): string {
  return s.replace(/\[(?:c|color)\/[0-9a-f]{6}:([^\]]*)\]/gi, '$1').replace(/\[i(?:\/[^\]:]*)?:[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim()
}

/** .tmod names tModLoader can load besides NexusForge's: its Mods folder and the Workshop items Steam keeps. */
export async function availableTmods(modsDir: string, workshopDir?: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (const f of await fsp.readdir(modsDir).catch(() => [] as string[])) if (/\.tmod$/i.test(f)) out.add(stem(f))
  if (workshopDir) {
    // steamapps/workshop/content/1281930/<item>/<tModLoader version>/<Name>.tmod
    for (const item of await fsp.readdir(workshopDir).catch(() => [] as string[])) {
      const dir = join(workshopDir, item)
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.isFile() && /\.tmod$/i.test(e.name)) out.add(stem(e.name))
        else if (e.isDirectory()) for (const f of await fsp.readdir(join(dir, e.name)).catch(() => [] as string[])) if (/\.tmod$/i.test(f)) out.add(stem(f))
      }
    }
  }
  return out
}

/** Mod names the deployed tModLoader mods need (from their .tmod Info). */
function neededTmods(manifest: DeployManifest, mods: InstalledMod[]): string[] {
  const live = new Set(manifest.entries.filter((e) => e.target === 'tml-mods').map((e) => e.modId))
  const out = new Set<string>()
  for (const m of mods) if (live.has(m.id)) for (const n of (m.meta?.tmodNeeds ?? '').split(',')) if (n) out.add(n)
  return [...out]
}

async function workshopDirFor(env: IntegrationEnv, tml: TmlInstall | undefined): Promise<string | undefined> {
  void env
  if (tml?.via !== 'steam' || !tml.steam) return undefined
  const dir = join(tml.steam.library, 'workshop', 'content', TML_APP)
  return (await dirExists(dir)) ? dir : undefined
}

// ---------------------------------------------------------------------------
// enabled.json

export async function readEnabled(file: string): Promise<string[] | undefined> {
  const list = await readJson<unknown>(file)
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : undefined
}

/**
 * Makes enabled.json list exactly the tModLoader mods NexusForge deployed, next to whatever the user switched on
 * in tModLoader. Names NexusForge added before but no longer deploys are taken out again.
 */
export async function syncEnabled(modsDir: string, deployed: string[], state: IntegrationState, backupDir?: string): Promise<boolean> {
  const file = join(modsDir, 'enabled.json')
  const current = await readEnabled(file)
  const managedBefore = new Set(state.tmlManaged ?? [])
  const want = new Set(deployed)
  const next = new Set((current ?? []).filter((n) => !managedBefore.has(n) || want.has(n)))
  for (const n of want) next.add(n)
  const changed = !current || next.size !== current.length || [...next].some((n) => !current.includes(n))
  if (changed && (current || want.size)) {
    if (current && backupDir && !state.tmlEnabledBackup) {
      await fsp.mkdir(backupDir, { recursive: true })
      const b = join(backupDir, 'enabled.json.before-nexusforge')
      await fsp.copyFile(file, b).catch(() => {})
      state.tmlEnabledBackup = b
    }
    await fsp.mkdir(modsDir, { recursive: true })
    await writeJsonAtomic(file, [...next])
  }
  state.tmlManaged = [...want]
  return changed
}

// ---------------------------------------------------------------------------
// The integration

async function targetsFor(game: Game, env: IntegrationEnv, tml: TmlInstall | undefined): Promise<DeployTarget[]> {
  const v = vanillaSaves(env)
  const t: DeployTarget[] = [
    { id: 'game', label: 'Terraria folder', dir: game.installDir },
    { id: 'worlds', label: 'Worlds', dir: join(v, 'Worlds'), userData: true, create: true },
    { id: 'players', label: 'Characters', dir: join(v, 'Players'), userData: true, create: true },
    { id: 'resourcepacks', label: 'Resource packs', dir: join(v, 'ResourcePacks'), create: true }
  ]
  if (tml) {
    const s = tmlSaves(env, tml)
    t.push(
      { id: 'tml-mods', label: 'tModLoader mods', dir: join(s, 'Mods'), create: true },
      { id: 'tml-worlds', label: 'tModLoader worlds', dir: join(s, 'Worlds'), userData: true, create: true },
      { id: 'tml-players', label: 'tModLoader characters', dir: join(s, 'Players'), userData: true, create: true }
    )
  }
  return t
}

function isTerraria(game: Game): boolean {
  if (game.platform === 'steam') return game.platformId === TERRARIA_APP
  return /^terraria\b/i.test(game.storeName ?? game.name) || /^terraria\.exe$/i.test(basename(game.exePath ?? ''))
}

export const terrariaIntegration: GameIntegration = {
  id: 'terraria',
  revision: 2,
  loadVerifiable: true,
  loaders: [tmodloaderLoader],
  async matches(game) {
    return isTerraria(game)
  },
  async inspect(game, env, state, mods): Promise<IntegrationInfo> {
    const dist = await terrariaDistribution(game)
    const tml = await findTml(game, env, state)
    const problems: string[] = []
    const exe = game.exePath ?? join(game.installDir, 'Terraria.exe')
    if (game.missing || !(await dirExists(game.installDir))) problems.push('The install folder is missing.')
    else if (!(await fileExists(exe))) problems.push(`Terraria.exe was not found in ${game.installDir}.`)
    else if (!(await dirExists(join(game.installDir, 'Content')))) problems.push('The Content folder is missing; this does not look like a complete Terraria installation.')
    const distribution =
      dist === 'steam'
        ? { kind: 'steam' as const, label: 'Steam', detail: 'Steam app 105600' }
        : dist === 'gog'
          ? { kind: 'gog' as const, label: 'GOG', detail: 'GOG game 1207665503' }
          : { kind: 'standalone' as const, label: 'Not from Steam or GOG', detail: (await fileExists(join(game.installDir, 'steam_api.dll'))) ? "Has Steam's files but is not in a Steam library" : 'Not registered with a store on this PC' }
    const info: IntegrationInfo = {
      gameId: game.id,
      integrationId: 'terraria',
      name: 'Terraria · tModLoader',
      support: dist === 'other' ? 'partial' : 'full',
      distribution,
      version: game.version || (await env.fileVersion(exe)) || undefined,
      valid: !problems.length,
      problems,
      targets: await targetsFor(game, env, tml),
      loaders: [],
      launchOptions: [],
      capabilities: [
        'Worlds (.wld) go to My Games\\Terraria\\Worlds, characters to Players and resource packs to ResourcePacks, where Terraria loads them. Worlds you have played are never deleted.',
        dist === 'steam'
          ? 'Installs tModLoader through Steam (Steam app 1281930) when a .tmod mod needs it.'
          : dist === 'gog'
            ? 'Installs tModLoader from its official GitHub release (tModLoader.zip, SHA-256 checked) next to this GOG Terraria, after checking that this Terraria version is the one tModLoader expects.'
            : 'Installs tModLoader from its official GitHub release (tModLoader.zip, SHA-256 checked) inside this Terraria folder, picking the release whose own start check accepts this Terraria.exe.',
        '.tmod files are checked (header and checksum, the tModLoader version they were built for), go into tModLoader\'s Mods folder, and are switched on in its enabled.json.',
        'Separate "Play" (vanilla) and "Play modded" (tModLoader), and a "Terraria Modded" shortcut; your own Terraria shortcuts stay as they are.'
      ],
      warnings: [],
      limitations: [],
      inspectedAt: Date.now()
    }
    info.loaders = [await tmodloaderLoader.status(game, info, env, state, mods)]
    const l = info.loaders[0]
    if (l.blocked) info.limitations.push(l.blocked)
    if (dist === 'gog') info.limitations.push('tModLoader checks a GOG Terraria.exe against the exact Terraria version its release is made for; keep Terraria updated in GOG Galaxy.')
    const tmlReady = Boolean(tml && !tml.pending)
    info.launchOptions = [
      { id: 'vanilla', label: 'Play', description: 'Terraria without mods', available: true, primary: !tmlReady },
      {
        id: 'modded',
        label: 'Play modded',
        description: tml ? `tModLoader${tml.version ? ` ${tml.version}` : ''}` : 'tModLoader',
        available: tmlReady,
        primary: tmlReady,
        reason: tmlReady ? undefined : l.blocked ? 'tModLoader can not run with this Terraria copy.' : 'tModLoader is not installed yet.'
      }
    ]
    if (tml?.portable) info.warnings.push(`tModLoader keeps its saves in its own folder (savehere.txt): ${tmlSaves(env, tml)}`)
    info.shortcutVariants = tmlReady ? ['modded'] : []
    return info
  },
  async classify(pkg, game, info, env) {
    void game
    void env
    const l = info.loaders.find((x) => x.id === 'tmodloader')
    return classifyTerraria(pkg, l?.version, Boolean(l && (l.state === 'installed' || l.state === 'outdated' || l.canInstall)))
  },
  async configure(game, info, manifest: DeployManifest, mods: InstalledMod[], env, host) {
    const modsTarget = info.targets.find((t) => t.id === 'tml-mods')
    if (!modsTarget) return
    const deployed = manifest.entries.filter((e) => e.target === 'tml-mods' && /\.tmod$/i.test(e.rel) && !e.rel.includes('/')).map((e) => stem(e.rel))
    const state = host.state(game.id)
    if (!deployed.length && !(state.tmlManaged ?? []).length) return
    // What the deployed mods need is switched on too when tModLoader has it (own Mods folder, Workshop).
    const needs = neededTmods(manifest, mods).filter((n) => !deployed.includes(n))
    if (needs.length) {
      const avail = await availableTmods(modsTarget.dir, await workshopDirFor(env, await findTml(game, env, state)))
      for (const n of needs) if (avail.has(n)) deployed.push(n)
    }
    await syncEnabled(modsTarget.dir, deployed, state, join(env.workDir, 'backups', 'tmodloader'))
    host.saveState(game.id, state)
  },
  async verify(game, info, manifest, mods, env): Promise<VerifyCheck[]> {
    const checks: VerifyCheck[] = []
    const tmods = manifest.entries.filter((e) => e.target === 'tml-mods' && /\.tmod$/i.test(e.rel))
    if (tmods.length) {
      const deployedNames = new Set(tmods.map((e) => stem(e.rel)))
      const needs = neededTmods(manifest, mods).filter((n) => !deployedNames.has(n))
      if (needs.length) {
        const avail = await availableTmods(manifest.targets['tml-mods'], await workshopDirFor(env, await findTml(game, env, { loaders: {} }).catch(() => undefined)))
        for (const n of needs) {
          const who = mods.filter((m) => (m.meta?.tmodNeeds ?? '').split(',').includes(n)).map((m) => m.name)
          checks.push({
            label: `${who.join(', ')} ${who.length === 1 ? 'needs' : 'need'} ${n}`,
            ok: avail.has(n),
            level: 'warning',
            detail: avail.has(n) ? 'found in tModLoader, switched on' : `${n} is not installed; tModLoader won't load ${who.length === 1 ? 'it' : 'them'} without it. Install ${n} too (Browse › Steam Workshop or Nexus).`
          })
        }
      }
      const l = info.loaders.find((x) => x.id === 'tmodloader')
      const ready = l && (l.state === 'installed' || l.state === 'outdated')
      checks.push({ label: 'tModLoader is installed', ok: Boolean(ready), level: 'error', detail: ready ? `${l!.version ?? ''} ${l!.dir ?? ''}`.trim() : (l?.blocked ?? l?.detail) })
      const modsDir = manifest.targets['tml-mods']
      const enabled = new Set((await readEnabled(join(modsDir, 'enabled.json'))) ?? [])
      for (const e of tmods) {
        const name = stem(e.rel)
        let ok = true
        let detail: string | undefined
        try {
          const t = await readTmod(join(modsDir, e.rel))
          if (!t.hashOk) {
            ok = false
            detail = 'checksum does not match'
          } else if (t.name && t.name !== name) {
            ok = false
            detail = `the file says it is "${t.name}"`
          }
        } catch (err) {
          ok = false
          detail = (err as Error).message
        }
        checks.push({ label: `${name}.tmod is intact`, ok, level: 'error', detail })
        checks.push({ label: `${name} is switched on in enabled.json`, ok: enabled.has(name), level: 'error' })
      }
      const tml = await findTml(game, env, { loaders: {} }).catch(() => undefined)
      if (tml && tml.via !== 'steam') checks.push({ label: 'start-tModLoader.bat is there', ok: await fileExists(join(tml.dir, 'start-tModLoader.bat')), level: 'warning' })
    }
    const worlds = manifest.entries.filter((e) => /worlds$/.test(e.target))
    if (worlds.length) checks.push({ label: `${worlds.filter((w) => /\.wld$/i.test(w.rel)).length} world(s) in ${worlds.some((w) => w.target === 'tml-worlds') ? "tModLoader's and " : ''}Terraria's Worlds folder`, ok: true, level: 'info' })
    return checks
  },
  async launch(game, info, variant, env) {
    if (variant !== 'modded') return undefined
    const tml = await findTml(game, env, { loaders: {} })
    if (!tml || tml.pending) throw new Error(info.launchOptions.find((o) => o.id === 'modded')?.reason ?? 'tModLoader is not installed.')
    if (tml.via === 'steam') return { spec: { kind: 'url', url: `steam://rungameid/${TML_APP}` }, followDir: tml.dir }
    const bat = join(tml.dir, 'start-tModLoader.bat')
    if (!(await fileExists(bat))) throw new Error(`start-tModLoader.bat is missing in ${tml.dir}. Reinstall tModLoader from the setup panel.`)
    return { spec: { kind: 'exe', exe: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', 'start-tModLoader.bat'], cwd: tml.dir }, followDir: tml.dir }
  },
  async checkLaunch(game, _info, since, env): Promise<LaunchCheck> {
    const tml = await findTml(game, env, { loaders: {} })
    if (!tml) return { ran: false, loaded: [], errors: [] }
    const file = join(tml.dir, 'tModLoader-Logs', 'client.log')
    try {
      const st = await fsp.stat(file)
      if (st.mtimeMs < since - 5000) return { ran: false, loaded: [], errors: [], logFile: file, at: st.mtimeMs }
      const text = await fsp.readFile(file, 'utf8')
      const errors = text
        .split(/\r?\n/)
        .filter((l) => /\/(ERROR|FATAL)\]/.test(l))
        .slice(0, 20)
      const platform = text.match(/Distribution Platform: (\w+)/)?.[1]
      return { ran: true, loader: `tModLoader${tml.version ? ` ${tml.version}` : ''}${platform ? ` (${platform})` : ''}`, loaded: [], errors, logFile: file, at: st.mtimeMs }
    } catch {
      return { ran: false, loaded: [], errors: [], logFile: file }
    }
  },
  async shortcut(game, _info, variant, env) {
    if (variant !== 'modded') return undefined
    const tml = await findTml(game, env, { loaders: {} })
    if (!tml || tml.pending) return undefined
    const icon = game.exePath && (await fileExists(game.exePath)) ? game.exePath : undefined
    if (tml.via === 'steam') {
      const root = await env.steam.root()
      if (!root) return undefined
      return { name: 'Terraria Modded', target: join(root, 'steam.exe'), args: `-applaunch ${TML_APP}`, icon, description: 'tModLoader through Steam (made by NexusForge)' }
    }
    return { name: 'Terraria Modded', target: join(tml.dir, 'start-tModLoader.bat'), cwd: tml.dir, icon, description: 'tModLoader (made by NexusForge)' }
  }
}
