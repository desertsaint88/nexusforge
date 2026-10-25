import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Game, GameArt } from '@shared/types'
import { paths, gameKey } from '../paths'
import { exists, safeReaddir } from '../util/fs'
import { mediaUrl } from '../media-protocol'
import { readVersionStrings } from './exe-version'
import { matchKind, norm, storeQueries } from './names'
import { scoped } from '../logger'

export { norm } from './names'

const log = scoped('artwork')

/**
 * Bump when the lookup gets better: every game is checked once more with the new lookup.
 * 2: Steam's hashed asset URLs (newer games 404 on the old plain paths), better name matching, local images.
 */
export const ART_REV = 2

const ASSET_BASE = 'https://shared.cloudflare.steamstatic.com/store_item_assets/'

interface StoreSearchItem {
  type: string
  name: string
  id: number
}

async function storeSearch(term: string): Promise<StoreSearchItem[]> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'NexusForge/1.0' } })
  if (!res.ok) throw new Error(`Steam store search: ${res.status}`)
  const data = (await res.json()) as { items?: StoreSearchItem[] }
  return (data.items ?? []).filter((i) => i.type === 'app')
}

export interface SteamMatch {
  appId: string
  /** The store's title, without ™/®. */
  title: string
  kind: 'exact' | 'edition'
}

/** Finds the Steam store app for any of the names a game goes by (folder name, exe product name, Unity app name). */
export async function matchSteamApp(names: string[]): Promise<SteamMatch | undefined> {
  let best: SteamMatch | undefined
  const tried = new Set<string>()
  for (const name of names) {
    for (const term of storeQueries(name)) {
      if (tried.has(term.toLowerCase())) continue
      tried.add(term.toLowerCase())
      const items = await storeSearch(term)
      for (const i of items) {
        const kind = matchKind(name, i.name) ?? matchKind(term, i.name)
        if (!kind) continue
        const m = { appId: String(i.id), title: i.name.replace(/[™®©]/g, '').replace(/\s{2,}/g, ' ').trim(), kind }
        if (kind === 'exact') return m
        best ??= m
      }
    }
    if (best) return best
  }
  return best
}

/** Finds the best matching Steam store app for a game name (no API key needed). */
export async function findSteamAppId(name: string): Promise<string | undefined> {
  return (await matchSteamApp([name]))?.appId
}

// ---------------------------------------------------------------------------
// Steam store assets

interface StoreAssets {
  asset_url_format?: string
  library_capsule?: string
  library_capsule_2x?: string
  library_hero?: string
  library_hero_2x?: string
  library_logo?: string
  library_logo_2x?: string
  header?: string
  header_2x?: string
  main_capsule?: string
  hero_capsule?: string
  hero_capsule_2x?: string
}

/**
 * The store's current artwork for apps, from the same API the Steam store uses. Newer games keep their pictures
 * under hashed paths (…/apps/<id>/<hash>/library_capsule.jpg); the old plain paths 404 for them.
 */
export async function steamStoreArt(appIds: string[]): Promise<Map<string, GameArt>> {
  const out = new Map<string, GameArt>()
  for (let i = 0; i < appIds.length; i += 40) {
    const ids = appIds.slice(i, i + 40)
    const input = { ids: ids.map((id) => ({ appid: Number(id) })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } }
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'NexusForge/1.0' } })
    if (!res.ok) throw new Error(`Steam store assets: ${res.status}`)
    const data = (await res.json()) as { response?: { store_items?: Array<{ appid?: number; id?: number; success?: number; assets?: StoreAssets }> } }
    for (const item of data.response?.store_items ?? []) {
      const a = item.assets
      const id = String(item.appid ?? item.id ?? '')
      if (!a?.asset_url_format || !id) continue
      const u = (file?: string) => (file ? ASSET_BASE + a.asset_url_format!.replace('${FILENAME}', file) : undefined)
      const list = (...files: Array<string | undefined>) => files.map(u).filter(Boolean) as string[]
      out.set(id, {
        capsule: list(a.library_capsule_2x, a.library_capsule),
        hero: list(a.library_hero, a.library_hero_2x),
        header: list(a.header_2x, a.header, a.main_capsule),
        logo: list(a.library_logo_2x, a.library_logo)
      })
    }
  }
  return out
}

/** True when the image is really there (a 404 would leave an empty tile). */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'NexusForge/1.0' } })
    return res.ok && /^image\//i.test(res.headers.get('content-type') ?? 'image/')
  } catch {
    return false
  }
}

/** Drops the first candidate of each kind while it doesn't load; the renderer walks the rest itself. */
async function verified(art: GameArt): Promise<GameArt> {
  const firstGood = async (urls: string[]) => {
    const list = [...urls]
    while (list.length && !(await reachable(list[0]))) list.shift()
    return list
  }
  const [capsule, hero, header] = await Promise.all([firstGood(art.capsule), firstGood(art.hero), firstGood(art.header)])
  return { ...art, capsule, hero, header }
}

// ---------------------------------------------------------------------------
// Names a game goes by, and pictures in its own folder

/** Unity games write their product name to <Game>_Data/app.info (company, then product). */
async function unityProductName(installDir: string): Promise<string | undefined> {
  for (const e of await safeReaddir(installDir)) {
    if (!e.isDirectory() || !e.name.endsWith('_Data')) continue
    try {
      const lines = (await fsp.readFile(join(installDir, e.name, 'app.info'), 'utf8')).split(/\r?\n/).map((l) => l.trim())
      if (lines[1]) return lines[1]
    } catch {
      // not a Unity data folder
    }
  }
  return undefined
}

export async function gameNames(game: Pick<Game, 'name' | 'installDir' | 'exePath' | 'emulator'>): Promise<string[]> {
  const names = [game.name]
  const add = (s?: string) => {
    const t = s?.replace(/[™®©]/g, '').trim()
    if (t && t.length >= 3 && !/^(unity|unreal|game|launcher|setup)$/i.test(t) && !names.some((n) => norm(n) === norm(t))) names.push(t)
  }
  add(await unityProductName(game.installDir))
  if (game.exePath && !game.emulator) {
    const v = await readVersionStrings(game.exePath)
    // Engine executables say "Unreal Engine" or the studio's codename; only take a product name that looks like a title.
    if (v?.productName && !/unreal|unity|engine|shipping|win64|launcher/i.test(v.productName)) add(v.productName)
  }
  return names
}

const LOCAL_ART: Array<[keyof Pick<GameArt, 'capsule' | 'header' | 'hero'>, RegExp]> = [
  ['capsule', /^(cover|poster|boxart|box|capsule|folder|library_600x900)\.(jpe?g|png|webp)$/i],
  ['header', /^(banner|header)\.(jpe?g|png|webp)$/i],
  ['hero', /^(hero|background|keyart|library_hero)\.(jpe?g|png|webp)$/i]
]

/** Cover pictures shipped in the game's folder (GOG and itch.io builds often have one). */
export async function localFolderArt(installDir: string): Promise<GameArt | undefined> {
  const art: GameArt = { capsule: [], hero: [], header: [], logo: [] }
  for (const e of await safeReaddir(installDir)) {
    if (!e.isFile()) continue
    for (const [kind, re] of LOCAL_ART) if (re.test(e.name)) art[kind].push(mediaUrl(join(installDir, e.name)))
  }
  return art.capsule.length || art.header.length || art.hero.length ? art : undefined
}

export interface StoreArtResult {
  art: GameArt
  match?: SteamMatch
}

/**
 * Artwork for a game: the Steam store's current pictures (verified to load), else pictures in the game's folder.
 * Throws on network errors so the caller can try again later.
 */
export async function fetchStoreArt(game: Game): Promise<StoreArtResult | undefined> {
  let match: SteamMatch | undefined
  if (game.platform === 'steam' && game.platformId) match = { appId: game.platformId, title: game.name, kind: 'exact' }
  else match = await matchSteamApp(await gameNames(game))
  if (match) {
    const store = (await steamStoreArt([match.appId])).get(match.appId)
    if (store) {
      const art = await verified(store)
      if (art.capsule.length || art.header.length) {
        log.info(`"${game.name}": Steam app ${match.appId} (${match.title}, ${match.kind})`)
        return { art: { ...art, icon: game.art.icon }, match }
      }
    }
  }
  const local = await localFolderArt(game.installDir)
  if (local) return { art: { ...local, icon: game.art.icon } }
  return undefined
}

const isLocal = (u: string) => u.startsWith('nexus-media:')

/** Steam's own cached pictures stay first; remote ones come from the newest lookup. */
export function mergeArt(local: GameArt, remote: GameArt): GameArt {
  const pick = (a: string[], b: string[]) => [...new Set([...a.filter(isLocal), ...b])]
  return {
    capsule: pick(local.capsule, remote.capsule),
    hero: pick(local.hero, remote.hero),
    header: pick(local.header, remote.header),
    logo: pick(local.logo, remote.logo),
    icon: local.icon ?? remote.icon
  }
}

/** Extracts the exe icon into the cache and returns a media URL for it. */
export async function exeIcon(gameId: string, exePath: string | undefined): Promise<string | undefined> {
  if (!exePath || !(await exists(exePath))) return undefined
  try {
    const file = join(paths.cache('icons'), `${gameKey(gameId)}.png`)
    if (!(await exists(file))) {
      const img = await app.getFileIcon(exePath, { size: 'large' })
      if (img.isEmpty()) return undefined
      await fsp.writeFile(file, img.toPNG())
    }
    return mediaUrl(file)
  } catch {
    return undefined
  }
}
