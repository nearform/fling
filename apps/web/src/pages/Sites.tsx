/**
 * Home: a plain header (greeting, count, search, order), then your sites — active or archived —
 * each as a compact `SiteCard` linking to its site page, narrowed by a client-side search kept in
 * `?q=`. The order (`sortSites`, last updated first by default) is kept in `?sort=` and
 * remembered in localStorage. No sites yet → the CLI quick start. With the `audiences`
 * capability, a Shared tab (`?view=shared`) lists the restricted sites others have shared with
 * you, each a `SharedSiteCard`, searched and ordered the same way. Admins also get All sites
 * (`?view=all`): every site on the instance from the site directory, by name, searched on the
 * server by name prefix and paged with "Load more", each an `AdminSiteCard` (the listing only).
 */
import {
  type AdminSite,
  DEFAULT_SITE_SORT,
  type SharedSite,
  SITE_SORTS,
  type SiteSort,
  sortSites,
} from '@fling/shared'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useDeferredValue, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminSiteCard } from '../components/AdminSiteCard'
import { SharedSiteCard } from '../components/SharedSiteCard'
import { SiteCard } from '../components/SiteCard'
import { SiteSearch } from '../components/SiteSearch'
import { useInstance } from '../hooks/instance'
import { useAdminSites, useMe, useSharedSites, useSites } from '../hooks/queries'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { allSitesCountLabel, showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { countLabel, filterSites } from '../lib/search'
import { chooseSiteSort, parseSiteSort, SITE_SORT_LABELS } from '../lib/sites'
import { QuickStart } from './GetStarted'

/** "Good morning" by the reader's local clock. */
export function greeting(hour: number): string {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * A plain page header: greeting, title, the count (kept in step with the search), the search and
 * the order (none for All sites, which lists by name).
 */
function SitesHeader({
  title,
  count,
  query,
  onQueryChange,
  searchByPrefix = false,
  sort,
  onSortChange,
}: {
  title: string
  count: string
  query: string
  onQueryChange: (q: string) => void
  searchByPrefix?: boolean
  sort?: SiteSort
  onSortChange: (sort: SiteSort) => void
}) {
  const { data: me } = useMe()
  const firstName = me?.name?.split(/\s+/)[0]

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <p className="text-xs text-secondary">
          {greeting(new Date().getHours())}
          {firstName ? `, ${firstName}` : ''}
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-secondary" aria-live="polite">
            {count}
          </p>
        </div>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <SiteSearch
          value={query}
          onChange={onQueryChange}
          className="min-w-0 flex-1 sm:w-72"
          {...(searchByPrefix && {
            placeholder: 'Name starts with…',
            label: 'Search every site by the start of its name',
          })}
        />
        {sort && (
          <select
            className="select select-sm w-auto shrink-0"
            aria-label="Order sites by"
            value={sort}
            onChange={e => onSortChange(parseSiteSort(e.target.value))}
          >
            {SITE_SORTS.map(s => (
              <option key={s} value={s}>
                {SITE_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  )
}

/** The Shared tab's body: loading, an error, nothing shared, nothing matching, or the rows. */
function SharedList({
  list,
  shown,
  query,
  onClear,
}: {
  list: ReturnType<typeof useSharedSites>
  shown: SharedSite[]
  query: string
  onClear: () => void
}) {
  if (list.isPending) return <Loading />
  if (list.isError) {
    return (
      <div className="alert alert-error text-sm" role="alert">
        {errorMessage(list.error)}
        <button type="button" className="btn btn-sm" onClick={() => list.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  if (list.data.length === 0) {
    return (
      <div className="surface-panel text-center text-sm text-secondary">
        Nothing shared with you yet. When someone limits a private site to you, or to a group you
        are in, it shows up here.
      </div>
    )
  }
  if (shown.length === 0) return <NoMatch query={query} label="shared " onClear={onClear} />
  return (
    <ul className="space-y-2">
      {shown.map(site => (
        <li key={site.name}>
          <SharedSiteCard site={site} />
        </li>
      ))}
    </ul>
  )
}

/** All sites' body (admins): loading, an error, nothing, nothing under the prefix, or the rows. */
function AllSitesList({
  list,
  rows,
  prefix,
  me,
  onClear,
}: {
  list: ReturnType<typeof useAdminSites>
  rows: AdminSite[]
  prefix: string
  me: string
  onClear: () => void
}) {
  if (list.isPending) return <Loading />
  if (list.isError) {
    return (
      <div className="alert alert-error text-sm" role="alert">
        {errorMessage(list.error)}
        <button type="button" className="btn btn-sm" onClick={() => list.refetch()}>
          Try again
        </button>
      </div>
    )
  }
  if (rows.length === 0) {
    if (prefix) return <NoMatch query={prefix} label="" onClear={onClear} />
    return (
      <div className="surface-panel text-center text-sm text-secondary">
        Nobody has flung anything on this instance yet.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {rows.map(site => (
          <li key={site.name}>
            <AdminSiteCard site={site} mine={site.owner === me} />
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            'Load more'
          )}
        </button>
      )}
    </div>
  )
}

function Loading() {
  return (
    <div className="grid place-items-center py-12">
      <span
        className="loading loading-spinner loading-md text-muted"
        role="status"
        aria-label="Loading"
      />
    </div>
  )
}

function NoMatch({ query, label, onClear }: { query: string; label: string; onClear: () => void }) {
  return (
    <div className="surface-panel space-y-3 text-center text-sm text-secondary">
      <p>
        No {label}sites match{' '}
        <span className="font-medium text-base-content">"{query.trim()}"</span>
      </p>
      <button type="button" className="btn btn-sm" onClick={onClear}>
        <XMarkIcon className="h-4 w-4" aria-hidden />
        Clear search
      </button>
    </div>
  )
}

export default function Sites() {
  const [params, setParams] = useSearchParams()
  const { data: me } = useMe()
  const sharing = useInstance()?.capabilities.audiences === true
  const admin = showsAdmin(me)
  const view = params.get('view')
  const archived = view === 'archived'
  const shared = sharing && view === 'shared'
  const all = admin && view === 'all'
  const query = params.get('q') ?? ''
  const searching = query.trim() !== ''
  const prefix = useDeferredValue(query.trim().toLowerCase())
  const allList = useAdminSites(prefix, all)
  const allRows = allList.data?.pages.flatMap(p => p.sites) ?? []
  const [savedSort, setSavedSort] = useLocalStoragePreference<string>(
    'sitesSort',
    DEFAULT_SITE_SORT
  )
  const sort = chooseSiteSort(params.get('sort'), savedSort)
  const active = useSites(false)
  const list = useSites(archived)
  const sharedList = useSharedSites(sharing)
  const shown = useMemo(
    () => sortSites(filterSites(list.data ?? [], query), sort),
    [list.data, query, sort]
  )
  const sharedShown = useMemo(
    () => sortSites(filterSites(sharedList.data ?? [], query), sort),
    [sharedList.data, query, sort]
  )

  const update = (key: 'view' | 'q' | 'sort', value: string | null) =>
    setParams(
      prev => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true }
    )
  const setView = (next: 'active' | 'archived' | 'shared' | 'all') =>
    update('view', next === 'active' ? null : next)
  const setQuery = (q: string) => update('q', q || null)
  const setSort = (next: SiteSort) => {
    setSavedSort(next)
    update('sort', next === DEFAULT_SITE_SORT ? null : next)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SitesHeader
        title={all ? 'All sites' : shared ? 'Shared with you' : 'Your sites'}
        count={
          all
            ? allSitesCountLabel({
                loaded: allList.data ? allRows.length : undefined,
                more: allList.hasNextPage,
                prefix,
              })
            : shared
              ? countLabel({
                  total: sharedList.data?.length,
                  shown: sharedShown.length,
                  archived: false,
                  shared: true,
                  searching,
                })
              : countLabel({ total: list.data?.length, shown: shown.length, archived, searching })
        }
        query={query}
        onQueryChange={setQuery}
        searchByPrefix={all}
        sort={all ? undefined : sort}
        onSortChange={setSort}
      />

      <div role="tablist" className="tabs tabs-border" aria-label="Which sites">
        <button
          type="button"
          role="tab"
          aria-selected={!archived && !shared && !all}
          className={`tab ${archived || shared || all ? '' : 'tab-active'}`}
          onClick={() => setView('active')}
        >
          Active
          {active.data && <span className="ml-1.5 text-muted">{active.data.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={archived}
          className={`tab ${archived ? 'tab-active' : ''}`}
          onClick={() => setView('archived')}
        >
          Archived
        </button>
        {sharing && (
          <button
            type="button"
            role="tab"
            aria-selected={shared}
            className={`tab ${shared ? 'tab-active' : ''}`}
            onClick={() => setView('shared')}
          >
            Shared with me
            {sharedList.data && <span className="ml-1.5 text-muted">{sharedList.data.length}</span>}
          </button>
        )}
        {admin && (
          <button
            type="button"
            role="tab"
            aria-selected={all}
            className={`tab ${all ? 'tab-active' : ''}`}
            onClick={() => setView('all')}
            title="Every site on this instance (admins)"
          >
            All sites
          </button>
        )}
      </div>

      {all ? (
        <AllSitesList
          list={allList}
          rows={allRows}
          prefix={prefix}
          me={me?.email ?? ''}
          onClear={() => setQuery('')}
        />
      ) : shared ? (
        <SharedList
          list={sharedList}
          shown={sharedShown}
          query={query}
          onClear={() => setQuery('')}
        />
      ) : list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(list.error)}
          <button type="button" className="btn btn-sm" onClick={() => list.refetch()}>
            Try again
          </button>
        </div>
      ) : list.data.length === 0 ? (
        archived ? (
          <div className="surface-panel text-center text-sm text-secondary">
            Nothing archived. Archived sites go offline but keep their files, so you can bring them
            back.
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              You haven't flung anything yet. Two commands and you have a link:
            </p>
            <QuickStart />
          </div>
        )
      ) : shown.length === 0 ? (
        <NoMatch query={query} label={archived ? 'archived ' : ''} onClear={() => setQuery('')} />
      ) : (
        <ul className="space-y-2">
          {shown.map(site => (
            <li key={site.name}>
              <SiteCard site={site} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
