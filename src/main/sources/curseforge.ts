import type { ModDependency, ModDetails, ModSearchResult, ModSort, ModVersion, SourceGameBinding } from '@shared/types'
import type { AdapterContext, DownloadPlan, ModSourceAdapter } from './types'
import { gameNameVariants, nameScore, toPlainText } from './http'

const API = 'https://api.curseforge.com/v1'

interface CfMod {
  id: number
  gameId: number
  name: string
  slug: string
  summary: string
  downloadCount: number
  thumbsUpCount?: number
  dateModified: string
  dateCreated?: string
  links?: { websiteUrl?: string }
  authors?: Array<{ name: string }>
  logo?: { thumbnailUrl?: string; url?: string }
  screenshots?: Array<{ url: string }>
  categories?: Array<{ name: string }>
  allowModDistribution?: boolean | null
}

interface CfFile {
  id: number
  displayName: string
  fileName: string
  fileLength: number
  fileDate: string
  releaseType: number
  gameVersions: string[]
  dependencies: Array<{ modId: number; relationType: number }>
  downloadUrl: string | null
}

// relationType: 1 embedded, 2 optional, 3 required, 4 tool, 5 incompatible, 6 include
const REQUIRED = 3
const OPTIONAL = 2

export function createCurseForgeAdapter(ctx: AdapterContext): ModSourceAdapter {
  const headers = () => {
    const k = ctx.apiKey()
    if (!k) throw new Error('CurseForge needs an API key. Request a free one at console.curseforge.com and paste it into Settings › Sources.')
    return { 'x-api-key': k }
  }
  const get = <T>(path: string) => ctx.json<T>(`${API}${path}`, { headers: headers() })
  let games: Array<{ id: number; name: string; slug: string }> | undefined
  const pages = new Map<string, string>()

  const toResult = (m: CfMod): ModSearchResult => {
    if (m.links?.websiteUrl) pages.set(String(m.id), m.links.websiteUrl)
    return {
      id: String(m.id),
      sourceId: 'curseforge',
      name: m.name,
      summary: m.summary,
      author: m.authors?.[0]?.name,
      thumbnail: m.logo?.thumbnailUrl ?? m.logo?.url,
      downloads: m.downloadCount,
      endorsements: m.thumbsUpCount,
      updatedAt: m.dateModified,
      createdAt: m.dateCreated,
      url: m.links?.websiteUrl
    }
  }

  async function names(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map()
    const res = await ctx.json<{ data: CfMod[] }>(`${API}/mods`, { method: 'POST', body: { modIds: ids }, headers: headers() })
    return new Map(res.data.map((m) => [m.id, m.name]))
  }

  const adapter: ModSourceAdapter = {
    id: 'curseforge',
    name: 'CurseForge',
    description: 'Minecraft, World of Warcraft, The Sims 4, Stardew Valley and more. Needs a CurseForge API key (free, from console.curseforge.com).',
    homepage: 'https://www.curseforge.com',
    bindingLabel: 'CurseForge game',
    apiKey: 'required',
    apiKeyUrl: 'https://console.curseforge.com/',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      if (!games) {
        games = []
        for (let index = 0; index < 1000; index += 50) {
          const res = await get<{ data: Array<{ id: number; name: string; slug: string }>; pagination: { totalCount: number } }>(`/games?index=${index}&pageSize=50`)
          games.push(...res.data)
          if (index + 50 >= res.pagination.totalCount) break
        }
      }
      const variants = gameNameVariants(game.name)
      return games
        .map((g) => ({ g, score: Math.max(...variants.map((v) => nameScore(v, g.name))) }))
        .filter((x) => x.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map(({ g }) => ({ value: String(g.id), label: g.name }))
    },

    sorts: ['relevance', 'endorsed', 'downloads', 'trending', 'newest', 'updated'],
    sortLabels: { endorsed: 'Rating', downloads: 'Total Downloads', trending: 'Popularity', newest: 'Creation Date', updated: 'Last Updated' },

    paged: true,
    pageSize: 48,

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      const g = await ctx.binding(gameId)
      if (!g) throw new Error(gameId ? 'This game is not on CurseForge, or choose it in the game settings.' : 'Pick a game to search CurseForge.')
      // CurseForge sort fields: 1 featured, 2 popularity (recent downloads), 3 last updated, 6 total downloads, 11 released, 12 rating.
      const FIELD: Record<ModSort, number> = { relevance: 1, endorsed: 12, downloads: 6, downloads_recent: 2, trending: 2, newest: 11, updated: 3 }
      const field = FIELD[opts?.sort ?? (query.trim() ? 'relevance' : 'downloads')]
      const res = await get<{ data: CfMod[] }>(`/mods/search?gameId=${g}&searchFilter=${encodeURIComponent(query.trim())}&sortField=${field}&sortOrder=desc&pageSize=48&index=${(opts?.page ?? 0) * 48}`)
      return res.data.map(toResult)
    },

    async getModDetails(modId): Promise<ModDetails> {
      const [mod, desc, files] = await Promise.all([
        get<{ data: CfMod }>(`/mods/${modId}`),
        get<{ data: string }>(`/mods/${modId}/description`).catch(() => ({ data: '' })),
        get<{ data: CfFile[] }>(`/mods/${modId}/files?pageSize=40`)
      ])
      const depIds = [...new Set(files.data.flatMap((f) => f.dependencies.filter((d) => d.relationType === REQUIRED || d.relationType === OPTIONAL).map((d) => d.modId)))]
      const depNames = await names(depIds).catch(() => new Map<number, string>())
      const versions: ModVersion[] = files.data.map((f, i) => ({
        id: String(f.id),
        name: f.displayName,
        fileName: f.fileName,
        sizeBytes: f.fileLength,
        date: f.fileDate,
        primary: i === 0,
        gameVersions: f.gameVersions,
        manualOnly: !f.downloadUrl,
        description: f.releaseType === 2 ? 'Beta' : f.releaseType === 3 ? 'Alpha' : undefined,
        dependencies: f.dependencies
          .filter((d) => d.relationType === REQUIRED || d.relationType === OPTIONAL)
          .map((d): ModDependency => ({
            sourceId: 'curseforge',
            modId: String(d.modId),
            name: depNames.get(d.modId) ?? `CurseForge mod ${d.modId}`,
            required: d.relationType === REQUIRED,
            installable: true
          }))
      }))
      return {
        ...toResult(mod.data),
        description: toPlainText(desc.data),
        images: [mod.data.logo?.url, ...(mod.data.screenshots?.map((s) => s.url) ?? [])].filter(Boolean).slice(0, 8) as string[],
        tags: mod.data.categories?.map((c) => c.name),
        gameVersions: [...new Set(files.data.flatMap((f) => f.gameVersions))].slice(0, 20),
        versions
      }
    },

    async resolveDependencies(modId, versionId) {
      const d = await adapter.getModDetails(modId)
      const v = d.versions.find((x) => x.id === versionId) ?? d.versions[0]
      return v?.dependencies ?? []
    },

    async getDownload(modId, versionId): Promise<DownloadPlan> {
      const f = await get<{ data: CfFile }>(`/mods/${modId}/files/${versionId}`)
      if (f.data.downloadUrl) return { kind: 'url', url: f.data.downloadUrl, fileName: f.data.fileName }
      // The author turned off third-party downloads: the user downloads it on the site, NexusForge catches the file.
      const page = pages.get(modId)
      if (!page) throw new Error('This file can only be downloaded on the CurseForge website.')
      return { kind: 'browser', partition: 'persist:curseforge', pageUrl: `${page}/download/${versionId}`, hint: 'Download the file in the CurseForge window; NexusForge installs it automatically.' }
    },

    async getDownloadUrl(modId, versionId) {
      const plan = await adapter.getDownload!(modId, versionId)
      if (plan.kind === 'url') return plan.url
      throw new Error('This file can only be downloaded on the CurseForge website.')
    },

    getModPageUrl(modId) {
      return pages.get(modId)
    }
  }
  return adapter
}
