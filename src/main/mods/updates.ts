// Update check for mods installed through NexusForge: asks each mod's source for its files and reports
// a newer one. Updating itself is a normal download of that file; installing a mod from the same source
// replaces the old copy in place (same position in the load order, same enabled state).

import type { ModUpdate } from '@shared/types'
import { newerVersion } from './update-match'
import { listMods } from './manager'
import { sourceDetails } from '../sources/registry'
import { FRAMEWORKS_ID, isFrameworkId } from '../sources/frameworks'
import { scoped } from '../logger'

const log = scoped('updates')

const cache = new Map<string, { at: number; updates: ModUpdate[] }>()
const running = new Map<string, Promise<ModUpdate[]>>()
const TTL = 30 * 60_000

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Newer files for a game's mods. Results are kept for 30 minutes unless `force`. */
export function checkUpdates(gameId: string, force = false): Promise<ModUpdate[]> {
  const hit = cache.get(gameId)
  if (!force && hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.updates)
  const pending = running.get(gameId)
  if (pending) return pending
  const job = (async () => {
    // Loaders installed by an integration from elsewhere (Script Hook V) get their updates in the game's Setup panel.
    const mods = listMods(gameId).filter(
      (m) => m.source?.sourceId && m.source.modId && !m.source.sourceId.startsWith('feed:') && !(m.source.sourceId === FRAMEWORKS_ID && !isFrameworkId(m.source.modId))
    )
    const found = await inBatches(mods, 4, async (mod): Promise<ModUpdate | undefined> => {
      try {
        const details = await sourceDetails(mod.source!.sourceId, mod.source!.modId, gameId)
        const v = newerVersion(mod, details.versions)
        if (!v) return undefined
        return {
          modId: mod.id,
          name: mod.name,
          sourceId: mod.source!.sourceId,
          sourceModId: mod.source!.modId,
          currentVersion: mod.version,
          latestVersionId: v.id,
          latestVersion: v.version ?? details.version,
          latestName: v.name,
          date: v.date,
          sizeBytes: v.sizeBytes,
          thumbnail: mod.thumbnail ?? details.thumbnail
        }
      } catch (err) {
        log.warn(`update check failed for ${mod.name}: ${(err as Error).message}`)
        return undefined
      }
    })
    const updates = found.filter(Boolean) as ModUpdate[]
    cache.set(gameId, { at: Date.now(), updates })
    if (updates.length) log.info(`${updates.length} update(s) for ${gameId}: ${updates.map((u) => `${u.name} ${u.currentVersion ?? '?'} -> ${u.latestVersion ?? u.latestName}`).join(', ')}`)
    return updates
  })().finally(() => running.delete(gameId))
  running.set(gameId, job)
  return job
}

/** Forget a game's results (after a mod was installed, updated or removed). */
export function invalidateUpdates(gameId: string, modId?: string): void {
  const hit = cache.get(gameId)
  if (!hit) return
  if (modId) hit.updates = hit.updates.filter((u) => u.modId !== modId)
  else cache.delete(gameId)
}
