/**
 * Paths in the web UI, the parts that need no React (`paths` capability): a Path page's address,
 * the site page's search and order of its Paths (`?q=`, `?sort=`), how a Path's owners read in the
 * list, and what the reader may do to a Path. The server decides every change; these only choose
 * what to offer, from the site's role and the Path's own owners and publishers.
 */
import type { SitePath, SiteRole, SiteRoleMembers } from '@fling/shared'
import { queryTerms } from './search'
import { siteHref } from './sites'

/** The app route of a Path's page, under its site's. */
export function pathHref(name: string, folder: string): string {
  return `${siteHref(name)}/paths/${encodeURIComponent(folder)}`
}

/** How a Path's folder is shown: `/PAY-412/`. */
export const shownFolder = (folder: string) => `/${folder}/`

/** The list offers a search and an order once it is this long. */
export const PATH_SEARCH_FROM = 6

export const PATH_SORTS = ['updated', 'created', 'folder'] as const
export type PathSort = (typeof PATH_SORTS)[number]
export const DEFAULT_PATH_SORT: PathSort = 'updated'

export const PATH_SORT_LABELS: Record<PathSort, string> = {
  updated: 'Newest',
  created: 'Created',
  folder: 'Folder A–Z',
}

/** `?sort=` as an order, or the default when it isn't one. */
export function parsePathSort(value: string | null | undefined): PathSort {
  return (PATH_SORTS as readonly string[]).includes(value ?? '')
    ? (value as PathSort)
    : DEFAULT_PATH_SORT
}

const byFolder = (a: SitePath, b: SitePath) =>
  a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: 'base' })

/** The Paths in `sort` order (newest first for the dates, folder A–Z to break ties). */
export function sortPaths<T extends SitePath>(paths: readonly T[], sort: PathSort): T[] {
  if (sort === 'folder') return [...paths].sort(byFolder)
  const key = sort === 'created' ? 'createdAt' : 'updatedAt'
  return [...paths].sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]) || byFolder(a, b))
}

/**
 * The Paths matching `query`: every word appears, case-insensitively, in the folder, title, URL,
 * or an owner's address or group name.
 */
export function filterPaths<T extends SitePath>(paths: readonly T[], query: string): T[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return [...paths]
  return paths.filter(p => {
    const haystack = [
      p.folder,
      p.title,
      p.url,
      ...(p.owners?.emails.map(e => e.email) ?? []),
      ...(p.owners?.groups.map(g => g.name) ?? []),
    ]
      .join('\n')
      .toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/** `a@x.test, Design team` with `+2` past `max`; '' for nobody. */
export function membersSummary(members: SiteRoleMembers | undefined, max = 2): string {
  const names = [
    ...(members?.emails.map(e => e.email) ?? []),
    ...(members?.groups.map(g => g.name) ?? []),
  ]
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} +${names.length - max}`
}

/** `3 Paths`, or `1 of 3 Paths` while a search narrows them. */
export function pathsCountLabel(total: number, shown: number, searching: boolean): string {
  const noun = total === 1 ? 'Path' : 'Paths'
  return searching ? `${shown} of ${total} ${noun}` : `${total} ${noun}`
}

/**
 * Whether the reader may change the Path's owners and publishers, archive and delete it: what the
 * server says (`canManage`). From a server that doesn't say, the site's owners (and admins), or
 * the Path's own owners named by address.
 */
export function canManagePath(
  path: Pick<SitePath, 'owners' | 'canManage'>,
  siteRole: SiteRole | undefined,
  email: string | undefined
): boolean {
  if (path.canManage !== undefined) return path.canManage
  if (siteRole === 'owner' || siteRole === 'admin') return true
  const mine = email?.toLowerCase()
  return mine !== undefined && (path.owners?.emails.some(e => e.email === mine) ?? false)
}

/** Whether the reader may restore an earlier version: whoever publishes to it, and admins. */
export function canRestorePath(
  path: Pick<SitePath, 'canPublish'>,
  siteRole: SiteRole | undefined
): boolean {
  return path.canPublish || siteRole === 'admin'
}
