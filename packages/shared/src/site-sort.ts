// The order sites are listed in, the same in every client (web list, `fling list`, both MCP
// servers' fling_list). Lists are fetched whole, so sorting happens on the client.

export const SITE_SORTS = ['updated', 'created', 'name'] as const
/** `updated`: last updated, newest first; `created`: newest first; `name`: A–Z. */
export type SiteSort = (typeof SITE_SORTS)[number]
export const DEFAULT_SITE_SORT: SiteSort = 'updated'

type Sortable = { name: string; createdAt: string; updatedAt: string }

export function isSiteSort(value: unknown): value is SiteSort {
  return typeof value === 'string' && (SITE_SORTS as readonly string[]).includes(value)
}

const byName = (a: Sortable, b: Sortable) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** A new array in `sort` order; ties (same timestamp) fall back to the name, A–Z. */
export function sortSites<T extends Sortable>(
  sites: readonly T[],
  sort: SiteSort = DEFAULT_SITE_SORT
): T[] {
  const newest = (key: 'createdAt' | 'updatedAt') => (a: T, b: T) =>
    Date.parse(b[key]) - Date.parse(a[key]) || byName(a, b)
  const compare = sort === 'name' ? byName : newest(sort === 'created' ? 'createdAt' : 'updatedAt')
  return [...sites].sort(compare)
}
