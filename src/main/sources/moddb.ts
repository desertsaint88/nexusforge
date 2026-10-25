import type { ModDetails, ModSearchResult, ModSort, ModVersion, SourceGameBinding } from '@shared/types'
import type { AdapterContext, DownloadPlan, ModSourceAdapter } from './types'
import { decodeEntities, gameNameVariants, nameScore, toPlainText } from './http'

// ModDB has no API and sits behind a bot check, so pages are read through NexusForge's hidden browser window.
const BASE = 'https://www.moddb.com'
const PARTITION = 'persist:web'

interface Row {
  path: string
  title: string
  image?: string
  date?: string
  subheading?: string
  summary?: string
}

/** ModDB list pages are a series of `div.row.rowcontent` blocks. */
export function parseRows(html: string, pathPrefix: RegExp): Row[] {
  const rows: Row[] = []
  for (const m of html.matchAll(/<div class="row rowcontent[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g)) {
    const block = m[1]
    const link = block.match(/<h4><a href="([^"]+)">([^<]+)<\/a><\/h4>/)
    if (!link || !pathPrefix.test(link[1])) continue
    const sub = block.match(/<span class="subheading">([\s\S]*?)<\/span>/)
    rows.push({
      path: link[1],
      title: decodeEntities(link[2]).trim(),
      image: block.match(/<img src="([^"]+)"/)?.[1],
      date: block.match(/<time datetime="([^"]+)"/)?.[1],
      subheading: sub ? toPlainText(sub[1].replace(/<a[^>]*class="commenticon"[^>]*>[\s\S]*?<\/a>/, '')).replace(/\s+/g, ' ').trim() : undefined,
      summary: toPlainText(block.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '')
    })
  }
  return rows
}

const meta = (html: string, prop: string) => html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1]

export function createModDbAdapter(ctx: AdapterContext): ModSourceAdapter {
  const page = (path: string) => ctx.browserHtml(path.startsWith('http') ? path : `${BASE}${path}`, PARTITION)

  const adapter: ModSourceAdapter = {
    id: 'moddb',
    name: 'ModDB',
    description: 'Total conversions, classic and RTS mods. No account needed. NexusForge reads ModDB through its built-in browser (ModDB blocks plain HTTP clients) and downloads files by itself.',
    homepage: BASE,
    bindingLabel: 'ModDB game',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      const found = new Map<string, { label: string; score: number }>()
      for (const term of gameNameVariants(game.name)) {
        const html = await page(`/games?filter=t&kw=${encodeURIComponent(term)}`)
        for (const r of parseRows(html, /^\/games\/[^/]+$/)) {
          found.set(r.path.split('/')[2], { label: r.title, score: nameScore(game.name, r.title) })
        }
        if ([...found.values()].some((v) => v.score >= 0.9)) break
      }
      return [...found.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([value, v]) => ({ value, label: v.label }))
    },

    // ModDB's "Popular Today" (rank today, by visits) is its trending list.
    sorts: ['relevance', 'endorsed', 'downloads', 'trending', 'newest', 'updated'],
    sortLabels: { endorsed: 'Rating', downloads: 'Downloads', trending: 'Popular Today', newest: 'Added', updated: 'Updated' },

    paged: true,

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      const slug = await ctx.binding(gameId)
      if (!slug) throw new Error(gameId ? 'This game is not on ModDB, or choose it in the game settings.' : 'Pick a game to search ModDB.')
      const q = query.trim()
      const SORT: Record<ModSort, string> = {
        relevance: q ? '' : 'visitstotal-desc',
        endorsed: 'rating-desc',
        downloads: 'downloadstotal-desc',
        downloads_recent: 'ranktoday-asc',
        trending: 'ranktoday-asc',
        newest: 'id-desc',
        updated: 'dateup-desc'
      }
      const sort = SORT[opts?.sort ?? (q ? 'relevance' : 'downloads')]
      const params = new URLSearchParams()
      if (q) {
        params.set('filter', 't')
        params.set('kw', q)
      }
      if (sort) params.set('sort', sort)
      const n = (opts?.page ?? 0) + 1
      // Past the last page ModDB shows its last page again; Browse stops when a page brings nothing new.
      const html = await page(`/games/${slug}/mods${n > 1 ? `/page/${n}` : ''}?${params}`)
      return parseRows(html, /^\/mods\/[^/]+$/).map((r) => ({
        id: r.path.split('/')[2],
        sourceId: 'moddb',
        name: r.title,
        summary: r.summary ?? '',
        thumbnail: r.image,
        updatedAt: r.date,
        url: `${BASE}${r.path}`
      }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const [html, downloads] = await Promise.all([page(`/mods/${modId}`), page(`/mods/${modId}/downloads`)])
      const description = html.match(/<div id="profiledescription"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1]
      const versions: ModVersion[] = parseRows(downloads, new RegExp(`^/mods/${modId}/downloads/[^/]+$`)).map((r, i) => ({
        id: r.path.split('/').pop()!,
        name: r.title,
        date: r.date,
        primary: i === 0,
        manualOnly: true,
        description: [r.subheading, r.summary].filter(Boolean).join(' · ') || undefined
      }))
      const title = decodeEntities(meta(html, 'og:title') ?? modId).replace(/ mod for .*$/, '')
      return {
        id: modId,
        sourceId: 'moddb',
        name: title,
        summary: decodeEntities(meta(html, 'og:description') ?? ''),
        thumbnail: meta(html, 'og:image'),
        url: `${BASE}/mods/${modId}`,
        description: toPlainText(description) || decodeEntities(meta(html, 'og:description') ?? ''),
        images: [meta(html, 'og:image')].filter(Boolean) as string[],
        versions
      }
    },

    async getDownload(modId, versionId): Promise<DownloadPlan> {
      const html = await page(`/mods/${modId}/downloads/${versionId}`)
      const start = html.match(/\/downloads\/start\/(\d+)/)?.[1]
      if (!start) throw new Error('ModDB did not offer a download for this file.')
      return {
        kind: 'browser',
        partition: PARTITION,
        pageUrl: `${BASE}/downloads/start/${start}`,
        hint: 'Getting the file from ModDB…',
        interactive: false,
        helper: 'moddb'
      }
    },

    async getDownloadUrl() {
      throw new Error('ModDB downloads go through its website; start them from NexusForge.')
    },

    getModPageUrl(modId) {
      return `${BASE}/mods/${modId}`
    }
  }
  return adapter
}
