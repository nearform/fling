/**
 * Home: a plain header (greeting, count, search, order), then your sites — active or archived —
 * each as a compact `SiteCard` linking to its site page, narrowed by a client-side search kept in
 * `?q=`. The order (`sortSites`, last updated first by default) is kept in `?sort=` and
 * remembered in localStorage. No sites yet → the CLI quick start. With the `audiences`
 * capability, a Shared tab (`?view=shared`) lists the restricted sites others have shared with
 * you, each a `SharedSiteCard`, searched and ordered the same way. A guest sees only that list,
 * with no tabs and no quick start: they review what is shared with them. Admins also get All sites
 * (`?view=all`): every site on the instance from the site directory, by name only, a page at a
 * time ("Load more"); its search is a name prefix the server answers (as you pause typing), and
 * `?owner=<email>` (Admin → Users links it) narrows it to the sites that address owns or publishes,
 * shown as a chip that clears it. Each is an `AdminSiteCard` (the listing only).
 *
 * Where the instance counts views (`metrics` and `viewCounts`), Active opens with your live sites' views and pushes together
 * (`MySitesStats`), folded or not as you left it, and each site has a sparkline of its 28 days
 * from the same answer (`SiteSpark`).
 *
 * With the `thumbnails` capability every tab shows each site's thumbnail, and the header's
 * List / Grid switch lays them out as rows or as thumbnail-led cards in as many columns as the
 * width holds; the choice is kept per browser. The lists use the page's whole width.
 */
import {
  DEFAULT_SITE_SORT,
  type SharedSite,
  SITE_SORTS,
  type SiteSort,
  sortSites,
} from '@fling/shared'
import {
  ArchiveBoxIcon,
  GlobeAltIcon,
  ShieldCheckIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { type ReactNode, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminSiteCard } from '../components/AdminSiteCard'
import { SharedSiteCard } from '../components/SharedSiteCard'
import { SiteCard } from '../components/SiteCard'
import { SiteSearch } from '../components/SiteSearch'
import { SitesLayoutToggle } from '../components/SitesLayoutToggle'
import { MySitesStats } from '../components/site/MySitesStats'
import { useInstance } from '../hooks/instance'
import { useAdminSites, useMe, useSharedSites, useSites, useSitesMetrics } from '../hooks/queries'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
import { showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { allSitesLabel, countLabel, filterSites } from '../lib/search'
import {
  chooseSiteSort,
  parseSiteSort,
  SITE_SORT_LABELS,
  type SitesLayout,
  sitesLayoutOf,
  sitesViewOf,
} from '../lib/sites'
import { activityShown } from '../lib/usage'
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
 * the order.
 */
function SitesHeader({
  title,
  count,
  query,
  onQueryChange,
  searchPlaceholder,
  searchLabel,
  sort,
  onSortChange,
  layout,
  onLayoutChange,
}: {
  title: string
  count: string
  query: string
  onQueryChange: (q: string) => void
  searchPlaceholder?: string
  searchLabel?: string
  /** absent where the list has one order (All sites, by name) */
  sort?: SiteSort
  onSortChange: (sort: SiteSort) => void
  /** absent without the `thumbnails` capability: rows only */
  layout?: SitesLayout
  onLayoutChange: (layout: SitesLayout) => void
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
          {...(searchPlaceholder && { placeholder: searchPlaceholder })}
          {...(searchLabel && { label: searchLabel })}
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
        {layout && <SitesLayoutToggle value={layout} onChange={onLayoutChange} />}
      </div>
    </header>
  )
}

/** The sites of any tab, as rows or as a grid of cards. */
function SiteItems({ layout, children }: { layout: SitesLayout; children: ReactNode }) {
  return <ul className={layout === 'grid' ? 'site-grid' : 'space-y-2'}>{children}</ul>
}

/** The Shared tab's body: loading, an error, nothing shared, nothing matching, or the sites. */
function SharedList({
  list,
  shown,
  query,
  layout,
  onClear,
}: {
  list: ReturnType<typeof useSharedSites>
  shown: SharedSite[]
  query: string
  layout: SitesLayout
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
    <SiteItems layout={layout}>
      {shown.map(site => (
        <li key={site.name}>
          <SharedSiteCard site={site} layout={layout} />
        </li>
      ))}
    </SiteItems>
  )
}

/**
 * All sites' body (admins): loading, an error, nothing, nothing matching the name prefix or the
 * owner, or the sites loaded so far and "Load more" while there are more.
 */
function AllSitesList({
  list,
  query,
  owner,
  me,
  layout,
  onClear,
}: {
  list: ReturnType<typeof useAdminSites>
  query: string
  owner: string
  me: string
  layout: SitesLayout
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
  const sites = list.data.pages.flatMap(p => p.sites)
  if (sites.length === 0) {
    if (query.trim()) return <NoMatch query={query} label="" onClear={onClear} starts />
    return (
      <div className="surface-panel text-center text-sm text-secondary">
        {owner
          ? `${owner} owns or publishes no sites.`
          : 'Nobody has flung anything on this instance yet.'}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <SiteItems layout={layout}>
        {sites.map(site => (
          <li key={site.name}>
            <AdminSiteCard site={site} mine={site.owner === me} layout={layout} />
          </li>
        ))}
      </SiteItems>
      {list.hasNextPage && (
        <div className="text-center">
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
        </div>
      )}
    </div>
  )
}

/** The owner All sites is narrowed to, as a chip that clears it. */
function OwnerChip({ owner, onClear }: { owner: string; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-secondary">Owned or published by</span>
      <span className="badge badge-outline gap-1 pr-0.5">
        {owner}
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square h-5 min-h-5 w-5"
          aria-label={`Show every owner's sites, not only ${owner}'s`}
          title="Every owner"
          onClick={onClear}
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
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

function NoMatch({
  query,
  label,
  onClear,
  starts = false,
}: {
  query: string
  label: string
  onClear: () => void
  /** the search is a name prefix (All sites) */
  starts?: boolean
}) {
  return (
    <div className="surface-panel space-y-3 text-center text-sm text-secondary">
      <p>
        No {label}sites {starts ? 'have a name starting with' : 'match'}{' '}
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
  const guest = me?.guest === true
  const sharing = useInstance()?.capabilities.audiences === true || guest
  const admin = showsAdmin(me)
  const view = sitesViewOf(params.get('view'), { guest, sharing, admin })
  const archived = view === 'archived'
  const shared = view === 'shared'
  const all = view === 'all'
  const query = params.get('q') ?? ''
  const searching = query.trim() !== ''
  const owner = all ? (params.get('owner') ?? '').trim().toLowerCase() : ''
  const prefix = useDebouncedValue(query.trim().toLowerCase())
  const allList = useAdminSites({ q: all ? prefix : '', owner }, all)
  const [savedSort, setSavedSort] = useLocalStoragePreference<string>(
    'sitesSort',
    DEFAULT_SITE_SORT
  )
  const sort = chooseSiteSort(params.get('sort'), savedSort)
  const thumbnails = useInstance()?.capabilities.thumbnails === true
  // Only where views are counted (SITE_VIEW_COUNTS): without, neither is shown nor asked for.
  const stats = activityShown(useInstance())
  const [savedLayout, setLayout] = useLocalStoragePreference<string>('sitesLayout', 'list')
  const layout = sitesLayoutOf(savedLayout, thumbnails)
  // Live sites come with their days and them all added up (the strip), in the one answer.
  const active = useSites(false, !guest, stats)
  const metrics = useSitesMetrics(stats && !guest)
  // The busiest day of any of them: every site's line is coloured against it.
  const sparkScale = useMemo(
    () => Math.max(0, ...(active.data ?? []).flatMap(s => s.days?.views ?? [])),
    [active.data]
  )
  const list = useSites(archived, !guest, stats)
  const sharedList = useSharedSites(sharing)
  const shown = useMemo(
    () => sortSites(filterSites(list.data ?? [], query), sort),
    [list.data, query, sort]
  )
  const sharedShown = useMemo(
    () => sortSites(filterSites(sharedList.data ?? [], query), sort),
    [sharedList.data, query, sort]
  )

  const update = (key: 'view' | 'q' | 'sort' | 'owner', value: string | null) =>
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
    <div className="space-y-4">
      <SitesHeader
        title={all ? 'All sites' : shared ? 'Shared with you' : 'Your sites'}
        count={
          all
            ? allSitesLabel({
                loaded: allList.data?.pages.reduce((n, p) => n + p.sites.length, 0),
                more: allList.hasNextPage,
                filtered: searching || owner !== '',
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
        {...(all
          ? { searchPlaceholder: 'Name starts with…', searchLabel: 'Search all sites by name' }
          : { sort })}
        onSortChange={setSort}
        {...(thumbnails && { layout })}
        onLayoutChange={setLayout}
      />

      {!guest && !archived && !shared && !all && stats && (active.data?.length ?? 0) > 0 && (
        <MySitesStats metrics={metrics} />
      )}

      {!guest && (
        <div role="tablist" className="tabs tabs-border" aria-label="Which sites">
          <button
            type="button"
            role="tab"
            aria-selected={!archived && !shared && !all}
            className={`tab ${archived || shared || all ? '' : 'tab-active'}`}
            onClick={() => setView('active')}
          >
            <GlobeAltIcon className="mr-1.5 h-4 w-4" aria-hidden />
            Active
            {active.data && <span className="ml-1.5 text-muted">{active.data.length}</span>}
          </button>
          {sharing && (
            <button
              type="button"
              role="tab"
              aria-selected={shared}
              className={`tab ${shared ? 'tab-active' : ''}`}
              onClick={() => setView('shared')}
            >
              <UserGroupIcon className="mr-1.5 h-4 w-4" aria-hidden />
              Shared with me
              {sharedList.data && (
                <span className="ml-1.5 text-muted">{sharedList.data.length}</span>
              )}
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={archived}
            className={`tab ${archived ? 'tab-active' : ''}`}
            onClick={() => setView('archived')}
          >
            <ArchiveBoxIcon className="mr-1.5 h-4 w-4" aria-hidden />
            Archived
          </button>
          {admin && (
            <button
              type="button"
              role="tab"
              aria-selected={all}
              className={`tab ${all ? 'tab-active' : ''}`}
              onClick={() => setView('all')}
              title="Every site on this instance (admins)"
            >
              <ShieldCheckIcon className="mr-1.5 h-4 w-4" aria-hidden />
              All sites
            </button>
          )}
        </div>
      )}

      {all && owner && <OwnerChip owner={owner} onClear={() => update('owner', null)} />}

      {all ? (
        <AllSitesList
          list={allList}
          query={query}
          owner={owner}
          me={me?.email ?? ''}
          layout={layout}
          onClear={() => setQuery('')}
        />
      ) : shared ? (
        <SharedList
          list={sharedList}
          shown={sharedShown}
          query={query}
          layout={layout}
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
        <SiteItems layout={layout}>
          {shown.map(site => {
            const counts = site.days?.views
            return (
              <li key={site.name}>
                <SiteCard
                  site={site}
                  layout={layout}
                  {...(counts ? { spark: { views: counts, scale: sparkScale } } : {})}
                />
              </li>
            )
          })}
        </SiteItems>
      )}
    </div>
  )
}
