/**
 * Home: a plain header (greeting, count, search, order), then your sites — active or archived —
 * each as a compact `SiteCard` linking to its site page, narrowed by a client-side search kept in
 * `?q=`. The order (`sortSites`, last updated first by default) is kept in `?sort=` and
 * remembered in localStorage. No sites yet → the CLI quick start.
 */
import { DEFAULT_SITE_SORT, SITE_SORTS, type SiteSort, sortSites } from '@fling/shared'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SiteCard } from '../components/SiteCard'
import { SiteSearch } from '../components/SiteSearch'
import { useMe, useSites } from '../hooks/queries'
import { useLocalStoragePreference } from '../hooks/useLocalStoragePreference'
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
 * the order.
 */
function SitesHeader({
  count,
  query,
  onQueryChange,
  sort,
  onSortChange,
}: {
  count: string
  query: string
  onQueryChange: (q: string) => void
  sort: SiteSort
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
          <h1 className="text-xl font-semibold tracking-tight">Your sites</h1>
          <p className="text-sm text-secondary" aria-live="polite">
            {count}
          </p>
        </div>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <SiteSearch value={query} onChange={onQueryChange} className="min-w-0 flex-1 sm:w-72" />
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
      </div>
    </header>
  )
}

export default function Sites() {
  const [params, setParams] = useSearchParams()
  const archived = params.get('view') === 'archived'
  const query = params.get('q') ?? ''
  const searching = query.trim() !== ''
  const [savedSort, setSavedSort] = useLocalStoragePreference<string>(
    'sitesSort',
    DEFAULT_SITE_SORT
  )
  const sort = chooseSiteSort(params.get('sort'), savedSort)
  const active = useSites(false)
  const list = useSites(archived)
  const shown = useMemo(
    () => sortSites(filterSites(list.data ?? [], query), sort),
    [list.data, query, sort]
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
  const setView = (view: 'active' | 'archived') => update('view', view === 'archived' ? view : null)
  const setQuery = (q: string) => update('q', q || null)
  const setSort = (next: SiteSort) => {
    setSavedSort(next)
    update('sort', next === DEFAULT_SITE_SORT ? null : next)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <SitesHeader
        count={countLabel({ total: list.data?.length, shown: shown.length, archived, searching })}
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        onSortChange={setSort}
      />

      <div role="tablist" className="tabs tabs-border" aria-label="Which sites">
        <button
          type="button"
          role="tab"
          aria-selected={!archived}
          className={`tab ${archived ? '' : 'tab-active'}`}
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
      </div>

      {list.isPending ? (
        <div className="grid place-items-center py-12">
          <span
            className="loading loading-spinner loading-md text-muted"
            role="status"
            aria-label="Loading"
          />
        </div>
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
        <div className="surface-panel space-y-3 text-center text-sm text-secondary">
          <p>
            No {archived ? 'archived ' : ''}sites match{' '}
            <span className="font-medium text-base-content">"{query.trim()}"</span>
          </p>
          <button type="button" className="btn btn-sm" onClick={() => setQuery('')}>
            <XMarkIcon className="h-4 w-4" aria-hidden />
            Clear search
          </button>
        </div>
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
