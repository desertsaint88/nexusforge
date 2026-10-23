import type { ModDetails, ModSearchResult } from '@shared/types'
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
}

export function createModrinthAdapter(ctx: AdapterContext): ModSourceAdapter {
  return {
    id: 'modrinth',
    name: 'Modrinth',
    description: 'Open-source Minecraft mod platform (mods, resource packs, shaders). Public API, no account needed.',
    homepage: 'https://modrinth.com',

    async search(query): Promise<ModSearchResult[]> {
      const res = await ctx.json<{ hits: Hit[] }>(`${API}/search?query=${encodeURIComponent(query)}&limit=40&index=${query ? 'relevance' : 'downloads'}`)
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
        url: `https://modrinth.com/project/${h.slug}`
      }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const [p, versions] = await Promise.all([ctx.json<Project>(`${API}/project/${modId}`), ctx.json<Version[]>(`${API}/project/${modId}/version`)])
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
            name: `${v.name} (${[...v.loaders, ...v.game_versions.slice(-2)].join(', ')})`,
            version: v.version_number,
            fileName: file?.filename,
            sizeBytes: file?.size,
            date: v.date_published,
            primary: i === 0
          }
        })
      }
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
