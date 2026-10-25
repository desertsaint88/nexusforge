// Which file of a mod's source is an update for the installed one (pure logic, unit-tested).

import type { InstalledMod, ModVersion } from '@shared/types'

const time = (v?: ModVersion) => (v?.date ? Date.parse(v.date) || 0 : 0)
const sameVersion = (a?: string, b?: string) => Boolean(a && b && a.replace(/^v/i, '').trim().toLowerCase() === b.replace(/^v/i, '').trim().toLowerCase())

/**
 * The newer file for an installed mod, or undefined when it is up to date.
 * Files only replace files of the same channel (Nexus: main files replace main files, an optional file only
 * newer uploads of that optional file); sources without channels simply offer their newest file.
 */
export function newerVersion(mod: Pick<InstalledMod, 'version' | 'source' | 'updatedAt'>, versions: ModVersion[]): ModVersion | undefined {
  const live = versions.filter((v) => !v.superseded)
  if (!live.length) return undefined
  const installedId = mod.source?.versionId?.split('|')[0]
  const cur = versions.find((v) => v.id === mod.source?.versionId || v.id === installedId)
  const byDate = (list: ModVersion[]) => [...list].sort((a, b) => time(b) - time(a))
  // A file the site moved to "old versions" (or that is gone) was a main file: the current main file replaces it.
  let pool = cur && !cur.superseded ? live.filter((v) => (v.channel ?? '') === (cur.channel ?? '')) : live.filter((v) => v.primary)
  if (!pool.length) pool = live
  // Several files in one channel (a 1080p and a 4K main file): stay with the one that has the installed file's name.
  if (cur?.channel && pool.length > 1) {
    const same = pool.filter((v) => v.name === cur.name)
    if (same.length) pool = same
  }
  // Sources without dates list newest first; keep that order then.
  const latest = pool.some((v) => v.date) ? byDate(pool)[0] : pool[0]
  if (!latest) return undefined

  if (cur && latest.id === cur.id) {
    // Steam Workshop has one floating "latest" file: newer when the item changed after the install.
    if (cur.id === 'latest' && time(cur) > mod.updatedAt + 60_000) return latest
    return undefined
  }
  if (sameVersion(latest.version, mod.version)) return undefined
  if (cur) {
    // Only forward in time: never offer an older file as an "update".
    if (time(latest) && time(cur) && time(latest) <= time(cur)) return undefined
    return latest
  }
  // The installed file is gone from the site (replaced or archived): the current main file is the update,
  // unless it is not newer than what was installed.
  if (time(latest) && time(latest) < mod.updatedAt - 24 * 3_600_000 && !mod.version) return undefined
  return latest
}
