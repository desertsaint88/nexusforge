import type { ModDependency, ModDetails, ModSearchResult, ModVersion, SourceGameBinding } from '@shared/types'
import type { AdapterContext, DownloadPlan, ModSourceAdapter } from './types'
import { HttpError, gameNameVariants, nameScore, normName, toPlainText } from './http'

const GQL = 'https://api.nexusmods.com/v2/graphql'
const V1 = 'https://api.nexusmods.com/v1'
export const NEXUS_PARTITION = 'persist:nexusmods'

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
  createdAt?: string
  updatedAt?: string
  uploader?: { name: string }
  game: { id: number; domainName: string; name?: string }
  modRequirements?: {
    nexusRequirements: { nodes: Array<{ modId: string; modName: string; gameId: string; url: string; notes?: string; externalRequirement: boolean }> }
  }
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
  description?: string
}

// Our mod ids carry what every later call needs: "<domain>/<numeric game id>/<mod id>".
const encodeId = (domain: string, gameNum: number | string, modId: number | string) => `${domain}/${gameNum}/${modId}`
function decodeId(id: string): { domain: string; gameNum: number; modId: number } {
  const [domain, g, m] = id.split('/')
  if (!domain || !g || !m) throw new Error(`Invalid Nexus Mods id: ${id}`)
  return { domain, gameNum: Number(g), modId: Number(m) }
}

/** "https://www.nexusmods.com/skyrimspecialedition/mods/12604" -> domain + mod id */
function parseModUrl(url: string): { domain: string; modId: string } | undefined {
  const m = url.match(/nexusmods\.com\/([a-z0-9]+)\/mods\/(\d+)/i)
  return m ? { domain: m[1].toLowerCase(), modId: m[2] } : undefined
}

/** nxm://<domain>/mods/<mod>/files/<file>?key=…&expires=…&user_id=… */
export function parseNxm(url: string): { domain: string; modId: string; fileId: string; key?: string; expires?: string } | undefined {
  const m = url.match(/^nxm:\/\/([^/]+)\/mods\/(\d+)\/files\/(\d+)/i)
  if (!m) return undefined
  const q = new URL(url.replace(/^nxm:/i, 'https:')).searchParams
  return { domain: m[1].toLowerCase(), modId: m[2], fileId: m[3], key: q.get('key') ?? undefined, expires: q.get('expires') ?? undefined }
}

export function createNexusAdapter(ctx: AdapterContext): ModSourceAdapter {
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const key = ctx.apiKey()
    const res = await ctx.json<{ data?: T; errors?: { message: string }[] }>(GQL, {
      method: 'POST',
      body: { query, variables },
      headers: key ? { apikey: key } : {}
    })
    if (res.errors?.length && !res.data) throw new Error(res.errors[0].message)
    return res.data as T
  }

  const gameIdCache = new Map<string, number>()
  async function gameNumber(domain: string): Promise<number | undefined> {
    if (gameIdCache.has(domain)) return gameIdCache.get(domain)
    const r = await gql<{ game: { id: number } | null }>('query($d: String!){ game(domainName: $d) { id } }', { d: domain }).catch(() => ({ game: null }))
    if (r.game) gameIdCache.set(domain, r.game.id)
    return r.game?.id
  }

  async function domain(gameId?: string): Promise<string> {
    const d = await ctx.binding(gameId)
    if (!d) throw new Error(gameId ? 'Choose the Nexus Mods game for this title in the game settings.' : 'Pick a game to search Nexus Mods.')
    return d
  }

  const detailsCache = new Map<string, { at: number; details: ModDetails }>()

  async function downloadLink(d: string, modId: string | number, fileId: string, extra = ''): Promise<string> {
    const key = ctx.apiKey()
    if (!key) throw new Error('NEXUS_NO_KEY')
    const links = await ctx.json<{ URI: string }[]>(`${V1}/games/${d}/mods/${modId}/files/${fileId}/download_link.json${extra}`, { headers: { apikey: key } })
    if (!links.length) throw new Error('Nexus Mods returned no download servers.')
    return links[0].URI
  }

  const adapter: ModSourceAdapter = {
    id: 'nexus',
    name: 'Nexus Mods',
    description:
      'The largest mod site. Search works without an account. For downloads, sign in once under Accounts (a free account works, created right inside NexusForge): the file page then opens in the download panel, you click “Slow download” and NexusForge installs the file. With Premium there is no click at all.',
    homepage: 'https://www.nexusmods.com',
    bindingLabel: 'Nexus Mods game',
    apiKey: 'optional',
    apiKeyUrl: 'https://next.nexusmods.com/settings/api-keys',

    async suggestBindings(game): Promise<SourceGameBinding[]> {
      const seen = new Map<string, { label: string; score: number }>()
      for (const term of gameNameVariants(game.name)) {
        const res = await gql<{ games: { nodes: { name: string; domainName: string }[] } }>(
          'query($n: String!){ games(filter: { name: [{ value: $n, op: WILDCARD }] }, count: 10) { nodes { name domainName } } }',
          { n: term }
        ).catch(() => ({ games: { nodes: [] } }))
        for (const g of res.games.nodes) {
          const score = nameScore(game.name, g.name)
          const prev = seen.get(g.domainName)
          if (!prev || prev.score < score) seen.set(g.domainName, { label: g.name, score })
        }
        // A confident match ends the search; otherwise try the shorter name.
        if ([...seen.values()].some((v) => v.score >= 0.9)) break
      }
      const out = [...seen.entries()].sort((a, b) => b[1].score - a[1].score).map(([value, v]) => ({ value, label: v.label }))
      const guess = normName(gameNameVariants(game.name)[1] ?? game.name)
      if (!out.length && guess) out.push({ value: guess, label: `${game.name} (guessed)` })
      return out
    },

    sorts: ['relevance', 'endorsed', 'downloads', 'downloads_recent', 'trending', 'newest', 'updated'],

    async search(query, gameId, opts): Promise<ModSearchResult[]> {
      const d = await domain(gameId)
      const q = query.trim()
      const sort = opts?.sort ?? (q ? 'relevance' : 'endorsed')
      const base: Record<string, unknown> = { gameDomainName: [{ value: d, op: 'EQUALS' }] }
      if (q) base.name = [{ value: q, op: 'WILDCARD' }]
      // Nexus' API takes dates as Unix seconds. Trending = best endorsed among new mods ("hot files"),
      // recent downloads = most downloaded among mods updated in the last 30 days.
      const since = (days: number) => [{ value: String(Math.floor(Date.now() / 1000) - days * 86400), op: 'GTE' }]
      const order: Record<string, { direction: 'DESC' }> =
        sort === 'downloads' || sort === 'downloads_recent' ? { downloads: { direction: 'DESC' } }
        : sort === 'newest' ? { createdAt: { direction: 'DESC' } }
        : sort === 'updated' ? { updatedAt: { direction: 'DESC' } }
        : sort === 'relevance' && q ? { relevance: { direction: 'DESC' } }
        : { endorsements: { direction: 'DESC' } }
      const run = async (extra: Record<string, unknown>) =>
        (
          await gql<{ mods: { nodes: GqlMod[] } }>(
            `query($f: ModsFilter, $s: [ModsSort!]){ mods(filter: $f, sort: $s, count: 48) { nodes {
              modId name summary author version downloads endorsements thumbnailUrl pictureUrl createdAt updatedAt uploader { name } game { id domainName }
            } } }`,
            { f: { ...base, ...extra }, s: [order] }
          )
        ).mods.nodes
      let nodes: GqlMod[]
      if (sort === 'trending') {
        // Quiet games have few new mods; widen the window until the list is worth showing.
        nodes = []
        for (const days of [14, 45, 120]) {
          nodes = await run({ createdAt: since(days) })
          if (nodes.length >= 12) break
        }
      } else if (sort === 'downloads_recent') {
        nodes = await run({ updatedAt: since(30) })
        if (nodes.length < 12) nodes = await run({ updatedAt: since(120) })
      } else nodes = await run({})
      return nodes.map((m) => ({
        id: encodeId(m.game.domainName, m.game.id, m.modId),
        sourceId: 'nexus',
        name: m.name,
        summary: toPlainText(m.summary),
        author: m.author || m.uploader?.name,
        thumbnail: m.thumbnailUrl || m.pictureUrl,
        downloads: m.downloads,
        endorsements: m.endorsements,
        updatedAt: m.updatedAt,
        createdAt: m.createdAt,
        version: m.version,
        url: `https://www.nexusmods.com/${m.game.domainName}/mods/${m.modId}`
      }))
    },

    async getModDetails(modId): Promise<ModDetails> {
      const hit = detailsCache.get(modId)
      if (hit && Date.now() - hit.at < 5 * 60_000) return hit.details
      const { domain: d, gameNum, modId: mid } = decodeId(modId)
      const res = await gql<{ legacyMods: { nodes: GqlMod[] }; modFiles: GqlFile[] }>(
        `query($m: Int!, $g: Int!, $mi: ID!, $gi: ID!){
          legacyMods(ids: [{ modId: $m, gameId: $g }]) { nodes {
            modId name summary description author version downloads endorsements pictureUrl updatedAt uploader { name } game { id domainName }
            modRequirements { nexusRequirements { nodes { modId modName gameId url notes externalRequirement } } }
          } }
          modFiles(modId: $mi, gameId: $gi) { fileId name version category sizeInBytes date uri primary description }
        }`,
        { m: mid, g: gameNum, mi: String(mid), gi: String(gameNum) }
      )
      const m = res.legacyMods.nodes[0]
      if (!m) throw new Error('Mod not found on Nexus Mods (it may be hidden or removed).')
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
        manualOnly: !ctx.apiKey(),
        description: [f.category !== 'MAIN' ? `${f.category.replace(/_/g, ' ').toLowerCase()} file` : '', toPlainText(f.description)].filter(Boolean).join(' · ') || undefined
      }))

      const requirements: ModDependency[] = []
      for (const r of m.modRequirements?.nexusRequirements.nodes ?? []) {
        const parsed = parseModUrl(r.url)
        if (r.externalRequirement || !parsed) {
          requirements.push({ sourceId: '', name: r.modName, required: true, installable: false, url: r.url, note: r.notes || 'External requirement, install it from its website' })
          continue
        }
        const num = String(r.gameId) === String(gameNum) ? gameNum : await gameNumber(parsed.domain)
        requirements.push({
          sourceId: 'nexus',
          modId: encodeId(parsed.domain, num ?? r.gameId, r.modId),
          name: r.modName,
          required: true,
          installable: true,
          url: r.url,
          note: r.notes || undefined
        })
      }

      const details: ModDetails = {
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
        requirements,
        tags: files.length ? [...new Set(files.map((f) => f.category.replace(/_/g, ' ').toLowerCase()))] : undefined
      }
      detailsCache.set(modId, { at: Date.now(), details })
      return details
    },

    async resolveDependencies(modId) {
      return (await adapter.getModDetails(modId)).requirements ?? []
    },

    async getDownload(modId, versionId): Promise<DownloadPlan> {
      const { domain: d, modId: mid } = decodeId(modId)
      if (ctx.apiKey()) {
        try {
          return { kind: 'url', url: await downloadLink(d, mid, versionId) }
        } catch (err) {
          // 403 = free account: the website click is required, handled below.
          if (!(err instanceof HttpError && err.status === 403)) throw err
        }
      }
      return {
        kind: 'browser',
        partition: NEXUS_PARTITION,
        pageUrl: `https://www.nexusmods.com/${d}/mods/${mid}?tab=files&file_id=${versionId}`,
        hint: 'Click the highlighted “Slow download” button. NexusForge downloads and installs the file by itself.',
        helper: 'nexus',
        resolveNxm: async (nxmUrl) => {
          const n = parseNxm(nxmUrl)
          if (!n) throw new Error('Unrecognized Nexus link')
          if (!ctx.apiKey()) throw new Error('NEXUS_NO_KEY')
          return downloadLink(n.domain, n.modId, n.fileId, `?key=${encodeURIComponent(n.key ?? '')}&expires=${encodeURIComponent(n.expires ?? '')}`)
        }
      }
    },

    async getDownloadUrl(modId, versionId) {
      const plan = await adapter.getDownload!(modId, versionId)
      if (plan.kind === 'url') return plan.url
      throw new Error('This file needs a click on the Nexus website; download it through NexusForge so it can open the page for you.')
    },

    getModPageUrl(modId) {
      const { domain: d, modId: mid } = decodeId(modId)
      return `https://www.nexusmods.com/${d}/mods/${mid}?tab=files`
    }
  }
  return adapter
}
