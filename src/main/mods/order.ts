import type { InstalledMod, ModSourceRef } from '@shared/types'

const refKey = (r: Pick<ModSourceRef, 'sourceId' | 'modId'>) => `${r.sourceId}:${r.modId}`

/**
 * Where a newly installed mod belongs in a load order: after every mod it requires, and before every
 * installed mod that requires it, so libraries load (and lose file conflicts) first. Falls back to the end.
 */
export function placeInOrder(order: string[], modId: string, mods: Record<string, InstalledMod>): string[] {
  const rest = order.filter((id) => id !== modId)
  const mod = mods[modId]
  if (!mod) return [...rest, modId]
  const needs = new Set((mod.requires ?? []).map(refKey))
  const ownKey = mod.source ? refKey(mod.source) : undefined
  let after = -1
  let before = rest.length
  rest.forEach((id, i) => {
    const other = mods[id]
    if (!other) return
    if (other.source && needs.has(refKey(other.source))) after = Math.max(after, i)
    if (ownKey && (other.requires ?? []).some((r) => refKey(r) === ownKey)) before = Math.min(before, i)
  })
  // A dependency cycle can't be satisfied; keep the mod after what it needs.
  const index = before <= after ? after + 1 : before
  return [...rest.slice(0, index), modId, ...rest.slice(index)]
}
