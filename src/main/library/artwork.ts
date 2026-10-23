import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Game, GameArt } from '@shared/types'
import { paths, gameKey } from '../paths'
import { exists } from '../util/fs'
import { mediaUrl } from '../media-protocol'
import { steamCdnArt } from './steam'
import { scoped } from '../logger'

const log = scoped('artwork')

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
}

interface StoreSearchItem {
  type: string
  name: string
  id: number
}

/** Finds the best matching Steam store app for a game name (no API key needed). */
export async function findSteamAppId(name: string): Promise<string | undefined> {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=en`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'NexusForge/1.0' } })
  if (!res.ok) return undefined
  const data = (await res.json()) as { items?: StoreSearchItem[] }
  const items = (data.items ?? []).filter((i) => i.type === 'app')
  if (!items.length) return undefined
  const target = norm(name)
  const exact = items.find((i) => norm(i.name) === target)
  if (exact) return String(exact.id)
  // Only accept a near match when the difference is an edition suffix ("... Legacy", "... GOTY Edition"),
  // never a different game that merely starts with the same words.
  const EDITION = /^(legacy|enhanced|enhancededition|definitiveedition|remastered|remaster|goty|gameoftheyear|gameoftheyearedition|completeedition|deluxeedition|edition|directorscut|anniversaryedition|\d{4})$/
  const near = items.find((i) => {
    const n = norm(i.name)
    if (n.startsWith(target)) return EDITION.test(n.slice(target.length))
    if (target.startsWith(n)) return EDITION.test(target.slice(n.length))
    return false
  })
  return near ? String(near.id) : undefined
}

export async function fetchStoreArt(game: Game): Promise<GameArt | undefined> {
  try {
    const appId = await findSteamAppId(game.name)
    if (!appId) return undefined
    log.info(`matched "${game.name}" to Steam app ${appId}`)
    return { ...steamCdnArt(appId), icon: game.art.icon }
  } catch (err) {
    log.warn(`store lookup failed for "${game.name}": ${(err as Error).message}`)
    return undefined
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
