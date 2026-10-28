/**
 * Client-side site search: a query matches a site when every whitespace-separated word appears
 * (case-insensitively, as a substring) in its name, URL, share URL or (a site shared with you, or
 * any site in an admin's All sites) its owner.
 */
import type { Site } from '@fling/shared'

type Searchable = Pick<Site, 'name' | 'url'> & { shareUrl?: string | null; owner?: string }

/** The query's words, lower-cased; empty for a blank query. */
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesQuery(site: Searchable, query: string): boolean {
  const terms = queryTerms(query)
  if (terms.length === 0) return true
  const haystack = [site.name, site.url, site.shareUrl ?? '', site.owner ?? '']
    .join('\n')
    .toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/** The sites matching `query`, in their original order; all of them for a blank query. */
export function filterSites<T extends Searchable>(sites: readonly T[], query: string): T[] {
  return queryTerms(query).length === 0 ? [...sites] : sites.filter(s => matchesQuery(s, query))
}

/**
 * The header's count line: what's listed (your live or archived sites, the sites shared with you,
 * or every site on the instance), and how much of it the search lets through.
 */
export function countLabel({
  total,
  shown,
  archived,
  shared = false,
  all = false,
  searching,
}: {
  total: number | undefined
  shown: number
  archived: boolean
  shared?: boolean
  all?: boolean
  searching: boolean
}): string {
  if (all) {
    const sites = (n: number) => (n === 1 ? 'site' : 'sites')
    if (total === undefined) return 'Every site on this instance'
    if (searching) return `${shown} of ${total} ${sites(total)}`
    if (total === 0) return 'Nothing flung on this instance yet'
    return `${total} ${sites(total)}`
  }
  if (shared) {
    const sites = (n: number) => (n === 1 ? 'site' : 'sites')
    if (total === undefined) return 'Restricted sites other people have shared with you'
    if (searching) return `${shown} of ${total} shared ${sites(total)}`
    if (total === 0) return 'Nothing shared with you yet'
    return `${total} ${sites(total)} shared with you`
  }
  if (total === undefined) return 'Everything you have flung, in one list'
  const noun = (n: number) => `${archived ? 'archived ' : ''}${n === 1 ? 'site' : 'sites'}`
  if (searching) return `${shown} of ${total} ${noun(total)}`
  if (total === 0) return archived ? 'Nothing archived' : 'Nothing flung yet'
  return archived ? `${total} ${noun(total)}` : `${total} live ${noun(total)}`
}
