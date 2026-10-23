import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ConflictFile, ConflictGroup, ConflictReport, ModFileEntry } from '@shared/types'

/** Windows paths are case-insensitive: every file is keyed by its lower-case, forward-slash path. */
export function relKey(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

export interface PlanMod {
  id: string
  /** Absolute folder whose contents map onto the deploy target. */
  root: string
  /** Changes whenever the mod's files change (reinstall, root change). */
  revision: string | number
  files: ModFileEntry[]
}

export interface PlanEntry {
  key: string
  rel: string
  modId: string
  source: string
  size: number
}

export interface DeployPlan {
  entries: Map<string, PlanEntry>
  conflicts: ConflictFile[]
  hash: string
}

/**
 * Resolves which mod provides each file. `mods` must be the enabled mods in load order;
 * later mods win, unless `overrides` pins a file to a specific provider.
 */
export function buildPlan(mods: PlanMod[], overrides: Record<string, string>, salt = ''): DeployPlan {
  const providers = new Map<string, { rel: string; mods: Array<{ id: string; source: string; size: number }> }>()
  for (const mod of mods) {
    for (const f of mod.files) {
      const key = relKey(f.rel)
      let slot = providers.get(key)
      if (!slot) {
        slot = { rel: f.rel.replace(/\\/g, '/'), mods: [] }
        providers.set(key, slot)
      }
      // A mod listing the same file twice (case variants) counts once.
      if (slot.mods.some((m) => m.id === mod.id)) continue
      slot.mods.push({ id: mod.id, source: join(mod.root, ...f.rel.split(/[\\/]/)), size: f.size })
    }
  }

  const entries = new Map<string, PlanEntry>()
  const conflicts: ConflictFile[] = []
  for (const [key, slot] of providers) {
    const pinned = overrides[key]
    const pinnedProvider = pinned ? slot.mods.find((m) => m.id === pinned) : undefined
    const winner = pinnedProvider ?? slot.mods[slot.mods.length - 1]
    entries.set(key, { key, rel: slot.rel, modId: winner.id, source: winner.source, size: winner.size })
    if (slot.mods.length > 1) {
      conflicts.push({ key, rel: slot.rel, providers: slot.mods.map((m) => m.id), winner: winner.id, overridden: Boolean(pinnedProvider) })
    }
  }

  const h = createHash('sha1')
  h.update(salt)
  for (const m of mods) h.update(`|${m.id}@${m.revision}`)
  for (const key of [...entries.keys()].sort()) {
    const e = entries.get(key)!
    h.update(`\n${key}>${e.modId}:${e.size}`)
  }
  return { entries, conflicts, hash: h.digest('hex') }
}

export function conflictReport(plan: DeployPlan, gameId: string, profileId: string, order: string[]): ConflictReport {
  const rank = new Map(order.map((id, i) => [id, i]))
  const groups = new Map<string, ConflictGroup>()
  const perMod: ConflictReport['perMod'] = {}
  const bump = (id: string, field: 'wins' | 'loses') => {
    perMod[id] ??= { wins: 0, loses: 0 }
    perMod[id][field]++
  }
  for (const c of plan.conflicts) {
    const mods = [...c.providers].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
    const id = mods.join('|')
    let g = groups.get(id)
    if (!g) {
      g = { mods, files: [] }
      groups.set(id, g)
    }
    g.files.push(c)
    for (const p of c.providers) bump(p, p === c.winner ? 'wins' : 'loses')
  }
  const sorted = [...groups.values()].sort((a, b) => b.files.length - a.files.length)
  for (const g of sorted) g.files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { gameId, profileId, totalFiles: plan.conflicts.length, groups: sorted, perMod }
}
