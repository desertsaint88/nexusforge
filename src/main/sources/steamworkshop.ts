import type { ModDependency, ModDetails, ModSearchResult, SourceGameBinding } from '@shared/types'
import type { AdapterContext, DownloadPlan, ModSourceAdapter } from './types'
import { gameNameVariants, toPlainText } from './http'
import { findSteamAppId } from '../library/artwork'

const API = 'https://api.steampowered.com'

interface FileDetails {
  publishedfileid: string
  result: number
  title?: string
  description?: string
  preview_url?: string
  file_url?: string
  filename?: string
  file_size?: string | number
  consumer_app_id?: number
  creator?: string
  lifetime_subscriptions?: number
  subscriptions?: number
  favorited?: number
  time_created?: number
  time_updated?: number
  tags?: Array<{ tag: string }>
}

async function fileDetails(ctx: AdapterContext, ids: string[]): Promise<FileDetails[]> {
  if (!ids.length) return []
  const body = new URLSearchParams({ itemcount: String(ids.length) })
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id))
  const res = await ctx.json<{ response: { publishedfiledetails?: FileDetails[] } }>(`${API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
    method: 'POST',
    body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
  return res.response.publishedfiledetails ?? []
}

/**
 * The items of a Workshop browse page, in the page's order. The page carries its list as data (result objects
 * start with publishedfileid + creator); plain links can't be used, because item descriptions link to other items
 * ("New version: …") and the page links the game's upload guide, and those would end up in the list.
 */
export function workshopBrowseIds(html: string): string[] {
  const listed = [...html.matchAll(/\{\\?"publishedfileid\\?"\s*:\s*\\?"(\d{6,})\\?"\s*,\s*\\?"creator\\?"/g)].map((m) => m[1])
  if (listed.length) return [...new Set(listed)].slice(0, 30)
  // Older server-rendered pages: one "workshopItem" block per result.
  const blocks = [...html.matchAll(/class="workshopItem"[\s\S]*?filedetails\/\?id=(\d{6,})/g)].map((m) => m[1])
  return [...new Set(blocks)].slice(0, 30)
}

export function createSteamWorkshopAdapter(ctx: AdapterContext): ModSourceAdapter {
  const searchCache = new Map<string, { at: number; results: ModSearchResult[] }>()

  async function appId(gameId?: string): Promise<string> {
    const a = await ctx.binding(gameId)
    if (!a) throw new Error(gameId ? 'Set the Steam app id for this game in the game settings.' : 'Pick a game to search the Steam Workshop.')
    return a
  }

  /** Workshop item pages list "Required items"; Steam has no keyless API for them. */
  async function requiredItems(id: string): Promise<{ ids: string[]; failed: boolean }> {
    try {
      const html = await ctx.text(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`)
      const block = html.match(/id="RequiredItems"([\s\S]*?)<\/div>\s*<\/div>/)
      if (!block) return { ids: [], failed: false }
      const ids = [...block[1].matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]).filter((x) => x !== id)
      return { ids: [...new Set(ids)], failed: false }
    } catch {
      return { ids: [], failed: true }
    }
  }

  const toResult = (d: FileDetails): ModSearchResult => ({
    id: d.publishedfileid,
    sourceId: 'steamworkshop',
    name: d.title ?? d.publishedfileid,
    summary: toPlainText(d.description).split('\n').find((l) => l.trim().length > 20)?.slice(0, 220) ?? '',
    thumbnail: d.preview_url,
    downloads: d.lifetime_subscriptions ?? d.subscriptions,
    endorsements: d.favorited,
    updatedAt: d.time_updated ? new Date(d.time_updated * 1000).toISOString() : undefined,
    createdAt: d.time_created ? new Date(d.time_created * 1000).toISOString() : undefined,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`
  })

  const adapter: ModSourceAdapter = {
    id: 'steamworkshop',
    name: 'Steam Workshop',
    description:
      'Workshop items for any game. Downloads use SteamCMD with an anonymous login (installed automatically). Steam allows that for many games, like Garry\'s Mod and People Playground; for the rest, subscribe in Steam.',
    homepage: 'https://steamcommunity.com/workshop/',
    bindingLabel: 'Steam app id',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      if (game.platform === 'steam' && game.platformId) return [{ value: game.platformId, label: `${game.name} (app ${game.platformId})` }]
      for (const term of gameNameVariants(game.name)) {
        const id = await findSteamAppId(term).catch(() => undefined)
        if (id) return [{ value: id, label: `${term} (app ${id})` }]
      }
      return []
    },

    sorts: ['relevance', 'endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated'],
    sortLabels: {
      endorsed: 'Top Rated',
      downloads: 'Most Subscribed',
      downloads_recent: 'Most Popular, 30 days',
      trending: 'Most Popular, 1 week',
      newest: 'Most Recent',
      updated: 'Last Updated'
    },

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      const app = await appId(gameId)
      const q = query.trim()
      const sort = opts?.sort ?? (q ? 'relevance' : 'downloads')
      const key = `${app}|${q.toLowerCase()}|${sort}`
      const hit = searchCache.get(key)
      if (hit && Date.now() - hit.at < 3 * 60_000) return hit.results
      // Steam's "Most popular" (trend) over a window: a week for trending, a month for recent downloads, all time otherwise.
      const [browsesort, days] =
        sort === 'relevance' ? [q ? 'textsearch' : 'trend', -1]
        : sort === 'endorsed' ? ['toprated', -1]
        : sort === 'downloads' ? ['totaluniquesubscribers', -1]
        : sort === 'downloads_recent' ? ['trend', 30]
        : sort === 'trending' ? ['trend', 7]
        : sort === 'newest' ? ['mostrecent', -1]
        : ['lastupdated', -1]
      const url = `https://steamcommunity.com/workshop/browse/?appid=${app}&searchtext=${encodeURIComponent(q)}&browsesort=${browsesort}&section=readytouseitems&days=${days}&numperpage=30`
      const html = await ctx.text(url)
      if (/too many requests/i.test(html)) throw new Error('Steam is rate limiting Workshop searches. Wait a minute and try again.')
      const ids = workshopBrowseIds(html)
      const details = (await fileDetails(ctx, ids)).filter((d) => d.result === 1 && String(d.consumer_app_id) === app)
      // Keep Steam's order (the page's order is the sort).
      const rank = new Map(ids.map((id, i) => [id, i]))
      const results = details.sort((a, b) => (rank.get(a.publishedfileid) ?? 0) - (rank.get(b.publishedfileid) ?? 0)).map(toResult)
      searchCache.set(key, { at: Date.now(), results })
      return results
    },

    async getModDetails(modId): Promise<ModDetails> {
      const [d] = await fileDetails(ctx, [modId])
      if (!d || d.result !== 1) throw new Error('This Workshop item is private, removed or hidden.')
      const req = await requiredItems(modId)
      const reqDetails = await fileDetails(ctx, req.ids).catch(() => [] as FileDetails[])
      const requirements: ModDependency[] = req.ids.map((id) => ({
        sourceId: 'steamworkshop',
        modId: id,
        name: reqDetails.find((x) => x.publishedfileid === id)?.title ?? `Workshop item ${id}`,
        required: true,
        installable: true,
        url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
      }))
      return {
        ...toResult(d),
        description: toPlainText(d.description),
        images: d.preview_url ? [d.preview_url] : [],
        tags: d.tags?.map((t) => t.tag),
        requirements: req.failed
          ? [{ sourceId: '', name: 'Could not check required items (Steam rate limit). Open the Workshop page to see them.', required: false, installable: false, url: toResult(d).url }]
          : requirements,
        versions: [
          {
            id: 'latest',
            name: d.title ?? modId,
            fileName: d.filename || undefined,
            sizeBytes: d.file_size ? Number(d.file_size) : undefined,
            date: d.time_updated ? new Date(d.time_updated * 1000).toISOString() : undefined,
            primary: true
          }
        ]
      }
    },

    async resolveDependencies(modId) {
      return ((await adapter.getModDetails(modId)).requirements ?? []).filter((r) => r.sourceId)
    },

    async getDownload(modId): Promise<DownloadPlan> {
      const [d] = await fileDetails(ctx, [modId])
      if (!d || d.result !== 1) throw new Error('This Workshop item is private, removed or hidden.')
      // Very old items still have a direct file URL; everything newer goes through Steam's content system.
      // Garry's Mod's old files are compressed addons, which the SteamCMD path knows how to unpack.
      if (d.file_url && d.consumer_app_id !== 4000) return { kind: 'url', url: d.file_url, fileName: d.filename?.split('/').pop() }
      return { kind: 'steamcmd', appId: String(d.consumer_app_id), itemId: modId, title: d.title ?? modId }
    },

    async getDownloadUrl(modId) {
      const plan = await adapter.getDownload!(modId, 'latest')
      if (plan.kind === 'url') return plan.url
      throw new Error('Workshop items are downloaded with SteamCMD; start the download from NexusForge.')
    },

    getModPageUrl(modId) {
      return `https://steamcommunity.com/sharedfiles/filedetails/?id=${modId}`
    }
  }
  return adapter
}
