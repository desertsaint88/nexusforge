import { shell } from 'electron'
import type { FeedConfig, ModDetails, ModSearchResult, PluginInfo, SourceGameBinding, SourceInfo } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { httpJson } from './http'
import { createThunderstoreAdapter } from './thunderstore'
import { createNexusAdapter } from './nexus'
import { createModrinthAdapter } from './modrinth'
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
  register(createThunderstoreAdapter(contextFor('thunderstore')), 'builtin')
  register(createModrinthAdapter(contextFor('modrinth')), 'builtin')
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
      bindingLabel: adapter.bindingLabel
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
    if (msg === 'NEXUS_MANUAL') throw err
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

export function sourceDownloadUrl(id: string, modId: string, versionId: string, gameId?: string): Promise<string> {
  return guarded(id, 'download', (a) => a.getDownloadUrl(modId, versionId, gameId))
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
