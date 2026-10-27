/**
 * The site page's address, and which order the site list is in: `?sort=` when it names a known
 * order (a shared link), otherwise the reader's remembered choice, otherwise the default.
 */
import { DEFAULT_SITE_SORT, isSiteSort, type SiteSort } from '@fling/shared'

/** The app route of a site's page. */
export function siteHref(name: string): string {
  return `/sites/${encodeURIComponent(name)}`
}

export const SITE_SORT_LABELS: Record<SiteSort, string> = {
  updated: 'Last updated',
  created: 'Created',
  name: 'Name A–Z',
}

/** A stored or typed value as a sort, or the default when it isn't one. */
export function parseSiteSort(value: string | null | undefined): SiteSort {
  return isSiteSort(value) ? value : DEFAULT_SITE_SORT
}

export function chooseSiteSort(param: string | null, saved: string | null): SiteSort {
  return isSiteSort(param) ? param : parseSiteSort(saved)
}
