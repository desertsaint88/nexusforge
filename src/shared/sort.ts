import type { ModSearchResult, ModSort } from './types'

export const SORT_LABEL: Record<ModSort, string> = {
  relevance: 'Best match',
  endorsed: 'Top rated',
  downloads: 'Most downloaded',
  downloads_recent: 'Popular right now',
  trending: 'Trending',
  newest: 'Recently added',
  updated: 'Recently updated'
}

const DAY = 86_400_000

const time = (s?: string) => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * Orders results the source couldn't order itself. Trending weighs ratings (or downloads) by age, the way
 * "hot" lists do; "recent downloads" puts mods touched in the last 30 days first, by downloads.
 */
export function sortResults(results: ModSearchResult[], sort: ModSort, now = Date.now()): ModSearchResult[] {
  const list = [...results]
  const by = (f: (r: ModSearchResult) => number) => list.sort((a, b) => f(b) - f(a))
  switch (sort) {
    case 'endorsed':
      return by((r) => r.endorsements ?? -1)
    case 'downloads':
      return by((r) => r.downloads ?? -1)
    case 'downloads_recent':
      return by((r) => (now - time(r.updatedAt ?? r.createdAt) <= 30 * DAY ? 1e15 : 0) + (r.downloads ?? 0))
    case 'trending':
      return by((r) => {
        const age = Math.max(0, now - time(r.createdAt ?? r.updatedAt)) / DAY
        const votes = r.endorsements ?? (r.downloads ?? 0) / 50
        return votes / Math.pow(age + 2, 1.5)
      })
    case 'newest':
      return by((r) => time(r.createdAt ?? r.updatedAt))
    case 'updated':
      return by((r) => time(r.updatedAt ?? r.createdAt))
    default:
      return list
  }
}
