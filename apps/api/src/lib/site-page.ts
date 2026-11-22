/**
 * One page of a person's sites (GET /api/sites, /api/shared, fling_list): the whole set is read
 * and sorted (`compareSites`), and the page is the `limit` sites after the cursor. The cursor is
 * opaque to clients: the order, the last site's sort key and its name, so the next page starts
 * after that position even when that site has since changed or gone.
 */
import {
  compareSites,
  DEFAULT_SITE_SORT,
  SITE_LIST_PAGE_MAX,
  type SiteSort,
  sortSites,
} from '@fling/shared'
import { badRequest } from './errors.ts'

type Sortable = { name: string; createdAt: string; updatedAt: string }

/** What a list request asks for: an order, and a page when `limit` is set. */
export interface PageRequest {
  sort?: SiteSort
  limit?: number
  cursor?: string
}

const keyOf = (site: Sortable, sort: SiteSort) =>
  sort === 'name' ? site.name : sort === 'created' ? site.createdAt : site.updatedAt

function encode(sort: SiteSort, site: Sortable): string {
  return Buffer.from(JSON.stringify([sort, keyOf(site, sort), site.name]), 'utf8').toString(
    'base64url'
  )
}

/** The position a cursor names, as a site to compare against (400 for one that isn't ours). */
function decode(cursor: string, sort: SiteSort): Sortable {
  try {
    const [order, key, name] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (order === sort && typeof key === 'string' && typeof name === 'string') {
      return { name, createdAt: key, updatedAt: key }
    }
  } catch {
    // falls through to the refusal
  }
  throw badRequest('That cursor is not from this list or this order', 'bad_cursor')
}

/**
 * `sites` in `sort` order, and with `limit` only the page after `cursor` (at most
 * SITE_LIST_PAGE_MAX) and the cursor for the next (null at the end).
 */
export function pageOfSites<T extends Sortable>(
  sites: readonly T[],
  req: PageRequest
): { sites: T[]; cursor?: string | null } {
  const sort = req.sort ?? DEFAULT_SITE_SORT
  const sorted = sortSites(sites, sort)
  if (req.limit === undefined) return { sites: sorted }
  const limit = Math.min(Math.max(1, Math.floor(req.limit)), SITE_LIST_PAGE_MAX)
  const compare = compareSites(sort)
  const at = req.cursor ? decode(req.cursor, sort) : null
  const found = at ? sorted.findIndex(s => compare(s, at) > 0) : 0
  const start = found === -1 ? sorted.length : found
  const page = sorted.slice(start, start + limit)
  const last = page.at(-1)
  return {
    sites: page,
    cursor: start + limit < sorted.length && last ? encode(sort, last) : null,
  }
}
