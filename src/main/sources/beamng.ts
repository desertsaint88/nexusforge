// The official BeamNG.drive mod repository (beamng.com/resources). No account needed: "Download Now" links
// redirect to the file. BeamNG loads mods as zip files, which the BeamNG preset keeps packed.

import type { ModDetails, ModSearchResult, ModSort, SourceGameBinding } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { decodeEntities, toPlainText } from './http'

const BASE = 'https://www.beamng.com/'
const RESOURCE = /resources\/([a-z0-9-]+\.\d+)\//i

const abs = (u: string) => (/^https?:/i.test(u) ? u : BASE + u.replace(/^\//, ''))
const iconFor = (modId: string) => {
  const num = Number(modId.split('.').pop())
  return `${BASE}data/resource_icons/${Math.floor(num / 1000)}/${num}.jpg`
}
const text = (html: string | undefined) => decodeEntities((html ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
const count = (s: string | undefined) => (s ? Number(s.replace(/[^\d]/g, '')) || undefined : undefined)
const date = (title: string | undefined) => {
  const t = title ? Date.parse(title.replace(' at ', ' ')) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** Resource list pages ("most downloaded", categories). */
export function parseResourceList(html: string): ModSearchResult[] {
  const out: ModSearchResult[] = []
  for (const m of html.matchAll(/<li class="resourceListItem[^"]*"[^>]*>([\s\S]*?)<\/li>\s*(?=<li class="resourceListItem|<\/ol>|<\/ul>)/g)) {
    const block = m[1]
    const title = block.match(/<h3 class="title">[\s\S]*?<a\s+href="(resources\/[^"]+)">([\s\S]*?)<\/a>/)
    const id = title?.[1].match(RESOURCE)?.[1]
    if (!title || !id) continue
    out.push({
      id,
      sourceId: 'beamng',
      name: text(title[2]),
      summary: text(block.match(/<div class="tagLine">([\s\S]*?)<\/div>/)?.[1]),
      author: text(block.match(/resources\/authors\/[^"]+">([^<]+)<\/a>/)?.[1]) || undefined,
      thumbnail: abs(block.match(/<img src="(data\/resource_icons\/[^"?]+)/)?.[1] ?? iconFor(id)),
      downloads: count(block.match(/<dt>Downloads:<\/dt>\s*<dd>([^<]+)<\/dd>/)?.[1]),
      endorsements: count(block.match(/<span class="Hint">(\d[\d,]*) ratings?<\/span>/)?.[1]),
      updatedAt: date(block.match(/resourceUpdated[\s\S]*?class="DateTime" title="([^"]+)"/)?.[1]),
      version: text(block.match(/<span class="version">([^<]*)<\/span>/)?.[1]) || undefined,
      url: abs(`resources/${id}/`)
    })
  }
  return out
}

/** Search results list resource updates; one entry per resource. */
export function parseSearchResults(html: string): ModSearchResult[] {
  const seen = new Map<string, ModSearchResult>()
  for (const m of html.matchAll(/<li id="resource_update-\d+" class="searchResult[^"]*"(?: data-author="([^"]*)")?>([\s\S]*?)<\/li>/g)) {
    const block = m[2]
    const inResource = block.match(/in resource: <a href="(resources\/[^"]+)">([\s\S]*?)<\/a>/)
    const link = inResource?.[1] ?? block.match(/<h3 class="title">\s*<a href="(resources\/[^"]+)"/)?.[1]
    const id = link?.match(RESOURCE)?.[1]
    if (!id || seen.has(id)) continue
    const name = inResource ? text(inResource[2]) : text(block.match(/<h3 class="title">([\s\S]*?)<\/h3>/)?.[1])
    seen.set(id, {
      id,
      sourceId: 'beamng',
      name,
      summary: text(block.match(/<blockquote class="snippet">([\s\S]*?)<\/blockquote>/)?.[1]).slice(0, 220),
      author: m[1] ? decodeEntities(m[1]) : undefined,
      thumbnail: iconFor(id),
      updatedAt: date(block.match(/class="DateTime" title="([^"]+)"/)?.[1]),
      url: abs(`resources/${id}/`)
    })
  }
  return [...seen.values()]
}

export function parseResourcePage(html: string, id: string): ModDetails {
  const info = html.match(/<div class="resourceInfo">([\s\S]*?)<div class="(?:tagBlock|resourceTabs)/)?.[1] ?? html
  const h1 = info.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ''
  const version = text(h1.match(/<span class="muted">([^<]*)<\/span>/)?.[1]) || undefined
  const name = text(h1.replace(/<span class="muted">[^<]*<\/span>/, '')) || id
  const link = info.match(/href="resources\/[^"]+\/download\?version=(\d+)"[^>]*>([\s\S]*?)<\/a>/)
  // "Download Now <small>163.9 MB .zip</small>"
  const fileInfo = link?.[2].match(/<small class="minorText">([^<]+)<\/small>/)?.[1] ?? ''
  const description = html.match(/<blockquote class="ugc baseHtml[^"]*">([\s\S]*?)<\/blockquote>/)?.[1] ?? ''
  const images = [...description.matchAll(/<img\s+src="([^"]+)"[^>]*class="bbCodeImage/g)].map((x) => abs(x[1])).slice(0, 8)
  const size = fileInfo.match(/([\d.]+)\s*(KB|MB|GB)/i)
  const sizeBytes = size ? Math.round(Number(size[1]) * { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[size[2].toUpperCase() as 'KB' | 'MB' | 'GB']) : undefined
  const ext = fileInfo.match(/\.(\w+)\s*$/)?.[1]
  const author = text(html.match(/<dl class="author">[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1] ?? html.match(/resources\/authors\/[^"]+">([^<]+)<\/a>/)?.[1]) || undefined
  const icon = info.match(/<img src="(data\/resource_icons\/[^"?]+)/)?.[1]
  return {
    id,
    sourceId: 'beamng',
    name,
    summary: text(info.match(/<p class="tagLine[^"]*">([\s\S]*?)<\/p>/)?.[1]),
    author,
    thumbnail: icon ? abs(icon) : iconFor(id),
    version,
    url: abs(`resources/${id}/`),
    description: toPlainText(description),
    images,
    downloads: count(html.match(/<dl class="downloadCount">\s*<dt>[^<]*<\/dt>\s*<dd>([^<]+)<\/dd>/)?.[1]),
    updatedAt: date(html.match(/<dl class="lastUpdate">[\s\S]*?title="([^"]+)"/)?.[1]),
    versions: link ? [{ id: link[1], name: `${name}${version ? ` ${version}` : ''}`, version, fileName: ext ? `${name}.${ext}` : undefined, sizeBytes, primary: true }] : []
  }
}

export function createBeamngAdapter(ctx: AdapterContext): ModSourceAdapter {
  const requireBeamng = async (gameId?: string) => {
    const b = await ctx.binding(gameId)
    if (b !== 'beamng') throw new Error(gameId ? 'The BeamNG repository only has mods for BeamNG.drive.' : 'Pick BeamNG.drive to search the BeamNG repository.')
  }
  return {
    id: 'beamng',
    name: 'BeamNG Repository',
    description: 'The official BeamNG.drive mod repository: cars, maps and more, no account needed. Mods are installed as zip files into BeamNG\'s mods folder, the way the game expects them.',
    homepage: 'https://www.beamng.com/resources/',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      return /beamng/i.test(game.name) || game.platformId === '284160' ? [{ value: 'beamng', label: 'BeamNG.drive' }] : []
    },

    sorts: ['relevance', 'endorsed', 'downloads', 'newest', 'updated'],
    sortLabels: { endorsed: 'Rating', downloads: 'Downloads', newest: 'Submission Date', updated: 'Latest updates' },
    // The site's search only orders by relevance or date.
    querySorts: ['relevance', 'updated'],

    paged: true,

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      await requireBeamng(gameId)
      const q = query.trim()
      const sort = opts?.sort ?? (q ? 'relevance' : 'downloads')
      const page = (opts?.page ?? 0) + 1
      if (!q) {
        const ORDER: Partial<Record<ModSort, string>> = { relevance: 'download_count', endorsed: 'rating_weighted', downloads: 'download_count', newest: 'resource_date', updated: 'last_update' }
        // Past the last page the forum shows the last page again; Browse stops when a page brings nothing new.
        return parseResourceList(await ctx.text(`${BASE}resources/?order=${ORDER[sort] ?? 'download_count'}${page > 1 ? `&page=${page}` : ''}`))
      }
      // Search result pages are tied to a search id; the first page is all NexusForge shows.
      if (page > 1) return []
      const html = await ctx.text(`${BASE}search/search?keywords=${encodeURIComponent(q)}&type=resource_update&order=${sort === 'updated' ? 'date' : 'relevance'}`)
      if (/No results found/i.test(html)) return []
      return parseSearchResults(html)
    },

    async getModDetails(modId): Promise<ModDetails> {
      if (!/^[a-z0-9-]+\.\d+$/i.test(modId)) throw new Error(`Invalid BeamNG resource: ${modId}`)
      const details = parseResourcePage(await ctx.text(`${BASE}resources/${modId}/`), modId)
      if (!details.versions.length) throw new Error('This mod has no download on beamng.com (it may only be available in the in-game repository).')
      return details
    },

    async getDownloadUrl(modId, versionId) {
      return `${BASE}resources/${modId}/download?version=${encodeURIComponent(versionId)}`
    },

    getModPageUrl(modId) {
      return `${BASE}resources/${modId}/`
    }
  }
}
