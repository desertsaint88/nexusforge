import { shell } from 'electron'
import type { FeedConfig, ModDependency, ModDetails, ModSearchResult, PluginInfo, ResolvedDependency, SourceGameBinding, SourceInfo } from '@shared/types'
import type { AdapterContext, DownloadPlan, ModSourceAdapter } from './types'
import { httpJson, httpText } from './http'
import { createThunderstoreAdapter } from './thunderstore'
import { createNexusAdapter } from './nexus'
import { createModrinthAdapter } from './modrinth'
import { createSteamWorkshopAdapter } from './steamworkshop'
import { createModioAdapter } from './modio'
import { createCurseForgeAdapter } from './curseforge'
import { createModDbAdapter } from './moddb'
import { createBeamngAdapter } from './beamng'
import { createFrameworksAdapter, frameworkDependency, frameworkPresent, FRAMEWORKS_ID } from './frameworks'
import { browserHtml } from '../web/browser'
import { listMods } from '../mods/manager'
import { activeProfile } from '../mods/profiles'
import { createFeedAdapter } from './feed'
import { discoverPlugins, loadPlugin, pluginInfo, type DiscoveredPlugin } from './plugins'
import { getApiKey, getSettings, hasApiKey, isSourceEnabled, setSettings } from '../store'
import { getGame } from '../library/library'
import { paths } from '../paths'
import { scoped } from '../logger'
import { shortId } from '../util/fs'

const log = scoped('sources')

interface Registered {
  adapter: ModSourceAdapter
  kind: SourceInfo['kind']
}

const adapters = new Map<string, Registered>()
const suggestionCache = new Map<string, SourceGameBinding[]>()
let discovered: DiscoveredPlugin[] = []
const pluginErrors = new Map<string, string>()

function contextFor(sourceId: string): AdapterContext {
  const ctx: AdapterContext = {
    getGame,
    apiKey: () => getApiKey(sourceId),
    json: httpJson,
    text: httpText,
    browserHtml: (url, partition) => browserHtml(url, partition),
    log: scoped(sourceId),
    async binding(gameId) {
      if (!gameId) return undefined
      const game = getGame(gameId)
      if (!game) return undefined
      const chosen = game.modding.sources[sourceId]
      if (chosen) return chosen
      const suggestions = await suggest(sourceId, gameId)
      return suggestions[0]?.value
    }
  }
  return ctx
}

async function suggest(sourceId: string, gameId: string): Promise<SourceGameBinding[]> {
  const key = `${sourceId}|${gameId}`
  const hit = suggestionCache.get(key)
  if (hit) return hit
  const reg = adapters.get(sourceId)
  const game = getGame(gameId)
  if (!reg?.adapter.suggestBindings || !game) return []
  try {
    const list = await reg.adapter.suggestBindings(game)
    suggestionCache.set(key, list)
    return list
  } catch (err) {
    log.warn(`binding suggestions failed for ${sourceId}/${game.name}: ${(err as Error).message}`)
    return []
  }
}

function register(adapter: ModSourceAdapter, kind: SourceInfo['kind']): void {
  if (adapters.has(adapter.id)) {
    log.warn(`duplicate source id ${adapter.id} ignored`)
    return
  }
  adapters.set(adapter.id, { adapter, kind })
}

export async function loadSources(): Promise<void> {
  for (const { adapter } of adapters.values()) adapter.dispose?.()
  adapters.clear()
  suggestionCache.clear()
  pluginErrors.clear()
  register(createNexusAdapter(contextFor('nexus')), 'builtin')
  register(createSteamWorkshopAdapter(contextFor('steamworkshop')), 'builtin')
  register(createThunderstoreAdapter(contextFor('thunderstore')), 'builtin')
  register(createModioAdapter(contextFor('modio')), 'builtin')
  register(createCurseForgeAdapter(contextFor('curseforge')), 'builtin')
  register(createModDbAdapter(contextFor('moddb')), 'builtin')
  register(createBeamngAdapter(contextFor('beamng')), 'builtin')
  register(createModrinthAdapter(contextFor('modrinth')), 'builtin')
  register(createFrameworksAdapter(contextFor(FRAMEWORKS_ID)), 'builtin')
  const settings = getSettings()
  for (const feed of settings.feeds) {
    if (feed.enabled) register(createFeedAdapter(feed, contextFor(`feed:${feed.id}`)), 'feed')
  }
  discovered = await discoverPlugins(paths.plugins())
  for (const p of discovered) {
    if (settings.trustedPlugins[p.id] !== p.hash) continue
    try {
      register(await loadPlugin(p, contextFor(p.id)), 'plugin')
      log.info(`loaded plugin ${p.id} (${p.name} ${p.version ?? ''})`)
    } catch (err) {
      pluginErrors.set(p.id, (err as Error).message)
      log.error(`plugin ${p.id} failed to load`, err)
    }
  }
}

export function listSources(): SourceInfo[] {
  const out: SourceInfo[] = []
  for (const { adapter, kind } of adapters.values()) {
    out.push({
      id: adapter.id,
      name: adapter.name,
      description: adapter.description ?? '',
      kind,
      enabled: isSourceEnabled(adapter.id),
      apiKey: adapter.apiKey,
      hasKey: adapter.apiKey ? hasApiKey(adapter.id) : undefined,
      homepage: adapter.homepage,
      bindingLabel: adapter.bindingLabel,
      apiKeyUrl: adapter.apiKeyUrl
    })
  }
  return out
}

function adapterFor(id: string): ModSourceAdapter {
  const reg = adapters.get(id)
  if (!reg) throw new Error(`Unknown mod source: ${id}`)
  if (!isSourceEnabled(id)) throw new Error(`${reg.adapter.name} is disabled in settings.`)
  return reg.adapter
}

async function guarded<T>(id: string, what: string, fn: (a: ModSourceAdapter) => Promise<T>): Promise<T> {
  const adapter = adapterFor(id)
  try {
    return await fn(adapter)
  } catch (err) {
    const msg = (err as Error).message
    log.warn(`${id} ${what} failed: ${msg}`)
    throw new Error(`${adapter.name}: ${msg}`)
  }
}

// Results are re-stamped with the registered id: plugins don't know they were namespaced as "plugin:<folder>".
export async function searchSource(id: string, query: string, gameId?: string): Promise<ModSearchResult[]> {
  const results = await guarded(id, 'search', (a) => a.search(query, gameId))
  return results.map((r) => ({ ...r, sourceId: id }))
}

export async function sourceDetails(id: string, modId: string, gameId?: string): Promise<ModDetails> {
  return { ...(await guarded(id, 'details', (a) => a.getModDetails(modId, gameId))), sourceId: id }
}

/** How to get a file: plain URL, a click in NexusForge's browser window, or a SteamCMD job. */
export function sourceDownloadPlan(id: string, modId: string, versionId: string, gameId?: string): Promise<DownloadPlan> {
  return guarded(id, 'download', async (a) =>
    a.getDownload ? a.getDownload(modId, versionId, gameId) : { kind: 'url' as const, url: await a.getDownloadUrl(modId, versionId, gameId) }
  )
}

/** Latest (primary) version of a mod, for dependencies that don't pin one. */
export async function latestVersionId(id: string, modId: string, gameId?: string): Promise<string> {
  const d = await sourceDetails(id, modId, gameId)
  const v = d.versions.find((x) => x.primary) ?? d.versions[0]
  if (!v) throw new Error(`${d.name} has no downloadable files.`)
  return v.id
}

async function directDependencies(id: string, modId: string, versionId: string | undefined, gameId?: string): Promise<ModDependency[]> {
  const adapter = adapterFor(id)
  let deps: ModDependency[]
  if (adapter.resolveDependencies) deps = await adapter.resolveDependencies(modId, versionId, gameId)
  else {
    const d = await adapter.getModDetails(modId, gameId)
    deps = (versionId ? d.versions.find((v) => v.id === versionId)?.dependencies : undefined) ?? d.requirements ?? []
  }
  // Loaders the site only links to (BepInEx, MelonLoader) are installed by NexusForge itself.
  return isSourceEnabled(FRAMEWORKS_ID) ? deps.map((d) => frameworkDependency(d) ?? d) : deps
}

/**
 * Everything a mod needs, recursively, marked as installed / disabled / missing for the given game.
 * Installed dependencies are not expanded further.
 */
export async function resolveDependencies(id: string, modId: string, versionId: string | undefined, gameId?: string): Promise<ResolvedDependency[]> {
  const installed = gameId ? listMods(gameId) : []
  const enabled = new Set(gameId ? (await activeProfile(gameId)).enabled : [])
  const out: ResolvedDependency[] = []
  const seen = new Set<string>([`${id}:${modId}`])
  const queue: Array<{ source: string; mod: string; version?: string; requiredBy: string; depth: number }> = [{ source: id, mod: modId, version: versionId, requiredBy: '', depth: 0 }]
  while (queue.length) {
    const cur = queue.shift()!
    let deps: ModDependency[] = []
    try {
      deps = await directDependencies(cur.source, cur.mod, cur.version, gameId)
    } catch (err) {
      log.warn(`dependencies of ${cur.source}/${cur.mod} failed: ${(err as Error).message}`)
      continue
    }
    const parentName = cur.depth === 0 ? '' : out.find((o) => o.sourceId === cur.source && o.modId === cur.mod)?.name ?? cur.mod
    for (const dep of deps) {
      const key = `${dep.sourceId}:${dep.modId ?? dep.name}`
      if (seen.has(key)) continue
      seen.add(key)
      const match = dep.modId ? installed.find((m) => m.source?.sourceId === dep.sourceId && m.source.modId === dep.modId) : undefined
      const game = gameId ? getGame(gameId) : undefined
      // A loader someone put into the game folder by hand counts as installed.
      const byHand = !match && game && dep.sourceId === FRAMEWORKS_ID && dep.modId ? await frameworkPresent(game, dep.modId) : false
      if (byHand) {
        out.push({ ...dep, installed: true, requiredBy: parentName, note: 'already in the game folder' })
        continue
      }
      out.push({ ...dep, installed: Boolean(match), disabled: match ? !enabled.has(match.id) : undefined, requiredBy: parentName })
      if (!match && dep.installable && dep.modId && dep.sourceId && adapters.has(dep.sourceId) && cur.depth < 4) {
        queue.push({ source: dep.sourceId, mod: dep.modId, version: dep.versionId, requiredBy: dep.name, depth: cur.depth + 1 })
      }
    }
  }
  return out
}

export async function sourceBindings(id: string, gameId: string): Promise<SourceGameBinding[]> {
  suggestionCache.delete(`${id}|${gameId}`)
  return suggest(id, gameId)
}

export async function openSourcePage(id: string, modId: string, gameId?: string): Promise<void> {
  const url = adapterFor(id).getModPageUrl?.(modId, gameId)
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('This source has no web page for that mod.')
  await shell.openExternal(url)
}

export async function setFeeds(feeds: FeedConfig[]): Promise<SourceInfo[]> {
  const clean = feeds
    .filter((f) => f.url.trim())
    .map((f) => ({ id: f.id || shortId('f'), name: f.name.trim() || 'Custom feed', url: f.url.trim(), enabled: f.enabled }))
  setSettings({ feeds: clean })
  await loadSources()
  return listSources()
}

export function listPlugins(): PluginInfo[] {
  const loaded = new Set([...adapters.entries()].filter(([, r]) => r.kind === 'plugin').map(([id]) => id))
  return discovered.map((p) => pluginInfo(p, getSettings().trustedPlugins, loaded, pluginErrors))
}

export async function trustPlugin(pluginId: string, trusted: boolean): Promise<PluginInfo[]> {
  discovered = await discoverPlugins(paths.plugins())
  const p = discovered.find((x) => x.id === pluginId)
  if (!p) throw new Error('Plugin not found')
  const map = { ...getSettings().trustedPlugins }
  if (trusted) map[pluginId] = p.hash
  else delete map[pluginId]
  setSettings({ trustedPlugins: map })
  await loadSources()
  return listPlugins()
}

export async function reloadSources(): Promise<SourceInfo[]> {
  await loadSources()
  return listSources()
}
