// The order sites are listed in, the same in every client (web list, `fling list`, both MCP
// servers' fling_list). A whole list is sorted wherever it is read; a paged one (`limit`) is
// sorted by the server, which pages it in the same order.

export const SITE_SORTS = ['updated', 'created', 'name'] as const
/** `updated`: last updated, newest first; `created`: newest first; `name`: A–Z. */
export type SiteSort = (typeof SITE_SORTS)[number]
export const DEFAULT_SITE_SORT: SiteSort = 'updated'
/** The most sites one page of GET /api/sites or /api/shared holds (`limit`). */
export const SITE_LIST_PAGE_MAX = 100

type Sortable = { name: string; createdAt: string; updatedAt: string }

export function isSiteSort(value: unknown): value is SiteSort {
  return typeof value === 'string' && (SITE_SORTS as readonly string[]).includes(value)
}

const byName = (a: Sortable, b: Sortable) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** The comparison `sortSites` uses: ties (same timestamp) fall back to the name, A–Z. */
export function compareSites(
  sort: SiteSort = DEFAULT_SITE_SORT
): (a: Sortable, b: Sortable) => number {
  if (sort === 'name') return byName
  const key = sort === 'created' ? 'createdAt' : 'updatedAt'
  return (a, b) => Date.parse(b[key]) - Date.parse(a[key]) || byName(a, b)
}

/** A new array in `sort` order; ties (same timestamp) fall back to the name, A–Z. */
export function sortSites<T extends Sortable>(
  sites: readonly T[],
  sort: SiteSort = DEFAULT_SITE_SORT
): T[] {
  return [...sites].sort(compareSites(sort))
}
