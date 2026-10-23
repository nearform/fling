/**
 * Home: the greeting banner (the login page's thread, contained, in the theme's own tone), then
 * your sites — active or archived — each as a `SiteCard`. No sites yet → the CLI quick start.
 */
import { PauseIcon, PlayIcon, RocketLaunchIcon } from '@heroicons/react/24/outline'
import { Link, useSearchParams } from 'react-router-dom'
import { SiteCard } from '../components/SiteCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { useMe, useSites } from '../hooks/queries'
import { useThreadTone } from '../hooks/useDocumentTheme'
import { useBooleanPreference } from '../hooks/useLocalStoragePreference'
import { errorMessage } from '../lib/api'
import { QuickStart } from './GetStarted'

/** "Good morning" by the reader's local clock. */
export function greeting(hour: number): string {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Banner({ liveCount }: { liveCount: number | undefined }) {
  const { data: me } = useMe()
  const [threadPaused, setThreadPaused] = useBooleanPreference('home.thread.paused', false)
  const threadTone = useThreadTone()
  const firstName = me?.name?.split(/\s+/)[0]

  return (
    <header className="surface-panel relative isolate overflow-hidden">
      <ThreadBackground contained paused={threadPaused} tone={threadTone} />
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square absolute top-2 right-2 z-10 opacity-60 hover:opacity-100"
        onClick={() => setThreadPaused(p => !p)}
        aria-pressed={threadPaused}
        aria-label={threadPaused ? 'Play the animation' : 'Pause the animation'}
        title={threadPaused ? 'Play the animation' : 'Pause the animation'}
      >
        {threadPaused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />}
      </button>
      <div className="relative flex flex-wrap items-end justify-between gap-4 py-2">
        <div className="min-w-0">
          <p className="text-sm text-secondary">
            {greeting(new Date().getHours())}
            {firstName ? `, ${firstName}` : ''}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Your sites</h1>
          <p className="mt-1 text-sm text-secondary">
            {liveCount === undefined
              ? 'Everything you have flung, in one list'
              : liveCount === 0
                ? 'Nothing flung yet'
                : `${liveCount} live ${liveCount === 1 ? 'site' : 'sites'}`}
          </p>
        </div>
        <Link to="/get-started" className="btn btn-sm btn-ghost">
          <RocketLaunchIcon className="h-4 w-4" />
          How to fling
        </Link>
      </div>
    </header>
  )
}

export default function Sites() {
  const [params, setParams] = useSearchParams()
  const archived = params.get('view') === 'archived'
  const active = useSites(false)
  const list = useSites(archived)

  const setView = (view: 'active' | 'archived') =>
    setParams(view === 'archived' ? { view } : {}, { replace: true })

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Banner liveCount={active.data?.length} />

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
      ) : (
        <ul className="space-y-4">
          {list.data.map(site => (
            <li key={site.name}>
              <SiteCard site={site} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
