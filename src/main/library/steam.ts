import { promises as fsp } from 'node:fs'
import { join, normalize } from 'node:path'
import type { DetectedGame, GameArt } from '@shared/types'
import { exists, safeReaddir } from '../util/fs'
import { regValue } from '../util/exec'
import { parseVdf, vget, vstr, type VdfObject } from './vdf'
import { findMainExecutable } from './exe-detect'
import { mediaUrl } from '../media-protocol'

// Tools, runtimes and redistributables that show up as "apps" in Steam libraries.
const NON_GAME_APPIDS = new Set([
  '228980', // Steamworks Common Redistributables
  '1070560', '1391110', '1628350', '2180100', // Steam Linux Runtimes
  '1493710', '1826330', '2348590', '2805730', '3658110', // Proton
  '250820', // SteamVR
  '1007', // Steam client
  '431960' // Wallpaper Engine
])
const NON_GAME_NAME = /(redistributable|steamworks|proton |steam linux runtime|steamvr|dedicated server|sdk$|benchmark tool)/i

export const STEAM_CDN = 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps'

export function steamCdnArt(appId: string): GameArt {
  return {
    capsule: [`${STEAM_CDN}/${appId}/library_600x900_2x.jpg`, `${STEAM_CDN}/${appId}/library_600x900.jpg`],
    hero: [`${STEAM_CDN}/${appId}/library_hero.jpg`],
    header: [`${STEAM_CDN}/${appId}/header.jpg`],
    logo: [`${STEAM_CDN}/${appId}/logo.png`]
  }
}

export async function findSteamRoot(): Promise<string | undefined> {
  // HKLM first: HKCU's SteamPath is often stored lower-case ("c:/program files (x86)/steam").
  const candidates = [
    await regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    await regValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    await regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ]
  for (const c of candidates) {
    if (!c) continue
    const p = normalize(c.replace(/\//g, '\\'))
    if (await exists(join(p, 'steamapps'))) return p
  }
  return undefined
}

async function libraryFolders(steamRoot: string): Promise<string[]> {
  const folders = new Set<string>([steamRoot.toLowerCase()])
  const out = [steamRoot]
  for (const file of [join(steamRoot, 'steamapps', 'libraryfolders.vdf'), join(steamRoot, 'config', 'libraryfolders.vdf')]) {
    try {
      const vdf = parseVdf(await fsp.readFile(file, 'utf8'))
      const lf = vget(vdf, 'libraryfolders')
      if (!lf || typeof lf !== 'object') continue
      for (const [key, entry] of Object.entries(lf)) {
        const path = typeof entry === 'object' ? vstr(entry, 'path') : /^\d+$/.test(key) ? entry : undefined
        if (!path) continue
        const norm = normalize(path)
        if (!folders.has(norm.toLowerCase()) && (await exists(join(norm, 'steamapps')))) {
          folders.add(norm.toLowerCase())
          out.push(norm)
        }
      }
    } catch {
      // file missing or unreadable
    }
  }
  return out
}

async function readPlaytimes(steamRoot: string): Promise<Map<string, { minutes: number; lastPlayed?: number }>> {
  const map = new Map<string, { minutes: number; lastPlayed?: number }>()
  try {
    const users = parseVdf(await fsp.readFile(join(steamRoot, 'config', 'loginusers.vdf'), 'utf8'))
    const list = vget(users, 'users') as VdfObject | undefined
    if (!list) return map
    const ids = Object.keys(list)
    const recent = ids.find((id) => vstr(list[id], 'MostRecent') === '1') ?? ids.sort((a, b) => Number(vstr(list[b], 'Timestamp') ?? 0) - Number(vstr(list[a], 'Timestamp') ?? 0))[0]
    if (!recent) return map
    const accountId = (BigInt(recent) - 76561197960265728n).toString()
    const cfg = parseVdf(await fsp.readFile(join(steamRoot, 'userdata', accountId, 'config', 'localconfig.vdf'), 'utf8'))
    const apps = vget(cfg, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') ?? vget(cfg, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'Apps')
    if (!apps || typeof apps !== 'object') return map
    for (const [appId, data] of Object.entries(apps)) {
      const minutes = Number(vstr(data, 'Playtime') ?? 0)
      const last = Number(vstr(data, 'LastPlayed') ?? 0)
      map.set(appId, { minutes, lastPlayed: last ? last * 1000 : undefined })
    }
  } catch {
    // no user data
  }
  return map
}

/** Steam's local artwork cache: appcache/librarycache/<appid>/<hash>/library_*.jpg (new) or <appid>_*.jpg (old). */
async function localArt(steamRoot: string, appId: string): Promise<Partial<Record<keyof Omit<GameArt, 'icon'>, string>>> {
  const base = join(steamRoot, 'appcache', 'librarycache')
  const out: Partial<Record<keyof Omit<GameArt, 'icon'>, string>> = {}
  const wanted: Record<string, keyof Omit<GameArt, 'icon'>> = {
    'library_600x900.jpg': 'capsule',
    'library_capsule.jpg': 'capsule',
    'library_hero.jpg': 'hero',
    'library_header.jpg': 'header',
    'header.jpg': 'header',
    'logo.png': 'logo'
  }
  const dir = join(base, appId)
  for (const e of await safeReaddir(dir)) {
    if (e.isFile() && wanted[e.name.toLowerCase()]) out[wanted[e.name.toLowerCase()]] ??= join(dir, e.name)
    if (e.isDirectory()) {
      for (const f of await safeReaddir(join(dir, e.name))) {
        const kind = wanted[f.name.toLowerCase()]
        if (f.isFile() && kind) out[kind] ??= join(dir, e.name, f.name)
      }
    }
  }
  const legacy: Record<string, keyof Omit<GameArt, 'icon'>> = {
    [`${appId}_library_600x900.jpg`]: 'capsule',
    [`${appId}_library_hero.jpg`]: 'hero',
    [`${appId}_header.jpg`]: 'header',
    [`${appId}_logo.png`]: 'logo'
  }
  for (const [file, kind] of Object.entries(legacy)) {
    if (!out[kind] && (await exists(join(base, file)))) out[kind] = join(base, file)
  }
  return out
}

export async function scanSteam(): Promise<DetectedGame[]> {
  const root = await findSteamRoot()
  if (!root) return []
  const libs = await libraryFolders(root)
  const playtimes = await readPlaytimes(root)
  const games: DetectedGame[] = []
  for (const lib of libs) {
    const appsDir = join(lib, 'steamapps')
    for (const e of await safeReaddir(appsDir)) {
      if (!e.isFile() || !/^appmanifest_\d+\.acf$/i.test(e.name)) continue
      try {
        const acf = parseVdf(await fsp.readFile(join(appsDir, e.name), 'utf8'))
        const state = vget(acf, 'AppState')
        const appId = vstr(state, 'appid')
        const name = vstr(state, 'name')
        const installdir = vstr(state, 'installdir')
        if (!appId || !name || !installdir) continue
        if (NON_GAME_APPIDS.has(appId) || NON_GAME_NAME.test(name)) continue
        const installDir = join(appsDir, 'common', installdir)
        if (!(await exists(installDir))) continue
        const local = await localArt(root, appId)
        const cdn = steamCdnArt(appId)
        const art: GameArt = {
          capsule: [...(local.capsule ? [mediaUrl(local.capsule)] : []), ...cdn.capsule],
          hero: [...(local.hero ? [mediaUrl(local.hero)] : []), ...cdn.hero],
          header: [...(local.header ? [mediaUrl(local.header)] : []), ...cdn.header],
          logo: [...(local.logo ? [mediaUrl(local.logo)] : []), ...cdn.logo]
        }
        const pt = playtimes.get(appId)
        const lastPlayedAcf = Number(vstr(state, 'LastPlayed') ?? 0) * 1000
        games.push({
          id: `steam:${appId}`,
          name,
          platform: 'steam',
          platformId: appId,
          installDir,
          exePath: await findMainExecutable(installDir, name),
          launch: { kind: 'url', url: `steam://rungameid/${appId}` },
          art,
          playtimeMinutes: pt?.minutes,
          lastPlayed: pt?.lastPlayed ?? (lastPlayedAcf || undefined),
          sizeBytes: Number(vstr(state, 'SizeOnDisk') ?? 0) || undefined
        })
      } catch {
        // corrupt manifest - skip
      }
    }
  }
  return games
}
