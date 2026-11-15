/**
 * The site page's tabs (`?tab=`): Access (who can open it, its owners and publishers), Versions
 * (and its Paths), Server (the site server, its secrets and logs) and Settings (archive, delete).
 * A tab the viewer has nothing in is not offered, and a `?tab=` naming no offered tab shows the
 * first one: Access, or Versions when there is no Access tab.
 */

export type SiteTab = 'access' | 'versions' | 'server' | 'settings'

export const SITE_TAB_LABELS: Record<SiteTab, string> = {
  access: 'Access',
  versions: 'Versions',
  server: 'Server',
  settings: 'Settings',
}

/** What the viewer has in each tab that can be empty. Versions always has the site's versions. */
export interface SiteTabContents {
  /** the Access section or the Owners and publishers section */
  access: boolean
  /** the Server, Secrets or Logs section */
  server: boolean
  /** the Danger zone */
  settings: boolean
}

/** The tabs offered, in order. */
export function siteTabsFor(contents: SiteTabContents): SiteTab[] {
  return [
    ...(contents.access ? (['access'] as const) : []),
    'versions',
    ...(contents.server ? (['server'] as const) : []),
    ...(contents.settings ? (['settings'] as const) : []),
  ]
}

/** The tab `?tab=` asks for when it is offered, otherwise the first tab offered. */
export function siteTabOf(param: string | null, tabs: readonly SiteTab[]): SiteTab {
  const asked = tabs.find(tab => tab === param)
  return asked ?? tabs[0] ?? 'versions'
}

/** The `?tab=` value for a tab: none for the first, so the page's plain address shows it. */
export function siteTabParam(tab: SiteTab, tabs: readonly SiteTab[]): string | null {
  return tab === tabs[0] ? null : tab
}
