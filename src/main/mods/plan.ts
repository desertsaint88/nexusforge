import { createHash } from 'node:crypto'
import type { ConflictFile, ConflictGroup, ConflictReport } from '@shared/types'

/** Windows paths are case-insensitive: every file is keyed by its lower-case, forward-slash path. */
export function relKey(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/** Plan/manifest key of a file: deploy target + case-insensitive path. */
export function entryKey(target: string, rel: string): string {
  return `${target}|${relKey(rel)}`
}

/** One file a mod wants in a deploy target. */
export interface PlanFile {
  target: string
  /** Path inside the target, forward slashes. */
  rel: string
  /** Absolute path of the file in mod storage. */
  source: string
  size: number
}

export interface PlanMod {
  id: string
  /** Changes whenever the mod's files change (reinstall, root change). */
  revision: string | number
  files: PlanFile[]
}

export interface PlanEntry {
  key: string
  target: string
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
 * later mods win, unless `overrides` pins a file to a specific provider. Overrides saved before deploy
 * targets existed are keyed by path only and apply to the game folder.
 */
export function buildPlan(mods: PlanMod[], overrides: Record<string, string>, salt = ''): DeployPlan {
  const providers = new Map<string, { target: string; rel: string; mods: Array<{ id: string; source: string; size: number }> }>()
  for (const mod of mods) {
    for (const f of mod.files) {
      const key = entryKey(f.target, f.rel)
      let slot = providers.get(key)
      if (!slot) {
        slot = { target: f.target, rel: f.rel.replace(/\\/g, '/'), mods: [] }
        providers.set(key, slot)
      }
      // A mod listing the same file twice (case variants) counts once.
      if (slot.mods.some((m) => m.id === mod.id)) continue
      slot.mods.push({ id: mod.id, source: f.source, size: f.size })
    }
  }

  const entries = new Map<string, PlanEntry>()
  const conflicts: ConflictFile[] = []
  for (const [key, slot] of providers) {
    const pinned = overrides[key] ?? (slot.target === 'game' ? overrides[relKey(slot.rel)] : undefined)
    const pinnedProvider = pinned ? slot.mods.find((m) => m.id === pinned) : undefined
    const winner = pinnedProvider ?? slot.mods[slot.mods.length - 1]
    entries.set(key, { key, target: slot.target, rel: slot.rel, modId: winner.id, source: winner.source, size: winner.size })
    if (slot.mods.length > 1) {
      conflicts.push({ key, target: slot.target, rel: slot.rel, providers: slot.mods.map((m) => m.id), winner: winner.id, overridden: Boolean(pinnedProvider) })
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
