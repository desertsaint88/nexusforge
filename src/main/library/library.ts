import { BrowserWindow, shell } from 'electron'
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import type { DetectedGame, Game, ManualGameInput, Platform, ScanProgress, ScanResult } from '@shared/types'
import { db, getSettings } from '../store'
import { emit } from '../events'
import { exists, isDir, safeReaddir, shortId } from '../util/fs'
import { scoped } from '../logger'
import { scanSteam } from './steam'
import { scanEpic } from './epic'
import { scanXbox } from './xbox'
import { scanGog } from './gog'
import { scanCustomFolders, cleanGameName } from './custom'
import { findGameRoots } from './drives'
import { emulatorGameDirs, findEmulators, scanEmulatorGames, type RomDir } from './emulators'
import { ART_REV, exeIcon, fetchStoreArt, mergeArt, norm } from './artwork'
import { findMainExecutable, findExecutables } from './exe-detect'
import { findPreset, presetTarget } from './presets'
import { mediaUrl } from '../media-protocol'
import { readExeVersion } from './exe-version'

const log = scoped('library')

export function listGames(): Game[] {
  return Object.values(db().get('games')).sort((a, b) => a.name.localeCompare(b.name))
}

export function getGame(id: string): Game | undefined {
  return db().get('games')[id]
}

// Ids can contain dots (Xbox package names), which electron-store would read as key paths,
// so games are always written back as a whole map.
function saveGame(game: Game): void {
  const games = db().get('games')
  games[game.id] = game
  db().set('games', games)
}

function broadcast(): void {
  emit('library:changed', listGames())
}

function defaultModding(d: { platform: Platform; platformId?: string; name: string; installDir: string }): Game['modding'] {
  const preset = findPreset(d)
  return {
    targetDir: preset?.target ? presetTarget(preset.target, d.installDir) : d.installDir,
    strategy: getSettings().defaultStrategy,
    sources: { ...(preset?.sources ?? {}) }
  }
}

function fromDetected(d: DetectedGame): Game {
  return {
    ...d,
    playtimeMinutes: d.playtimeMinutes ?? 0,
    addedAt: Date.now(),
    modding: defaultModding(d)
  }
}

function mergeDetected(existing: Game, d: DetectedGame): Game {
  const edited = new Set(existing.userEdited ?? [])
  const next: Game = { ...existing, missing: false, emulator: d.emulator }
  // The store's spelling of the title survives rescans as long as it's still the same name.
  if (!edited.has('name')) next.name = existing.storeName && norm(existing.storeName) === norm(d.name) ? existing.storeName : d.name
  next.installDir = d.installDir
  if (!edited.has('exePath')) next.exePath = d.exePath ?? existing.exePath
  if (!edited.has('launch')) next.launch = d.launch
  // Keep artwork we fetched before when the scanner found nothing better.
  if (!edited.has('art')) {
    const scanned: Game['art'] = {
      capsule: d.art.capsule.length ? d.art.capsule : existing.art.capsule,
      hero: d.art.hero.length ? d.art.hero : existing.art.hero,
      header: d.art.header.length ? d.art.header : existing.art.header,
      logo: d.art.logo.length ? d.art.logo : existing.art.logo,
      icon: d.art.icon ?? existing.art.icon
    }
    // Verified store pictures from the artwork lookup beat the scanner's guessed CDN paths.
    next.art = (existing.artRev ?? 0) >= ART_REV ? mergeArt(scanned, existing.art) : scanned
  }
  if (d.playtimeMinutes !== undefined) next.playtimeMinutes = Math.max(d.playtimeMinutes, existing.playtimeMinutes)
  if (d.lastPlayed) next.lastPlayed = Math.max(d.lastPlayed, existing.lastPlayed ?? 0)
  if (d.sizeBytes) next.sizeBytes = d.sizeBytes
  return next
}

let scanning: Promise<ScanResult> | undefined
let lastDriveRoots: string[] | undefined

/** Game folders found on the local drives (from the last scan, or looked up now). */
export async function driveGameRoots(): Promise<string[]> {
  lastDriveRoots ??= await findGameRoots()
  return lastDriveRoots
}

export function scanLibrary(): Promise<ScanResult> {
  scanning ??= doScan().finally(() => {
    scanning = undefined
  })
  return scanning
}

async function doScan(): Promise<ScanResult> {
  const started = Date.now()
  const settings = getSettings()
  const progress: Record<string, ScanProgress> = {}
  const report = (p: ScanProgress) => {
    progress[p.platform] = p
    emit('scan:progress', p)
  }
  const scanners: Array<[Exclude<Platform, 'manual' | 'custom'>, () => Promise<DetectedGame[]>]> = [
    ['steam', scanSteam],
    ['epic', scanEpic],
    ['xbox', scanXbox],
    ['gog', scanGog]
  ]
  const detected: DetectedGame[] = []
  const succeeded = new Set<Platform>()
  await Promise.all(
    scanners.map(async ([platform, fn]) => {
      if (!settings.scanPlatforms[platform]) return report({ platform, status: 'skipped', found: 0 })
      report({ platform, status: 'scanning', found: 0 })
      try {
        const found = await fn()
        detected.push(...found)
        succeeded.add(platform)
        report({ platform, status: 'done', found: found.length })
      } catch (err) {
        log.error(`${platform} scan failed`, err)
        report({ platform, status: 'error', found: 0, message: (err as Error).message })
      }
    })
  )

  const existing = db().get('games')
  let roots = [...settings.customFolders]
  if (settings.scanPlatforms.custom) {
    report({ platform: 'custom', status: 'scanning', found: 0 })
    try {
      if (settings.scanAllDrives) {
        lastDriveRoots = await findGameRoots()
        for (const r of lastDriveRoots) if (!roots.some((x) => x.toLowerCase() === r.toLowerCase())) roots.push(r)
      }
      const skip = new Set<string>([
        ...detected.map((g) => g.installDir.toLowerCase()),
        ...Object.values(existing).filter((g) => g.platform === 'manual').map((g) => g.installDir.toLowerCase())
      ])
      const found = await scanCustomFolders(roots, skip)
      detected.push(...found)
      // Console games: disc images in folders that hold no PC game, and in the emulators' own game lists.
      let consoleGames = 0
      const emulators = await findEmulators(roots)
      if (emulators.size) {
        const taken = new Set([...skip, ...found.map((g) => g.installDir.toLowerCase())])
        const romDirs: RomDir[] = []
        for (const r of roots) {
          for (const e of await safeReaddir(r)) {
            const dir = join(r, e.name)
            if (e.isDirectory() && !e.name.startsWith('.') && !taken.has(dir.toLowerCase())) romDirs.push({ dir })
          }
        }
        for (const listed of await emulatorGameDirs()) {
          romDirs.push(listed)
          if (!roots.some((x) => x.toLowerCase() === listed.dir.toLowerCase())) roots.push(listed.dir)
        }
        const roms = await scanEmulatorGames(romDirs, emulators)
        detected.push(...roms)
        consoleGames = roms.length
      }
      succeeded.add('custom')
      report({ platform: 'custom', status: 'done', found: found.length + consoleGames })
    } catch (err) {
      log.error('custom folder scan failed', err)
      report({ platform: 'custom', status: 'error', found: 0, message: (err as Error).message })
    }
  } else {
    report({ platform: 'custom', status: 'skipped', found: 0 })
  }

  let added = 0
  let updated = 0
  let missing = 0
  const games: Record<string, Game> = { ...existing }
  const seen = new Set<string>()
  for (const d of detected) {
    seen.add(d.id)
    if (games[d.id]) {
      games[d.id] = mergeDetected(games[d.id], d)
      updated++
    } else {
      games[d.id] = fromDetected(d)
      added++
    }
  }
  for (const g of Object.values(games)) {
    if (seen.has(g.id)) continue
    if (g.platform === 'manual') {
      g.missing = !(await exists(g.installDir))
    } else if (succeeded.has(g.platform)) {
      // A custom folder that was removed from settings drops its games unless they have mods.
      const hasMods = Object.keys(db().get('mods')[g.id] ?? {}).length > 0
      if (g.platform === 'custom' && !hasMods && !roots.some((f) => g.installDir.toLowerCase().startsWith(f.toLowerCase()))) {
        delete games[g.id]
        continue
      }
      g.missing = !(await exists(g.installDir))
    }
    if (g.missing) missing++
  }
  db().set('games', games)
  broadcast()
  void enrichArtwork(Object.values(games))

  const result: ScanResult = {
    added,
    updated,
    missing,
    total: Object.keys(games).length,
    perPlatform: Object.values(progress),
    durationMs: Date.now() - started
  }
  log.info(`scan finished: ${JSON.stringify({ ...result, perPlatform: undefined })}`)
  return result
}

let enriching = false

/** Re-checks icons, versions and artwork of the whole library (startup, after a newer artwork lookup). */
export function refreshArtwork(): Promise<void> {
  return enrichArtwork(listGames())
}

/** Exe icons for everything, store artwork for games that have none. Runs in the background. */
async function enrichArtwork(games: Game[]): Promise<void> {
  if (enriching) return
  enriching = true
  try {
    const settings = getSettings()
    let changed = false
    // Every write re-reads the game after the await, so edits made meanwhile (favorite, name…) aren't overwritten.
    for (const g of games) {
      const before = getGame(g.id)
      if (!before?.exePath) continue
      if (!before.art.icon) {
        const icon = await exeIcon(before.id, before.exePath)
        const current = getGame(g.id)
        if (icon && current) {
          current.art = { ...current.art, icon }
          saveGame(current)
          changed = true
        }
      }
      if (before.version === undefined) {
        // An emulated game's executable is the emulator, whose version says nothing about the game.
        const version = before.emulator ? '' : ((await readExeVersion(before.exePath)) ?? '')
        const current = getGame(g.id)
        if (current && current.version === undefined) {
          current.version = version
          saveGame(current)
          changed = true
        }
      }
    }
    if (changed) broadcast()
    if (!settings.autoFetchArtwork) return
    // Every game is looked up once per artwork revision: missing pictures, and old ones that may be broken.
    const needArt = games.filter((g) => (g.artRev ?? 0) < ART_REV && !g.customArt?.capsule && !(g.userEdited ?? []).includes('art'))
    for (const g of needArt) {
      const before = getGame(g.id)
      if (!before) continue
      // Console games get their box art from the emulator lookup.
      if (before.emulator && before.art.capsule.length) {
        saveGame({ ...before, artRev: ART_REV })
        continue
      }
      try {
        const found = await fetchStoreArt(before)
        const current = getGame(g.id)
        if (!current) continue
        if (found) applyArt(current, found)
        current.artRev = ART_REV
        saveGame(current)
        broadcast()
      } catch (err) {
        // Offline or Steam hiccup: try again next time.
        log.warn(`artwork lookup for "${before.name}" failed: ${(err as Error).message}`)
      }
    }
  } finally {
    enriching = false
  }
}

/** Puts found artwork (and the store's spelling of the title, when it is the same name) on a game. */
function applyArt(game: Game, found: NonNullable<Awaited<ReturnType<typeof fetchStoreArt>>>): void {
  game.art = game.platform === 'steam' ? mergeArt(game.art, found.art) : { ...found.art, icon: game.art.icon }
  const edited = new Set(game.userEdited ?? [])
  if (found.match?.kind === 'exact' && game.platform !== 'steam' && !edited.has('name') && norm(found.match.title) === norm(game.name)) {
    game.storeName = found.match.title
    game.name = found.match.title
  }
}

export async function refetchArtwork(id: string): Promise<Game> {
  const game = requireGame(id)
  const found = await fetchStoreArt(game)
  if (!found) throw new Error(`No artwork found for "${game.name}" on the Steam store or in its folder.`)
  applyArt(game, found)
  game.artRev = ART_REV
  game.userEdited = (game.userEdited ?? []).filter((f) => f !== 'art')
  saveGame(game)
  broadcast()
  return game
}

function requireGame(id: string): Game {
  const g = getGame(id)
  if (!g) throw new Error('Game not found')
  return g
}

export async function addManualGame(input: ManualGameInput): Promise<Game> {
  const path = input.path.trim()
  if (!path) throw new Error('Choose an executable or folder.')
  let exePath: string | undefined
  let installDir: string
  if (await isDir(path)) {
    installDir = path
    exePath = await findMainExecutable(path, input.name || basename(path))
  } else {
    if (!(await exists(path))) throw new Error('That file does not exist.')
    if (!path.toLowerCase().endsWith('.exe')) throw new Error('Pick a .exe file or the game folder.')
    exePath = path
    installDir = dirname(path)
  }
  if (!exePath) throw new Error('No executable found in that folder. Pick the game .exe directly.')
  const name = input.name.trim() || cleanGameName(basename(installDir))
  const existing = listGames().find((g) => g.installDir.toLowerCase() === installDir.toLowerCase() && !g.hidden)
  if (existing) throw new Error(`"${existing.name}" already uses that folder.`)
  const args = input.args?.trim() ? input.args.trim() : undefined
  const game: Game = {
    id: `manual:${shortId('g')}`,
    name,
    platform: 'manual',
    installDir,
    exePath,
    launch: { kind: 'exe', exe: exePath },
    launchArgs: args,
    art: { capsule: [], hero: [], header: [], logo: [], icon: undefined },
    playtimeMinutes: 0,
    addedAt: Date.now(),
    modding: defaultModding({ platform: 'manual', name, installDir }),
    userEdited: ['name', 'exePath']
  }
  saveGame(game)
  broadcast()
  void enrichArtwork([game])
  log.info(`added manual game "${name}" at ${installDir}`)
  return game
}

export function updateGame(id: string, patch: Partial<Pick<Game, 'name' | 'exePath' | 'launchArgs' | 'favorite' | 'hidden' | 'customArt' | 'modding'>>): Game {
  const game = requireGame(id)
  const edited = new Set(game.userEdited ?? [])
  if (patch.name !== undefined && patch.name.trim() && patch.name !== game.name) {
    game.name = patch.name.trim()
    edited.add('name')
  }
  if (patch.exePath !== undefined && patch.exePath !== game.exePath) {
    game.exePath = patch.exePath
    edited.add('exePath')
    if (game.launch.kind === 'exe') {
      game.launch = { kind: 'exe', exe: patch.exePath }
      edited.add('launch')
    }
    game.art = { ...game.art, icon: undefined }
    game.version = undefined
  }
  if (patch.launchArgs !== undefined) game.launchArgs = patch.launchArgs.trim() || undefined
  if (patch.favorite !== undefined) game.favorite = patch.favorite
  if (patch.hidden !== undefined) game.hidden = patch.hidden
  if (patch.customArt !== undefined) {
    // Local image paths become media URLs the renderer can load; '' clears an image.
    const toUrl = (v: string | undefined) => (v === undefined ? undefined : !v ? '' : /^(https?|nexus-media):/i.test(v) ? v : mediaUrl(v))
    const next = { ...game.customArt }
    if (patch.customArt.capsule !== undefined) next.capsule = toUrl(patch.customArt.capsule) || undefined
    if (patch.customArt.hero !== undefined) next.hero = toUrl(patch.customArt.hero) || undefined
    game.customArt = next
  }
  if (patch.modding) game.modding = { ...game.modding, ...patch.modding, sources: { ...game.modding.sources, ...(patch.modding.sources ?? {}) } }
  game.userEdited = [...edited]
  saveGame(game)
  broadcast()
  if (!game.art.icon || game.version === undefined) void enrichArtwork([game])
  return game
}

export function removeGameRecord(id: string): void {
  const game = requireGame(id)
  if (game.platform === 'manual') {
    const games = db().get('games')
    delete games[id]
    db().set('games', games)
  } else {
    // Scanned games would come back on the next scan, so hide them instead.
    game.hidden = true
    saveGame(game)
  }
  broadcast()
}

export async function detectExecutables(dir: string): Promise<string[]> {
  return (await findExecutables(dir, basename(dir))).slice(0, 12).map((c) => c.path)
}

// ---------------------------------------------------------------------------
// Launching + playtime tracking for games we start directly.

const running = new Map<string, { pid?: number; startedAt: number }>()

export function runningGames(): string[] {
  return [...running.keys()]
}

function splitArgs(s: string | undefined): string[] {
  if (!s) return []
  return (s.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''))
}

export async function launchGame(id: string): Promise<void> {
  const game = requireGame(id)
  if (running.has(id)) throw new Error(`${game.name} is already running.`)
  const settings = getSettings()
  const extraArgs = splitArgs(game.launchArgs)
  log.info(`launching ${game.name} (${game.launch.kind})`)

  if (game.launch.kind === 'url') {
    await shell.openExternal(game.launch.url)
  } else if (game.launch.kind === 'appx') {
    spawn('explorer.exe', [`shell:AppsFolder\\${game.launch.aumid}`], { detached: true, stdio: 'ignore' }).unref()
  } else {
    const exe = game.launch.exe || game.exePath
    if (!exe || !(await exists(exe))) throw new Error('The game executable is missing. Set it in the game settings.')
    const args = [...(game.launch.args ?? []), ...extraArgs]
    const cwd = game.launch.cwd || dirname(exe)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', async (err: NodeJS.ErrnoException) => {
        // Executables that require elevation can't be spawned directly; ShellExecute shows the UAC prompt.
        if (err.code === 'EACCES' || err.code === 'EPERM' || /740|elevation/i.test(err.message)) {
          const msg = await shell.openPath(exe)
          return msg ? reject(new Error(msg)) : resolve()
        }
        reject(err)
      })
      child.once('spawn', () => {
        running.set(id, { pid: child.pid, startedAt: Date.now() })
        emit('library:running', runningGames())
        child.once('exit', () => {
          const info = running.get(id)
          running.delete(id)
          emit('library:running', runningGames())
          const current = getGame(id)
          if (info && current) {
            const minutes = Math.round((Date.now() - info.startedAt) / 60000)
            current.playtimeMinutes += minutes
            current.lastPlayed = Date.now()
            saveGame(current)
            broadcast()
          }
        })
        child.unref()
        resolve()
      })
    })
  }
  const current = getGame(id)
  if (current) {
    current.lastPlayed = Date.now()
    saveGame(current)
    broadcast()
  }
  if (settings.minimizeOnLaunch) BrowserWindow.getAllWindows().forEach((w) => w.minimize())
}
