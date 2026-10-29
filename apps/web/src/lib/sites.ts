/**
 * The site page's address; which of the site list's tabs shows (`?view=`); and which order the
 * list is in: `?sort=` when it names a known order (a shared link), otherwise the reader's
 * remembered choice, otherwise the default.
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

/** The site list's tabs: your active or archived sites, those shared with you, every site. */
export type SitesView = 'active' | 'archived' | 'shared' | 'all'

/**
 * The tab `?view=` asks for, if this reader has it: Shared with me with the `audiences`
 * capability, All sites for admins. A guest has only Shared with me, whatever is asked: they own
 * no sites.
 */
export function sitesViewOf(
  param: string | null,
  reader: { guest: boolean; sharing: boolean; admin: boolean }
): SitesView {
  if (reader.guest) return 'shared'
  if (param === 'archived') return 'archived'
  if (param === 'shared' && reader.sharing) return 'shared'
  if (param === 'all' && reader.admin) return 'all'
  return 'active'
}
