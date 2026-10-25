import type { ModDependency, ModDetails, ModSearchResult, ModSort } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'

const API = 'https://api.modrinth.com/v2'

interface Hit {
  project_id: string
  slug: string
  title: string
  description: string
  author: string
  icon_url?: string
  downloads: number
  follows: number
  date_modified: string
  date_created?: string
  latest_version?: string
}

interface Project {
  id: string
  slug: string
  title: string
  description: string
  body: string
  icon_url?: string
  downloads: number
  followers: number
  updated: string
  categories: string[]
  gallery: { url: string }[]
}

interface Version {
  id: string
  name: string
  version_number: string
  date_published: string
  game_versions: string[]
  loaders: string[]
  featured: boolean
  files: { url: string; filename: string; size: number; primary: boolean }[]
  dependencies?: { project_id: string | null; version_id: string | null; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[]
  changelog?: string | null
}

export function createModrinthAdapter(ctx: AdapterContext): ModSourceAdapter {
  return {
    id: 'modrinth',
    name: 'Modrinth',
    description: 'Open-source Minecraft mod platform (mods, resource packs, shaders). Public API, no account needed.',
    homepage: 'https://modrinth.com',

    sorts: ['relevance', 'endorsed', 'downloads', 'newest', 'updated'],

    async search(query, _gameId, opts): Promise<ModSearchResult[]> {
      const INDEX: Partial<Record<ModSort, string>> = { relevance: 'relevance', endorsed: 'follows', downloads: 'downloads', newest: 'newest', updated: 'updated' }
      const index = INDEX[opts?.sort ?? (query ? 'relevance' : 'downloads')] ?? 'downloads'
      const res = await ctx.json<{ hits: Hit[] }>(`${API}/search?query=${encodeURIComponent(query)}&limit=40&index=${index}`)
      return res.hits.map((h) => ({
        id: h.project_id,
        sourceId: 'modrinth',
        name: h.title,
        summary: h.description,
        author: h.author,
        thumbnail: h.icon_url,
        downloads: h.downloads,
        endorsements: h.follows,
        updatedAt: h.date_modified,
        createdAt: h.date_created,
        url: `https://modrinth.com/project/${h.slug}`
      }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const [p, versions] = await Promise.all([ctx.json<Project>(`${API}/project/${modId}`), ctx.json<Version[]>(`${API}/project/${modId}/version`)])
      const depIds = [...new Set(versions.slice(0, 60).flatMap((v) => (v.dependencies ?? []).map((d) => d.project_id).filter(Boolean) as string[]))]
      const names = new Map<string, string>()
      if (depIds.length) {
        const projects = await ctx.json<Array<{ id: string; title: string }>>(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(depIds))}`).catch(() => [])
        for (const x of projects) names.set(x.id, x.title)
      }
      const deps = (v: Version): ModDependency[] =>
        (v.dependencies ?? [])
          .filter((d) => d.project_id && (d.dependency_type === 'required' || d.dependency_type === 'optional'))
          .map((d) => ({
            sourceId: 'modrinth',
            modId: d.project_id!,
            versionId: d.version_id ?? undefined,
            name: names.get(d.project_id!) ?? d.project_id!,
            required: d.dependency_type === 'required',
            installable: true,
            url: `https://modrinth.com/project/${d.project_id}`
          }))
      return {
        id: p.id,
        sourceId: 'modrinth',
        name: p.title,
        summary: p.description,
        thumbnail: p.icon_url,
        downloads: p.downloads,
        endorsements: p.followers,
        updatedAt: p.updated,
        url: `https://modrinth.com/project/${p.slug}`,
        description: p.body,
        images: p.gallery.map((g) => g.url).slice(0, 8),
        tags: p.categories,
        versions: versions.slice(0, 60).map((v, i) => {
          const file = v.files.find((f) => f.primary) ?? v.files[0]
          return {
            id: v.id,
            name: v.name,
            version: v.version_number,
            fileName: file?.filename,
            sizeBytes: file?.size,
            date: v.date_published,
            primary: i === 0,
            gameVersions: v.game_versions,
            loaders: v.loaders,
            dependencies: deps(v),
            description: v.changelog ? v.changelog.slice(0, 600) : undefined
          }
        })
      }
    },

    async resolveDependencies(_modId, versionId) {
      if (!versionId) return []
      const v = await ctx.json<Version>(`${API}/version/${versionId}`)
      const ids = (v.dependencies ?? []).filter((d) => d.project_id && (d.dependency_type === 'required' || d.dependency_type === 'optional')).map((d) => d.project_id!)
      const projects = ids.length ? await ctx.json<Array<{ id: string; title: string }>>(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`).catch(() => []) : []
      return (v.dependencies ?? [])
        .filter((d) => d.project_id && (d.dependency_type === 'required' || d.dependency_type === 'optional'))
        .map((d) => ({
          sourceId: 'modrinth',
          modId: d.project_id!,
          versionId: d.version_id ?? undefined,
          name: projects.find((p) => p.id === d.project_id)?.title ?? d.project_id!,
          required: d.dependency_type === 'required',
          installable: true
        }))
    },

    async getDownloadUrl(_modId, versionId) {
      const v = await ctx.json<Version>(`${API}/version/${versionId}`)
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      if (!file) throw new Error('This version has no files.')
      return file.url
    },

    getModPageUrl(modId) {
      return `https://modrinth.com/project/${modId}`
    }
  }
}
