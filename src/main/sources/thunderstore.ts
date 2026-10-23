import type { ModDetails, ModSearchResult, SourceGameBinding } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { normName } from './http'

const BASE = 'https://thunderstore.io'

interface ListingItem {
  namespace: string
  name: string
  description: string
  download_count: number
  rating_count: number
  icon_url?: string
  last_updated: string
  is_deprecated: boolean
  is_nsfw: boolean
  community_identifier: string
  size?: number
}

interface PackageInfo {
  namespace: string
  name: string
  owner: string
  package_url: string
  latest: {
    version_number: string
    description: string
    icon: string
    dependencies: string[]
    download_url: string
    downloads: number
    date_created: string
    website_url?: string
  }
}

interface VersionInfo {
  version_number: string
  datetime_created: string
  download_count: number
  download_url: string
}

interface Community {
  identifier: string
  name: string
}

let communityCache: { at: number; list: Community[] } | undefined

export function createThunderstoreAdapter(ctx: AdapterContext): ModSourceAdapter {
  async function communities(): Promise<Community[]> {
    if (communityCache && Date.now() - communityCache.at < 24 * 3600_000) return communityCache.list
    const list: Community[] = []
    let url: string | null = `${BASE}/api/experimental/community/`
    for (let page = 0; url && page < 20; page++) {
      const res: { pagination: { next_link: string | null }; results: Community[] } = await ctx.json(url)
      list.push(...res.results)
      url = res.pagination.next_link
    }
    communityCache = { at: Date.now(), list }
    return list
  }

  async function community(gameId?: string): Promise<string> {
    const c = await ctx.binding(gameId)
    if (!c) throw new Error(gameId ? 'This game has no Thunderstore community. Choose one in the game settings.' : 'Pick a game to search Thunderstore.')
    return c
  }

  const parseId = (modId: string) => {
    const [namespace, name] = modId.split('/')
    if (!namespace || !name) throw new Error(`Invalid Thunderstore id: ${modId}`)
    return { namespace, name }
  }

  return {
    id: 'thunderstore',
    name: 'Thunderstore',
    description: 'Community mod repository for Valheim, Lethal Company, Risk of Rain 2 and 200+ Unity games. Installs into BepInEx automatically.',
    homepage: BASE,
    bindingLabel: 'Thunderstore community',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      const n = normName(game.name)
      const list = await communities()
      const exact = list.filter((c) => normName(c.name) === n || c.identifier === n)
      const partial = list.filter((c) => !exact.includes(c) && (normName(c.name).includes(n) || (n.length > 4 && n.includes(normName(c.name)))))
      return [...exact, ...partial].slice(0, 8).map((c) => ({ value: c.identifier, label: c.name }))
    },

    async search(query, gameId): Promise<ModSearchResult[]> {
      const c = await community(gameId)
      const url = `${BASE}/api/cyberstorm/listing/${encodeURIComponent(c)}/?q=${encodeURIComponent(query)}&ordering=${query ? 'most-downloaded' : 'top-rated'}&page_size=48`
      const res = await ctx.json<{ results: ListingItem[] }>(url)
      return res.results
        .filter((r) => !r.is_nsfw && !r.is_deprecated)
        .map((r) => ({
          id: `${r.namespace}/${r.name}`,
          sourceId: 'thunderstore',
          name: r.name.replace(/_/g, ' '),
          summary: r.description,
          author: r.namespace,
          thumbnail: r.icon_url,
          downloads: r.download_count,
          endorsements: r.rating_count,
          updatedAt: r.last_updated,
          url: `${BASE}/c/${c}/p/${r.namespace}/${r.name}/`
        }))
    },

    async getModDetails(modId, gameId): Promise<ModDetails> {
      const { namespace, name } = parseId(modId)
      const pkg = await ctx.json<PackageInfo>(`${BASE}/api/experimental/package/${namespace}/${name}/`)
      const versions = await ctx.json<VersionInfo[]>(`${BASE}/api/cyberstorm/package/${namespace}/${name}/versions/`).catch(() => [] as VersionInfo[])
      let readme = ''
      try {
        readme = (await ctx.json<{ markdown: string }>(`${BASE}/api/experimental/package/${namespace}/${name}/${pkg.latest.version_number}/readme/`)).markdown
      } catch {
        // some packages have no readme
      }
      const c = await ctx.binding(gameId).catch(() => undefined)
      return {
        id: modId,
        sourceId: 'thunderstore',
        name: name.replace(/_/g, ' '),
        summary: pkg.latest.description,
        author: pkg.owner,
        thumbnail: pkg.latest.icon,
        downloads: pkg.latest.downloads,
        version: pkg.latest.version_number,
        updatedAt: pkg.latest.date_created,
        url: c ? `${BASE}/c/${c}/p/${namespace}/${name}/` : pkg.package_url,
        description: readme || pkg.latest.description,
        images: [],
        tags: pkg.latest.dependencies.length ? pkg.latest.dependencies.map((d) => `Requires ${d}`) : undefined,
        versions: (versions.length ? versions : [{ version_number: pkg.latest.version_number, datetime_created: pkg.latest.date_created, download_count: 0, download_url: pkg.latest.download_url }])
          .sort((a, b) => b.datetime_created.localeCompare(a.datetime_created))
          .map((v, i) => ({ id: v.version_number, name: `${name.replace(/_/g, ' ')} ${v.version_number}`, version: v.version_number, date: v.datetime_created, primary: i === 0, fileName: `${namespace}-${name}-${v.version_number}.zip` }))
      }
    },

    async getDownloadUrl(modId, versionId) {
      const { namespace, name } = parseId(modId)
      return `${BASE}/package/download/${namespace}/${name}/${versionId}/`
    },

    getModPageUrl(modId) {
      const { namespace, name } = parseId(modId)
      return `${BASE}/package/${namespace}/${name}/`
    }
  }
}
