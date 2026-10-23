import type { ModDetails, ModSearchResult, ModVersion, SourceGameBinding } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { HttpError, normName, toPlainText } from './http'

const GQL = 'https://api.nexusmods.com/v2/graphql'
const V1 = 'https://api.nexusmods.com/v1'

interface GqlMod {
  modId: number
  name: string
  summary?: string
  description?: string
  author?: string
  version?: string
  downloads?: number
  endorsements?: number
  pictureUrl?: string
  thumbnailUrl?: string
  updatedAt?: string
  uploader?: { name: string }
  game: { id: number; domainName: string; name?: string }
}

interface GqlFile {
  fileId: number
  name: string
  version?: string
  category: string
  sizeInBytes?: string
  date: number
  uri: string
  primary: number
}

// Our mod ids carry what every later call needs: "<domain>/<numeric game id>/<mod id>".
const encodeId = (m: GqlMod) => `${m.game.domainName}/${m.game.id}/${m.modId}`
function decodeId(id: string): { domain: string; gameNum: number; modId: number } {
  const [domain, g, m] = id.split('/')
  if (!domain || !g || !m) throw new Error(`Invalid Nexus Mods id: ${id}`)
  return { domain, gameNum: Number(g), modId: Number(m) }
}

/** "Grand Theft Auto V" -> "grandtheftautov". Matches Nexus domains for most games. */
function guessDomain(name: string): string {
  return normName(name.replace(/\b(game of the year|goty|definitive|enhanced|remastered|edition)\b/gi, ''))
}

export function createNexusAdapter(ctx: AdapterContext): ModSourceAdapter {
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const key = ctx.apiKey()
    const res = await ctx.json<{ data?: T; errors?: { message: string }[] }>(GQL, {
      method: 'POST',
      body: { query, variables },
      headers: key ? { apikey: key } : {}
    })
    if (res.errors?.length) throw new Error(res.errors[0].message)
    return res.data as T
  }

  async function domain(gameId?: string): Promise<string> {
    const d = await ctx.binding(gameId)
    if (!d) throw new Error(gameId ? 'Choose the Nexus Mods game for this title in the game settings.' : 'Pick a game to search Nexus Mods.')
    return d
  }

  return {
    id: 'nexus',
    name: 'Nexus Mods',
    description: 'The largest mod site. Searching works without an account. Direct downloads need a Premium API key; otherwise NexusForge opens the file page so you can download it there.',
    homepage: 'https://www.nexusmods.com',
    bindingLabel: 'Nexus Mods game domain',
    apiKey: 'optional',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      const term = game.name.replace(/[™®©:]/g, '').trim()
      const res = await gql<{ games: { nodes: { name: string; domainName: string }[] } }>(
        'query($n: String!){ games(filter: { name: [{ value: $n, op: WILDCARD }] }, count: 8) { nodes { name domainName } } }',
        { n: term }
      ).catch(() => ({ games: { nodes: [] } }))
      const nodes = res.games.nodes
      const n = normName(term)
      nodes.sort((a, b) => Number(normName(b.name) === n) - Number(normName(a.name) === n))
      const out = nodes.map((g) => ({ value: g.domainName, label: g.name }))
      const guess = guessDomain(game.name)
      if (!out.some((o) => o.value === guess)) out.push({ value: guess, label: `${game.name} (guessed)` })
      return out
    },

    async search(query, gameId): Promise<ModSearchResult[]> {
      const d = await domain(gameId)
      const filter: Record<string, unknown> = { gameDomainName: [{ value: d, op: 'EQUALS' }] }
      if (query.trim()) filter.name = [{ value: query.trim(), op: 'WILDCARD' }]
      const res = await gql<{ mods: { nodes: GqlMod[] } }>(
        `query($f: ModsFilter, $s: [ModsSort!]){ mods(filter: $f, sort: $s, count: 40) { nodes {
          modId name summary author version downloads endorsements thumbnailUrl pictureUrl updatedAt uploader { name } game { id domainName }
        } } }`,
        { f: filter, s: [{ endorsements: { direction: 'DESC' } }] }
      )
      return res.mods.nodes.map((m) => ({
        id: encodeId(m),
        sourceId: 'nexus',
        name: m.name,
        summary: toPlainText(m.summary),
        author: m.author || m.uploader?.name,
        thumbnail: m.thumbnailUrl || m.pictureUrl,
        downloads: m.downloads,
        endorsements: m.endorsements,
        updatedAt: m.updatedAt,
        version: m.version,
        url: `https://www.nexusmods.com/${m.game.domainName}/mods/${m.modId}`
      }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const { domain: d, gameNum, modId: mid } = decodeId(modId)
      const res = await gql<{ legacyMods: { nodes: GqlMod[] }; modFiles: GqlFile[] }>(
        `query($m: Int!, $g: Int!, $mi: ID!, $gi: ID!){
          legacyMods(ids: [{ modId: $m, gameId: $g }]) { nodes { modId name summary description author version downloads endorsements pictureUrl updatedAt uploader { name } game { id domainName } } }
          modFiles(modId: $mi, gameId: $gi) { fileId name version category sizeInBytes date uri primary }
        }`,
        { m: mid, g: gameNum, mi: String(mid), gi: String(gameNum) }
      )
      const m = res.legacyMods.nodes[0]
      if (!m) throw new Error('Mod not found on Nexus Mods (it may be hidden or removed).')
      const canDownload = Boolean(ctx.apiKey())
      const files = res.modFiles
        .filter((f) => f.category !== 'ARCHIVED' && f.category !== 'DELETED')
        .sort((a, b) => Number(b.category === 'MAIN') - Number(a.category === 'MAIN') || b.date - a.date)
      const versions: ModVersion[] = files.map((f) => ({
        id: String(f.fileId),
        name: f.name,
        version: f.version,
        fileName: f.uri,
        sizeBytes: f.sizeInBytes ? Number(f.sizeInBytes) : undefined,
        date: new Date(f.date * 1000).toISOString(),
        primary: f.category === 'MAIN',
        manualOnly: !canDownload
      }))
      return {
        id: modId,
        sourceId: 'nexus',
        name: m.name,
        summary: toPlainText(m.summary),
        author: m.author || m.uploader?.name,
        thumbnail: m.pictureUrl,
        downloads: m.downloads,
        endorsements: m.endorsements,
        updatedAt: m.updatedAt,
        version: m.version,
        url: `https://www.nexusmods.com/${d}/mods/${mid}`,
        description: toPlainText(m.description),
        images: m.pictureUrl ? [m.pictureUrl] : [],
        versions,
        tags: files.length ? [...new Set(files.map((f) => f.category.replace(/_/g, ' ').toLowerCase()))] : undefined
      }
    },

    async getDownloadUrl(modId, versionId) {
      const key = ctx.apiKey()
      const { domain: d, modId: mid } = decodeId(modId)
      if (!key) throw new Error('NEXUS_MANUAL')
      try {
        const links = await ctx.json<{ URI: string; short_name: string }[]>(`${V1}/games/${d}/mods/${mid}/files/${versionId}/download_link.json`, {
          headers: { apikey: key }
        })
        if (!links.length) throw new Error('Nexus Mods returned no download servers.')
        return links[0].URI
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) throw new Error('NEXUS_MANUAL')
        throw err
      }
    },

    getModPageUrl(modId) {
      const { domain: d, modId: mid } = decodeId(modId)
      return `https://www.nexusmods.com/${d}/mods/${mid}?tab=files`
    }
  }
}
