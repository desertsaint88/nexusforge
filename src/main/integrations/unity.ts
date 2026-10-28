// Any Unity game: BepInEx (5 for Mono builds, 6 for IL2CPP) and MelonLoader, installed from their official GitHub
// releases straight from the game's setup panel, whether the copy came from a store or is a folder on a drive.
//
// Which loader a mod needs is read from the mod itself: plugin DLLs reference the loader's assembly
// (BepInEx.dll / MelonLoader.dll), so a mod is routed to BepInEx/plugins or Mods/ by what it was built for.
// Packages that are neither (asset replacements, configs) go into the game folder as they are laid out.
// Games with their own mods folder (People Playground, RimWorld, Stardew Valley) keep the generic handling.

import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import type { InstalledMod, IntegrationInfo, LaunchCheck, ModCheck, ModRoute, SkippedFile, VerifyCheck } from '@shared/types'
import type { Classification, GameIntegration, IntegrationState, StagedPackage } from './types'
import { bepinexFiles, bepinexIntegration, classifyBepInEx, findLoaderRoots, gameDir, readBepInExLog } from './bepinex'
import { antiCheatIn, antiCheatWarning, children, fileExists, isDocFile, route, unwrap } from './common'
import { genericClassify } from './generic'
import { fileStrings } from './proxy'
import { classifyLoaderPackage, isLoaderPackage, verifyLoader, zipLoader, type ZipLoaderSpec } from './zip-loader'
import { gameRuntime } from '../sources/frameworks'
import { findPreset } from '../library/presets'

const MELON_NAMES = ['version.dll', 'winhttp.dll', 'winmm.dll', 'dinput8.dll', 'dinput.dll', 'dsound.dll', 'msacm32.dll']

export const melonSpec: ZipLoaderSpec = {
  id: 'melonloader',
  name: 'MelonLoader',
  summary: 'Mod loader for Unity games (Mono and IL2CPP): loads the DLLs in Mods/ and Plugins/ when the game starts.',
  repo: 'LavaGang/MelonLoader',
  target: 'game',
  targetDir: (game) => gameDir(game),
  markers: ['MelonLoader/net35/MelonLoader.dll', 'MelonLoader/net6/MelonLoader.dll'],
  packageMarkers: ['version.dll', 'MelonLoader/net35/MelonLoader.dll', 'MelonLoader/net6/MelonLoader.dll'],
  notInPackage: /(^|\/)(mods|plugins)\/[^/]+\.dll$/i,
  proxy: { file: 'version.dll', names: MELON_NAMES, owner: 'melonloader' },
  async unsupported(game) {
    return (await gameRuntime(game)).unity ? undefined : `${game.name} doesn't look like a Unity game, so MelonLoader can't run in it.`
  },
  async warning(game) {
    return antiCheatWarning(await antiCheatIn([gameDir(game), game.installDir]), 'MelonLoader')
  }
}
export const melonLoader = zipLoader(melonSpec)

const MELON_DIRS = new Set(['mods', 'plugins', 'userlibs', 'userdata'])

/** What a mod's DLLs were built for: they reference the loader's assembly by name. */
export async function modFlavor(pkg: StagedPackage): Promise<'bepinex' | 'melonloader' | undefined> {
  let bep = 0
  let melon = 0
  for (const f of pkg.files.filter((x) => /\.dll$/i.test(x.rel)).slice(0, 40)) {
    const name = basename(f.rel).toLowerCase()
    if (/^(0harmony|mono\.cecil|monomod|bepinex|melonloader|unityengine|system\.)/.test(name)) continue
    let text = ''
    try {
      text = await fileStrings(join(pkg.dir, f.rel), 4 * 1024 * 1024)
    } catch {
      continue
    }
    if (/\bMelonLoader\b|MelonInfoAttribute|MelonMod\b|MelonPlugin\b/.test(text)) melon++
    if (/\bBepInEx\b|BepInPlugin|BaseUnityPlugin/.test(text)) bep++
  }
  if (melon > bep) return 'melonloader'
  if (bep > melon) return 'bepinex'
  return undefined
}

/** MelonLoader's layout: Mods/, Plugins/, UserLibs/, UserData/ next to the .exe; a bare DLL goes into Mods/. */
export function classifyMelon(pkg: StagedPackage, modName: string): Classification {
  const skipped: SkippedFile[] = []
  const checks: ModCheck[] = []
  const routes: ModRoute[] = []
  const loaderRoots = findLoaderRoots(pkg.files)
  const melonCopies = pkg.files.filter((f) => /(^|\/)melonloader\/(net6|net35)\/melonloader\.dll$/i.test(f.rel)).map((f) => f.rel.replace(/\/?melonloader\/(net6|net35)\/melonloader\.dll$/i, ''))
  const bundled = [...new Set([...melonCopies.map((r) => (r ? `${r}/MelonLoader` : 'MelonLoader')), ...loaderRoots.map((r) => (r ? `${r}/BepInEx` : 'BepInEx'))])]
  for (const b of bundled) skipped.push({ path: b, reason: 'a copy of a mod loader bundled with the mod; NexusForge installs and updates the loader itself' })
  const content = pkg.files.filter((f) => !bundled.some((b) => f.rel.toLowerCase().startsWith(`${b.toLowerCase()}/`)) && !/(^|\/)version\.dll$/i.test(f.rel))
  for (const f of pkg.files) if (/(^|\/)version\.dll$/i.test(f.rel) && !bundled.some((b) => f.rel.toLowerCase().startsWith(`${b.toLowerCase()}/`))) skipped.push({ path: f.rel, reason: "MelonLoader's own proxy; NexusForge installs MelonLoader itself" })
  const root = unwrap(content, MELON_DIRS)
  const top = children(content, root)
  const j = (a: string, b: string) => (a ? `${a}/${b}` : b)
  if (top.dirs.some((d) => MELON_DIRS.has(d.toLowerCase()))) {
    for (const d of top.dirs) {
      const known = [...MELON_DIRS].find((x) => x === d.toLowerCase())
      routes.push(route(j(root, d), 'game', known ? d.replace(/^./, (c) => c.toUpperCase()) : `Mods/${d}`))
    }
    for (const f of top.files) {
      if (isDocFile(f)) skipped.push({ path: j(root, f), reason: 'read-me file, not part of the mod' })
      else routes.push(route(j(root, f), 'game', `Mods/${f}`))
    }
  } else {
    for (const d of top.dirs) routes.push(route(j(root, d), 'game', `Mods/${d}`))
    for (const f of top.files) {
      if (isDocFile(f)) skipped.push({ path: j(root, f), reason: 'read-me file, not part of the mod' })
      else routes.push(route(j(root, f), 'game', `Mods/${f}`))
    }
  }
  if (!routes.length) checks.push({ level: 'error', code: 'empty', message: 'The package has nothing to install besides read-me files and a mod loader.' })
  else if (!content.some((f) => /\.dll$/i.test(f.rel))) checks.push({ level: 'warning', code: 'no_plugin', message: 'No DLL in this package; its files went into Mods/. If the mod page says they belong elsewhere, change the content folder in the mod settings.' })
  void modName
  return { kind: 'plugin', needsLoader: 'melonloader', routes, skipped, checks, rootPath: root }
}

/** Reads MelonLoader/Latest.log from the last start. */
export async function readMelonLog(dir: string, since: number): Promise<LaunchCheck> {
  const file = join(dir, 'MelonLoader', 'Latest.log')
  try {
    const st = await fsp.stat(file)
    if (st.mtimeMs < since - 5000) return { ran: false, loaded: [], errors: [], logFile: file, at: st.mtimeMs }
    const text = await fsp.readFile(file, 'utf8')
    const lines = text.split(/\r?\n/)
    const version = text.match(/MelonLoader v(\d+\.\d+\.\d+)/)?.[1]
    // "[12:00:00.000] Mod Name v1.0.0 by Author" follows the "Melon Assembly loaded" / mods headers.
    const loaded = lines.map((l) => l.match(/^\[[\d:.]+\]\s+(.+?) v[\w.\-]+(?: by .+)?$/)?.[1]).filter((x): x is string => Boolean(x) && !/^MelonLoader$/i.test(x!))
    const errors = lines.filter((l) => /\[ERROR\]|\bERROR\b.*:/.test(l)).slice(0, 20)
    return { ran: true, loader: version ? `MelonLoader ${version}` : 'MelonLoader', loaded, errors, logFile: file, at: st.mtimeMs }
  } catch {
    return { ran: false, loaded: [], errors: [], logFile: file }
  }
}

async function melonPresent(dir: string): Promise<boolean> {
  return (await fileExists(join(dir, 'MelonLoader', 'net35', 'MelonLoader.dll'))) || (await fileExists(join(dir, 'MelonLoader', 'net6', 'MelonLoader.dll')))
}

const bep = bepinexIntegration({ id: 'unity', name: 'Unity game', steam: [], names: [], support: 'partial', major: 'auto', flexibleMajor: true }, { anyUnityWithBepInEx: true })

/** Unity games: every one whose mods go next to the .exe (not games with their own mods folder). */
export const unityIntegration: GameIntegration = {
  id: 'unity',
  revision: 1,
  loadVerifiable: true,
  loaders: [...bep.loaders, melonLoader],
  async matches(game) {
    if (!(await gameRuntime(game)).unity) return false
    const preset = findPreset(game)
    return !preset?.target && !preset?.keepArchive
  },
  async inspect(game, env, state: IntegrationState, mods: InstalledMod[]): Promise<IntegrationInfo> {
    const info = await bep.inspect(game, env, state, mods)
    const rt = await gameRuntime(game)
    const ac = await antiCheatIn([gameDir(game), game.installDir])
    info.integrationId = 'unity'
    info.name = `${game.name} · Unity ${rt.unity === 'il2cpp' ? 'IL2CPP' : 'Mono'}`
    info.loaders.push(await melonLoader.status(game, info, env, state, mods))
    const [b, m] = [info.loaders.find((l) => l.id === 'bepinex'), info.loaders.find((l) => l.id === 'melonloader')]
    const bIn = b && (b.state === 'installed' || b.state === 'outdated')
    const mIn = m && (m.state === 'installed' || m.state === 'outdated')
    if (bIn && mIn) info.warnings.push('BepInEx and MelonLoader are both in the game folder. Most games only work with one of them; remove the one your mods don\'t need.')
    if (ac) info.warnings.push(antiCheatWarning(ac, 'A mod loader')!)
    info.capabilities = [
      `Installs BepInEx ${rt.unity === 'il2cpp' ? '6 (IL2CPP build)' : '5 (Mono build)'} or MelonLoader (official GitHub releases, ${rt.arch}) with one click, or by itself when a mod needs it. Works for store copies and for game folders on any drive.`,
      'Reads which loader a mod was built for from its DLL and puts it into BepInEx/plugins/<mod>/ or Mods/; copies of a loader bundled with a mod stay out.',
      'Never replaces a winhttp.dll / version.dll / winmm.dll that came with the game: the loader goes in under another name it supports.',
      'Checks after deploying that the loader and every plugin are in place, and reads the loader\'s log after you play.'
    ]
    info.limitations = ['NexusForge has no game-specific rules for this game: it follows the loaders\' standard layouts. Unity games have no official mod support, so mods can break when the game updates.']
    info.support = 'partial'
    const anyLoader = bIn || mIn
    info.launchOptions = [
      { id: 'modded', label: 'Play', description: anyLoader ? `With ${[bIn ? 'BepInEx' : '', mIn ? 'MelonLoader' : ''].filter(Boolean).join(' and ')} and your mods` : 'No mod loader in the game yet', available: true, primary: true },
      {
        id: 'vanilla',
        label: 'Play without mods',
        description: 'Starts the game with the mod loader switched off for this one start; nothing is removed.',
        available: Boolean(anyLoader),
        reason: anyLoader ? undefined : 'No mod loader is installed, so the game always starts without mods.'
      }
    ]
    return info
  },
  async classify(pkg, game, info, env): Promise<Classification> {
    const proxyOf = (id: string) => info.loaders.find((l) => l.id === id)?.proxy
    if (isLoaderPackage(melonSpec, pkg)) return classifyLoaderPackage(melonSpec, pkg, proxyOf('melonloader') ?? 'version.dll')
    const flavor = await modFlavor(pkg)
    const melonIn = ['installed', 'outdated'].includes(info.loaders.find((l) => l.id === 'melonloader')?.state ?? '') || (await melonPresent(gameDir(game)))
    const bepIn = Boolean((await bepinexFiles(gameDir(game))).core)
    const hasBepLayout = pkg.files.some((f) => /(^|\/)(bepinex|plugins|patchers)\//i.test(f.rel)) || pkg.source?.sourceId === 'thunderstore' || pkg.files.some((f) => /^manifest\.json$/i.test(f.rel))
    const hasMelonLayout = pkg.files.some((f) => /(^|\/)(mods|userlibs|userdata)\//i.test(f.rel))
    const hasDll = pkg.files.some((f) => /\.dll$/i.test(f.rel))
    let use: 'bepinex' | 'melonloader' | undefined = flavor
    if (!use && hasBepLayout) use = 'bepinex'
    if (!use && hasMelonLayout) use = 'melonloader'
    if (!use && hasDll) use = melonIn && !bepIn ? 'melonloader' : bepIn && !melonIn ? 'bepinex' : undefined
    if (use === 'melonloader') return classifyMelon(pkg, pkg.name)
    if (use === 'bepinex' || findLoaderRoots(pkg.files).length) return classifyBepInEx(pkg, pkg.name, { major: 'auto', name: game.name, flexibleMajor: true }, proxyOf('bepinex'))
    if (hasDll) {
      // A DLL that says nothing about a loader: BepInEx is the most common one for Unity games.
      const c = classifyBepInEx(pkg, pkg.name, { major: 'auto', name: game.name, flexibleMajor: true }, proxyOf('bepinex'))
      c.checks.push({ level: 'info', message: 'The DLL doesn\'t say which mod loader it is for; NexusForge treats it as a BepInEx plugin. If the mod page says MelonLoader, install MelonLoader and reinstall the mod.' })
      return c
    }
    void env
    return genericClassify(pkg, game)
  },
  async verify(game, info, manifest, mods, env): Promise<VerifyCheck[]> {
    const deployed = new Set(manifest.entries.map((e) => e.modId))
    // BepInEx is only checked when something deployed is BepInEx or needs it (a MelonLoader-only game has no BepInEx).
    const bepIds = new Set(mods.filter((m) => m.loaderId === 'bepinex' || m.needsLoader === 'bepinex').map((m) => m.id))
    const bepManifest = { ...manifest, entries: manifest.entries.filter((e) => bepIds.has(e.modId)) }
    const checks = bepManifest.entries.length ? ((await bep.verify?.(game, info, bepManifest, mods.filter((m) => bepIds.has(m.id)), env)) ?? []) : []
    const melonMods = mods.filter((m) => m.needsLoader === 'melonloader' && deployed.has(m.id))
    if (melonMods.length || mods.some((m) => m.loaderId === 'melonloader' && deployed.has(m.id))) {
      checks.push(...(await verifyLoader(melonSpec, game, info, mods, melonMods.length ? 'error' : 'warning')))
      for (const m of melonMods) {
        const dlls = manifest.entries.filter((e) => e.modId === m.id && /\.dll$/i.test(e.rel))
        const placed = dlls.filter((e) => /^(mods|plugins|userlibs)\//i.test(e.rel))
        checks.push({ label: `${m.name}: DLL is where MelonLoader loads it`, ok: !dlls.length || placed.length > 0, level: dlls.length ? 'error' : 'info', detail: dlls.length ? `${placed.length} DLL(s) in Mods/Plugins/UserLibs` : 'no DLL in this mod' })
      }
    }
    return checks
  },
  async launch(game, info, variant, env) {
    if (variant !== 'vanilla') return undefined
    const dir = gameDir(game)
    const args: string[] = []
    if ((await bepinexFiles(dir)).core) args.push('--doorstop-enabled', 'false')
    if (await melonPresent(dir)) args.push('--no-mods')
    if (!args.length) return undefined
    if (game.platform === 'steam' && game.platformId) {
      const root = await env.steam.root()
      if (root) return { spec: { kind: 'exe', exe: join(root, 'steam.exe'), args: ['-applaunch', game.platformId, ...args] }, followDir: dir }
    }
    void info
    if (!game.exePath) return undefined
    return { spec: { kind: 'exe', exe: game.exePath, args, cwd: dir } }
  },
  async checkLaunch(game, _info, since) {
    const dir = gameDir(game)
    const [b, m] = await Promise.all([readBepInExLog(dir, since), readMelonLog(dir, since)])
    if (b.ran && m.ran) return { ...b, loader: `${b.loader} + ${m.loader}`, loaded: [...b.loaded, ...m.loaded], errors: [...b.errors, ...m.errors] }
    return m.ran ? m : b
  }
}

