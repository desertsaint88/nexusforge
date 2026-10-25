import type { DetectedMod, InstalledMod, ModSearchResult } from './types'

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(v|version)?\d+(\.\d+)+\b/g, '')
    .replace(/[^a-z0-9]/g, '')

export interface InstalledIndex {
  /** "source:modId" of mods installed through NexusForge or identified on disk. */
  refs: Set<string>
  /** Normalized names of mods found on disk without a source id. */
  names: Set<string>
}

const refKey = (sourceId: string, modId: string) => {
  // BeamNG resources are "slug.1234" on the site but only "1234" in BeamNG's own db.json.
  const id = sourceId === 'beamng' ? (modId.split('.').pop() ?? modId) : modId
  return `${sourceId}:${id.toLowerCase()}`
}

export function installedIndex(managed: InstalledMod[], detected: DetectedMod[]): InstalledIndex {
  const refs = new Set<string>()
  const names = new Set<string>()
  for (const m of managed) if (m.source) refs.add(refKey(m.source.sourceId, m.source.modId))
  for (const d of detected) {
    if (d.kind === 'loader') continue
    if (d.source) refs.add(refKey(d.source.sourceId, d.source.modId))
    const n = norm(d.name)
    if (n.length >= 4) names.add(n)
  }
  return { refs, names }
}

/** Whether a mod from a source list is already installed in the game (by id, or by its exact name on disk). */
export function isInstalled(index: InstalledIndex, r: Pick<ModSearchResult, 'sourceId' | 'id' | 'name'>): boolean {
  if (index.refs.has(refKey(r.sourceId, r.id))) return true
  const n = norm(r.name)
  return n.length >= 4 && index.names.has(n)
}
