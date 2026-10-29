import type { ModSearchResponse, ModSearchResult, ModSort } from '@shared/types'

/** A list with fewer mods than this is "short": a quiet game's "trending" is often 0–3 mods. */
export const FULL_LIST = 20

export interface ListingPlan {
  sort: ModSort
  page: number
  /** The source's windows for this order (days, 0 = all time), its own default first. */
  windows?: number[]
  /** The order the rest follow in when this one leaves mods out. */
  fill?: ModSort
  /** From the first page's response, for "Load more". */
  windowDays?: number
  fillSort?: ModSort
  /** One page of the site's list in order `by`; `more` = the site has a next page. */
  fetch(by: ModSort, page: number, windowDays?: number): Promise<{ results: ModSearchResult[]; more: boolean }>
}

/**
 * A page of a site's list, in the site's own order, with short lists completed instead of shown nearly empty:
 * - time-limited orders (trending, popular right now) look further back than the site's window (`widenedFrom`);
 * - orders that leave mods out (ModDB's rating list only has rated mods) continue with the rest (`filled`).
 * Further pages continue the list the first page settled on.
 */
export async function completeListing(p: ListingPlan): Promise<ModSearchResponse> {
  const page = async (by: ModSort, n: number, windowDays?: number): Promise<ModSearchResponse> => ({ ...(await p.fetch(by, n, windowDays)), sort: p.sort, windowDays })

  if (p.page) {
    if (p.fill && p.fillSort === p.fill) return page(p.fill, p.page)
    return page(p.sort, p.page, p.windowDays !== undefined && p.windows?.includes(p.windowDays) ? p.windowDays : undefined)
  }

  if (p.windows?.length) {
    let first: ModSearchResponse | undefined
    for (const days of p.windows) {
      const res = await page(p.sort, 0, days)
      first ??= res
      if (res.results.length >= FULL_LIST || days === p.windows[p.windows.length - 1]) {
        return days === p.windows[0] ? res : { ...res, widenedFrom: { days: p.windows[0], count: first.results.length } }
      }
    }
  }

  const res = await page(p.sort, 0)
  if (!p.fill || res.results.length >= FULL_LIST || res.more) return res
  const rest = await page(p.fill, 0)
  const have = new Set(res.results.map((r) => r.id))
  return { ...rest, results: [...res.results, ...rest.results.filter((r) => !have.has(r.id))], filled: { sort: p.fill, count: res.results.length } }
}
