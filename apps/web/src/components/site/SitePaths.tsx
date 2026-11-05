/**
 * The site's Paths (`paths` capability): each top-level folder with its own versions, owners and
 * publishers, one row each with its folder (the link to its Path page), title, URL, when it last
 * changed, whether it is archived or not yet published, its owners where the reader is on the
 * site, and its Review and View links with their copy buttons. The section is left out while the site has no Paths. A long list gets a search (`?q=`)
 * and an order (`?sort=`), kept in the URL as on the Sites page.
 */
import type { SitePath } from '@fling/shared'
import { Link, useSearchParams } from 'react-router-dom'
import { useSitePaths } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { fullDate, timeAgo } from '../../lib/format'
import {
  DEFAULT_PATH_SORT,
  filterPaths,
  membersSummary,
  PATH_SEARCH_FROM,
  PATH_SORT_LABELS,
  PATH_SORTS,
  parsePathSort,
  pathHref,
  pathsCountLabel,
  shownFolder,
  sortPaths,
} from '../../lib/paths'
import { CommandLine } from '../CopyButton'
import { ReviewButton, ViewSiteButton } from '../SiteButtons'
import { SiteSearch } from '../SiteSearch'
import { SiteSection } from './SiteSection'

/** How to publish a Path of `name`, for the section's description. */
export const publishPathCommand = (name: string) =>
  `fling deploy ./plan --name ${name} --path <folder>`

export function SitePaths({ name, reviewable }: { name: string; reviewable: boolean }) {
  const paths = useSitePaths(name, true)
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const sort = parsePathSort(params.get('sort'))
  const setParam = (key: 'q' | 'sort', value: string, fallback: string) =>
    setParams(
      p => {
        const next = new URLSearchParams(p)
        if (value === fallback) next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true }
    )

  if (paths.isPending) return null
  if (paths.isError) {
    return (
      <SiteSection title="Paths">
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(paths.error)}
          <button type="button" className="btn btn-sm" onClick={() => paths.refetch()}>
            Try again
          </button>
        </div>
      </SiteSection>
    )
  }
  if (paths.data.length === 0) return null

  const all = paths.data
  const long = all.length >= PATH_SEARCH_FROM
  const searching = long && query.trim() !== ''
  const shown = sortPaths(long ? filterPaths(all, query) : all, long ? sort : DEFAULT_PATH_SORT)

  return (
    <SiteSection
      title="Paths"
      description="Each Path is a folder of this site with its own versions and owners. Publish one with:"
    >
      <CommandLine command={publishPathCommand(name)} />
      {long && (
        <div className="flex flex-wrap items-center gap-2">
          <SiteSearch
            value={query}
            onChange={q => setParam('q', q, '')}
            className="min-w-0 flex-1 sm:max-w-72"
            placeholder="Search Paths…"
            label="Search Paths by folder, title, URL or owner"
          />
          <select
            className="select select-sm w-auto shrink-0"
            aria-label="Order Paths by"
            value={sort}
            onChange={e => setParam('sort', parsePathSort(e.target.value), DEFAULT_PATH_SORT)}
          >
            {PATH_SORTS.map(s => (
              <option key={s} value={s}>
                {PATH_SORT_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="text-sm text-secondary" aria-live="polite">
            {pathsCountLabel(all.length, shown.length, searching)}
          </p>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">
          No Paths match “{query.trim()}”.{' '}
          <button type="button" className="link" onClick={() => setParam('q', '', '')}>
            Clear the search
          </button>
        </p>
      ) : (
        <PathsTable name={name} paths={shown} reviewable={reviewable} />
      )}
    </SiteSection>
  )
}

/** The Paths' rows, in the order given. */
export function PathsTable({
  name,
  paths,
  reviewable = false,
  now,
}: {
  name: string
  paths: readonly SitePath[]
  /** comments are on and the site isn't archived: each live Path gets its review link */
  reviewable?: boolean
  /** the clock for the relative times (tests) */
  now?: number
}) {
  const withOwners = paths.some(p => p.owners !== undefined)
  return (
    <div className="surface-inset overflow-x-auto">
      <table className="table table-xs">
        <thead>
          <tr>
            <th>Path</th>
            <th>Updated</th>
            {withOwners && <th>Owners</th>}
            <th>
              <span className="sr-only">Links</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {paths.map(path => {
            const owners = membersSummary(path.owners)
            const live = !path.archived && path.currentVersionId !== null
            return (
              <tr key={path.folder}>
                <td className="min-w-0">
                  <Link
                    to={pathHref(name, path.folder)}
                    className="link link-hover font-mono text-xs font-medium"
                    title={`Manage ${shownFolder(path.folder)}: versions, owners and publishers`}
                  >
                    {shownFolder(path.folder)}
                  </Link>
                  {path.archived && (
                    <span className="badge badge-sm badge-ghost ms-1.5">Archived</span>
                  )}
                  {!path.archived && path.currentVersionId === null && (
                    <span className="badge badge-sm badge-ghost ms-1.5">Not published</span>
                  )}
                  {path.title && (
                    <div className="text-xs text-secondary [overflow-wrap:anywhere]">
                      {path.title}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap" title={fullDate(path.updatedAt)}>
                  {timeAgo(path.updatedAt, now)}
                </td>
                {withOwners && (
                  <td className="text-xs text-secondary [overflow-wrap:anywhere]">
                    {owners || <span className="text-muted">The site’s owners</span>}
                  </td>
                )}
                <td className="text-end whitespace-nowrap">
                  {live && (
                    <span className="inline-flex items-center gap-1.5">
                      {reviewable && <ReviewButton name={name} path={shownFolder(path.folder)} />}
                      <ViewSiteButton name={`${name}${shownFolder(path.folder)}`} url={path.url} />
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
