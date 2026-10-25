// Installed-mod scans: runs detect-core over the library, remembers the results and tells the renderer.

import { join } from 'node:path'
import type { Game, GameModInfo } from '@shared/types'
import { db } from '../store'
import { emit } from '../events'
import { paths } from '../paths'
import { scoped } from '../logger'
import { readManifest } from './deploy'
import { listMods } from './manager'
import { getGame, listGames } from '../library/library'
import { detectGameMods } from './detect-core'

const log = scoped('detect')

/** NexusForge's own deployments: file -> installed mod id. */
async function managedFiles(game: Game): Promise<Array<[string, string]>> {
  const manifest = await readManifest(paths.deployManifest(game.id))
  if (!manifest) return []
  return manifest.entries.map((e) => [join(manifest.targetDir, ...e.rel.split('/')).toLowerCase(), e.modId])
}

export function allDetected(): Record<string, GameModInfo> {
  return db().get('detected') ?? {}
}

function store(info: GameModInfo): void {
  db().set('detected', { ...allDetected(), [info.gameId]: info })
  emit('mods:detected', info)
}

let queue: Promise<unknown> = Promise.resolve()

/** Scans the given games (default: every visible game) one after another; results are stored and broadcast. */
export function rescanGames(ids?: string[]): Promise<Record<string, GameModInfo>> {
  const run = async () => {
    const games = (ids ? ids.map((id) => getGame(id)).filter(Boolean) : listGames().filter((g) => !g.hidden)) as Game[]
    const started = Date.now()
    let total = 0
    for (const g of games) {
      try {
        const info = await detectGameMods(g, { managed: await managedFiles(g), managedCount: listMods(g.id).length })
        total += info.mods.filter((m) => m.kind !== 'loader').length
        store(info)
      } catch (err) {
        log.warn(`mod scan of ${g.name} failed: ${(err as Error).message}`)
      }
    }
    // Games that left the library don't keep stale entries.
    if (!ids) {
      const keep = new Set(listGames().map((g) => g.id))
      const all = allDetected()
      const pruned = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)))
      if (Object.keys(pruned).length !== Object.keys(all).length) db().set('detected', pruned)
    }
    log.info(`mod scan: ${games.length} game(s), ${total} mod(s) found in ${Date.now() - started} ms`)
    return allDetected()
  }
  const next = queue.catch(() => {}).then(run)
  queue = next
  return next
}

export async function detectedFor(gameId: string): Promise<GameModInfo> {
  const hit = allDetected()[gameId]
  if (hit) return hit
  return (await rescanGames([gameId]))[gameId] ?? { gameId, scannedAt: Date.now(), supported: false, support: [], mods: [] }
}
