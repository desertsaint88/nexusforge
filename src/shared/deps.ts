import type { InstalledMod, ModSourceRef } from './types'

const refKey = (r: Pick<ModSourceRef, 'sourceId' | 'modId'>) => `${r.sourceId}:${r.modId}`

/** Required mods of `mod` that are not installed, or installed but disabled in the profile. */
export function missingRequirements(mod: InstalledMod, mods: InstalledMod[], enabled: Set<string>): Array<{ ref: ModSourceRef; disabled: boolean }> {
  const out: Array<{ ref: ModSourceRef; disabled: boolean }> = []
  for (const ref of mod.requires ?? []) {
    const hit = mods.find((m) => m.source && refKey(m.source) === refKey(ref))
    if (!hit) out.push({ ref, disabled: false })
    else if (!enabled.has(hit.id)) out.push({ ref, disabled: true })
  }
  return out
}

/** Loose check whether a mod file's stated game versions include the installed one ("1.6" matches "1.6.1170"). */
export function supportsVersion(gameVersions: string[] | undefined, installed: string | undefined): boolean | undefined {
  if (!gameVersions?.length || !installed) return undefined
  const norm = (v: string) => v.toLowerCase().replace(/^v/, '').replace(/[^0-9a-z.]+/g, '')
  const have = norm(installed)
  return gameVersions.some((g) => {
    const want = norm(g)
    return Boolean(want) && (have === want || have.startsWith(want + '.') || want.startsWith(have + '.'))
  })
}
