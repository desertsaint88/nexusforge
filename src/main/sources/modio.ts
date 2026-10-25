import type { ModDependency, ModDetails, ModSearchResult, ModSort, ModVersion, SourceGameBinding } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { gameNameVariants, nameScore, toPlainText } from './http'

const API = 'https://api.mod.io/v1'

interface MioMod {
  id: number
  game_id: number
  name: string
  name_id: string
  summary: string
  description_plaintext?: string
  profile_url: string
  date_updated: number
  date_added?: number
  submitted_by?: { username: string }
  logo?: { thumb_320x180?: string; thumb_640x360?: string; original?: string }
  media?: { images?: Array<{ original: string }> }
  stats?: { downloads_total?: number; ratings_positive?: number }
  modfile?: { id: number; version?: string }
  tags?: Array<{ name: string }>
}

interface MioFile {
  id: number
  filename: string
  version?: string
  filesize: number
  date_added: number
  changelog?: string
  metadata_blob?: string
  download: { binary_url: string }
}

export function createModioAdapter(ctx: AdapterContext): ModSourceAdapter {
  const key = () => {
    const k = ctx.apiKey()
    if (!k) throw new Error('mod.io needs a free API key: log in at mod.io, open "API access" and copy your read-only key into Settings › Sources.')
    return k
  }
  const get = <T>(path: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams({ api_key: key(), ...params })
    return ctx.json<T>(`${API}${path}?${q}`)
  }
  const split = (id: string) => {
    const [g, m] = id.split('/')
    if (!g || !m) throw new Error(`Invalid mod.io id: ${id}`)
    return { g, m }
  }
  const pageUrls = new Map<string, string>()
  const toResult = (m: MioMod): ModSearchResult => {
    pageUrls.set(`${m.game_id}/${m.id}`, m.profile_url)
    return {
      id: `${m.game_id}/${m.id}`,
      sourceId: 'modio',
      name: m.name,
      summary: m.summary,
      author: m.submitted_by?.username,
      thumbnail: m.logo?.thumb_320x180 ?? m.logo?.original,
      downloads: m.stats?.downloads_total,
      endorsements: m.stats?.ratings_positive,
      updatedAt: new Date(m.date_updated * 1000).toISOString(),
      createdAt: m.date_added ? new Date(m.date_added * 1000).toISOString() : undefined,
      version: m.modfile?.version,
      url: m.profile_url
    }
  }

  const adapter: ModSourceAdapter = {
    id: 'modio',
    name: 'mod.io',
    description: 'Cross-platform mods for games like SnowRunner, Deep Rock Galactic, Insurgency: Sandstorm and Ready or Not. Needs a free read-only API key from your mod.io account.',
    homepage: 'https://mod.io',
    bindingLabel: 'mod.io game',
    apiKey: 'required',
    apiKeyUrl: 'https://mod.io/me/access',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      const seen = new Map<number, { label: string; score: number }>()
      for (const term of gameNameVariants(game.name)) {
        const res = await get<{ data: Array<{ id: number; name: string }> }>('/games', { _q: term, _limit: '10' })
        for (const g of res.data) seen.set(g.id, { label: g.name, score: nameScore(game.name, g.name) })
        if ([...seen.values()].some((v) => v.score >= 0.9)) break
      }
      return [...seen.entries()].sort((a, b) => b[1].score - a[1].score).map(([id, v]) => ({ value: String(id), label: v.label }))
    },

    sorts: ['relevance', 'endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated'],

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      // Without a key the game lookup fails too; say what's actually missing.
      key()
      const g = await ctx.binding(gameId)
      if (!g) throw new Error(gameId ? 'This game is not on mod.io, or choose it in the game settings.' : 'Pick a game to search mod.io.')
      // mod.io's "popular" ranks by today's downloads, which is both its trending list and "recent downloads".
      const SORT: Record<ModSort, string> = {
        relevance: '-popular',
        endorsed: '-rating',
        downloads: '-downloads_total',
        downloads_recent: '-popular',
        trending: '-popular',
        newest: '-date_live',
        updated: '-date_updated'
      }
      const params: Record<string, string> = { _limit: '48', _sort: SORT[opts?.sort ?? (query.trim() ? 'relevance' : 'downloads')] }
      if (query.trim()) params._q = query.trim()
      const res = await get<{ data: MioMod[] }>(`/games/${g}/mods`, params)
      return res.data.map(toResult)
    },

    async getModDetails(modId): Promise<ModDetails> {
      const { g, m } = split(modId)
      const [mod, files, deps] = await Promise.all([
        get<MioMod>(`/games/${g}/mods/${m}`),
        get<{ data: MioFile[] }>(`/games/${g}/mods/${m}/files`, { _sort: '-date_added', _limit: '30' }),
        get<{ data: Array<{ mod_id: number; name?: string }> }>(`/games/${g}/mods/${m}/dependencies`).catch(() => ({ data: [] }))
      ])
      const requirements: ModDependency[] = deps.data.map((d) => ({
        sourceId: 'modio',
        modId: `${g}/${d.mod_id}`,
        name: d.name ?? `mod.io mod ${d.mod_id}`,
        required: true,
        installable: true
      }))
      const versions: ModVersion[] = files.data.map((f, i) => ({
        id: String(f.id),
        name: f.filename,
        version: f.version,
        fileName: f.filename,
        sizeBytes: f.filesize,
        date: new Date(f.date_added * 1000).toISOString(),
        primary: mod.modfile ? f.id === mod.modfile.id : i === 0,
        description: [toPlainText(f.changelog), f.metadata_blob].filter(Boolean).join('\n') || undefined
      }))
      return {
        ...toResult(mod),
        description: mod.description_plaintext ?? mod.summary,
        images: [mod.logo?.original, ...(mod.media?.images?.map((i) => i.original) ?? [])].filter(Boolean).slice(0, 8) as string[],
        tags: mod.tags?.map((t) => t.name),
        versions,
        requirements
      }
    },

    async resolveDependencies(modId) {
      return (await adapter.getModDetails(modId)).requirements ?? []
    },

    async getDownloadUrl(modId, versionId) {
      const { g, m } = split(modId)
      const f = await get<MioFile>(`/games/${g}/mods/${m}/files/${versionId}`)
      return f.download.binary_url
    },

    getModPageUrl(modId) {
      return pageUrls.get(modId)
    }
  }
  return adapter
}
