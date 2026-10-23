/**
 * Client-side site search: a query matches a site when every whitespace-separated word appears
 * (case-insensitively, as a substring) in its name, URL or share URL.
 */
import type { Site } from '@fling/shared'

type Searchable = Pick<Site, 'name' | 'url' | 'shareUrl'>

/** The query's words, lower-cased; empty for a blank query. */
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesQuery(site: Searchable, query: string): boolean {
  const terms = queryTerms(query)
  if (terms.length === 0) return true
  const haystack = [site.name, site.url, site.shareUrl ?? ''].join('\n').toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/** The sites matching `query`, in their original order; all of them for a blank query. */
export function filterSites<T extends Searchable>(sites: readonly T[], query: string): T[] {
  return queryTerms(query).length === 0 ? [...sites] : sites.filter(s => matchesQuery(s, query))
}

/** The header's count line: what's listed, and how much of it the search lets through. */
export function countLabel({
  total,
  shown,
  archived,
  searching,
}: {
  total: number | undefined
  shown: number
  archived: boolean
  searching: boolean
}): string {
  if (total === undefined) return 'Everything you have flung, in one list'
  const noun = (n: number) => `${archived ? 'archived ' : ''}${n === 1 ? 'site' : 'sites'}`
  if (searching) return `${shown} of ${total} ${noun(total)}`
  if (total === 0) return archived ? 'Nothing archived' : 'Nothing flung yet'
  return archived ? `${total} ${noun(total)}` : `${total} live ${noun(total)}`
}
