import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginInfo } from '@shared/types'
import type { AdapterContext, ModSourceAdapter } from './types'
import { exists, readJson, safeReaddir } from '../util/fs'

/*
 * Plugins live in <userData>/plugins/<folder>/ with an entry file (package.json "main", or index.js/.mjs/.cjs).
 * The entry exports `createAdapter(ctx)` (or a default function/object) returning a ModSourceAdapter.
 *
 * Plugins run with the same rights as NexusForge, so none is loaded until the user trusts it in
 * Settings › Sources. Trust is pinned to the SHA-256 of the entry file: if the file changes, the plugin
 * is disabled again until it is re-approved.
 */

export interface DiscoveredPlugin {
  id: string
  dir: string
  entry: string
  name: string
  version?: string
  hash: string
}

export async function discoverPlugins(root: string): Promise<DiscoveredPlugin[]> {
  const out: DiscoveredPlugin[] = []
  for (const e of await safeReaddir(root)) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    const pkg = await readJson<{ name?: string; version?: string; main?: string }>(join(dir, 'package.json'))
    const candidates = [pkg?.main, 'index.js', 'index.mjs', 'index.cjs'].filter(Boolean) as string[]
    let entry: string | undefined
    for (const c of candidates) {
      if (await exists(join(dir, c))) {
        entry = join(dir, c)
        break
      }
    }
    if (!entry) continue
    const hash = createHash('sha256').update(await fsp.readFile(entry)).digest('hex')
    out.push({ id: `plugin:${e.name}`, dir, entry, name: pkg?.name ?? e.name, version: pkg?.version, hash })
  }
  return out
}

function validate(a: unknown): a is ModSourceAdapter {
  const x = a as Partial<ModSourceAdapter> | undefined
  return Boolean(x && typeof x.search === 'function' && typeof x.getModDetails === 'function' && typeof x.getDownloadUrl === 'function')
}

export async function loadPlugin(p: DiscoveredPlugin, ctx: AdapterContext): Promise<ModSourceAdapter> {
  const mod = (await import(`${pathToFileURL(p.entry).href}?v=${p.hash.slice(0, 12)}`)) as Record<string, unknown>
  const exported = (mod.createAdapter ?? mod.default ?? mod) as unknown
  const candidate = typeof exported === 'function' ? await (exported as (c: AdapterContext) => unknown)(ctx) : exported
  const adapter = (candidate as { default?: unknown })?.default && !validate(candidate) ? (candidate as { default: unknown }).default : candidate
  if (!validate(adapter)) throw new Error('The plugin does not export a mod source (needs search, getModDetails and getDownloadUrl).')
  return { ...adapter, id: p.id, name: adapter.name || p.name }
}

export function pluginInfo(p: DiscoveredPlugin, trusted: Record<string, string>, loaded: Set<string>, errors: Map<string, string>): PluginInfo {
  const pinned = trusted[p.id]
  return {
    id: p.id,
    dir: p.dir,
    name: p.name,
    version: p.version,
    trusted: pinned === p.hash,
    changed: Boolean(pinned && pinned !== p.hash),
    loaded: loaded.has(p.id),
    error: errors.get(p.id)
  }
}
