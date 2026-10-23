import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FeedConfig, ModDetails, ModSearchResult } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { normName } from './http'

/**
 * A custom source described by one JSON file, hosted anywhere (https://...) or on disk.
 *
 * {
 *   "name": "My mods",
 *   "mods": [{
 *     "id": "better-ui", "name": "Better UI", "summary": "...", "description": "...", "author": "me",
 *     "thumbnail": "https://.../icon.png", "games": ["steam:489830", "Skyrim Special Edition"],
 *     "versions": [{ "id": "1.2.0", "name": "Main file", "version": "1.2.0", "url": "https://.../better-ui.zip", "size": 12345, "date": "2026-01-01" }]
 *   }]
 * }
 *
 * `games` matches NexusForge game ids or game names; leave it out to show a mod for every game.
 * Version urls may be relative to the feed file.
 */
export interface FeedFile {
  name?: string
  mods: Array<{
    id: string
    name: string
    summary?: string
    description?: string
    author?: string
    thumbnail?: string
    url?: string
    games?: string[]
    tags?: string[]
    versions: Array<{ id: string; name?: string; version?: string; url: string; size?: number; date?: string }>
  }>
}

export function createFeedAdapter(feed: FeedConfig, ctx: AdapterContext): ModSourceAdapter {
  let cache: { at: number; data: FeedFile } | undefined
  const isRemote = /^https?:\/\//i.test(feed.url)

  async function load(): Promise<FeedFile> {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.data
    const data = isRemote ? await ctx.json<FeedFile>(feed.url) : (JSON.parse(await fsp.readFile(feed.url, 'utf8')) as FeedFile)
    if (!data || !Array.isArray(data.mods)) throw new Error(`${feed.name}: the feed has no "mods" array.`)
    cache = { at: Date.now(), data }
    return data
  }

  function resolveUrl(u: string): string {
    if (/^(https?|file):/i.test(u)) return u
    if (isRemote) return new URL(u, feed.url).toString()
    return pathToFileURL(isAbsolute(u) ? u : resolve(dirname(feed.url), u)).toString()
  }

  function matchesGame(games: string[] | undefined, gameId?: string): boolean {
    if (!games?.length || !gameId) return true
    const game = ctx.getGame(gameId)
    return games.some((g) => g === gameId || (game && normName(g) === normName(game.name)))
  }

  const sourceId = `feed:${feed.id}`
  return {
    id: sourceId,
    name: feed.name,
    description: `Custom feed: ${feed.url}`,

    async search(query, gameId): Promise<ModSearchResult[]> {
      const data = await load()
      const q = query.trim().toLowerCase()
      return data.mods
        .filter((m) => matchesGame(m.games, gameId))
        .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.summary ?? '').toLowerCase().includes(q) || (m.author ?? '').toLowerCase().includes(q))
        .map((m) => ({
          id: m.id,
          sourceId,
          name: m.name,
          summary: m.summary ?? '',
          author: m.author,
          thumbnail: m.thumbnail,
          version: m.versions[0]?.version,
          updatedAt: m.versions[0]?.date,
          url: m.url
        }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const m = (await load()).mods.find((x) => x.id === modId)
      if (!m) throw new Error('Mod not found in feed')
      return {
        id: m.id,
        sourceId,
        name: m.name,
        summary: m.summary ?? '',
        author: m.author,
        thumbnail: m.thumbnail,
        version: m.versions[0]?.version,
        url: m.url,
        description: m.description ?? m.summary ?? '',
        images: m.thumbnail ? [m.thumbnail] : [],
        tags: m.tags,
        versions: m.versions.map((v, i) => ({ id: v.id, name: v.name ?? v.version ?? v.id, version: v.version, sizeBytes: v.size, date: v.date, primary: i === 0 }))
      }
    },

    async getDownloadUrl(modId, versionId) {
      const m = (await load()).mods.find((x) => x.id === modId)
      const v = m?.versions.find((x) => x.id === versionId)
      if (!v) throw new Error('Version not found in feed')
      return resolveUrl(v.url)
    },

    getModPageUrl(modId) {
      return cache?.data.mods.find((m) => m.id === modId)?.url
    }
  }
}
