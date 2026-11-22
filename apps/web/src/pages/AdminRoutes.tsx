/**
 * Admin → Routes (`/admin/routes`; admins only, the API answers 404 to anyone else): the route
 * table, which the edge reads to find each site's files. How full the store is where it has a
 * size limit, and the format the API writes, which an admin chooses here (route-format.ts), with
 * maintenance's rewrite of every site's routes into it, and how long maintenance's last lap of
 * every site took.
 */
import type { AdminRouteTable, RouteFormat } from '@fling/shared'
import { PageHeader } from '../components/PageHeader'
import { useAdminRouteTable, useMe, useSetRouteFormat } from '../hooks/queries'
import { showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'

const FORMAT_NAMES: Record<RouteFormat, string> = { json: 'JSON', compact: 'Compact' }

/** From this share of its limit the store is nearly full (maintenance logs it; AWS alarms). */
const NEARLY_FULL = 0.7

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`
const when = (iso: string) => new Date(iso).toLocaleString()

function Usage({ usage }: { usage: AdminRouteTable['usage'] }) {
  if (!usage) {
    return (
      <p className="text-secondary">
        This instance's route store has no size limit, so there is nothing to fill up.
      </p>
    )
  }
  const share = usage.bytes / usage.limitBytes
  return (
    <div className="space-y-2">
      <p>
        <strong>{megabytes(usage.bytes)}</strong> of {megabytes(usage.limitBytes)} used (
        {Math.round(share * 100)}%)
      </p>
      <progress
        className={`progress w-full ${share >= NEARLY_FULL ? 'progress-warning' : ''}`}
        value={usage.bytes}
        max={usage.limitBytes}
      />
      {share >= NEARLY_FULL && (
        <p className="text-warning">
          Nearly full. Switching to Compact makes room; archiving sites nobody uses frees theirs.
        </p>
      )}
    </div>
  )
}

/** A lap's length, to the minute (a lap of a few sites is under one). */
function duration(ms: number) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 6) / 10
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 2.4) / 10} days`
}

function Lap({ lastLap }: { lastLap: AdminRouteTable['lastLap'] }) {
  if (!lastLap) {
    return (
      <p className="text-secondary">
        Maintenance hasn't finished a lap of every site yet. It runs every 15 minutes and goes on
        from where it stopped.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p>
        The last lap took <strong>{duration(lastLap.lapMs)}</strong>, finished{' '}
        {when(lastLap.finishedAt)}.
      </p>
      <p className="text-secondary">
        Every site is maintained at least once a lap: a lap's length is how long a site waits for
        what nothing queued, such as a change of version retention.
      </p>
    </div>
  )
}

function Format({ data }: { data: AdminRouteTable }) {
  const choose = useSetRouteFormat()
  const other: RouteFormat = data.format === 'json' ? 'compact' : 'json'
  const rewrite = data.rewrite
  return (
    <div className="space-y-3">
      <p>
        <strong>{FORMAT_NAMES[data.format]}</strong>
        {data.setBy && data.setAt && (
          <span className="text-secondary">
            {' '}
            (chosen by {data.setBy}, {when(data.setAt)})
          </span>
        )}
      </p>
      {rewrite &&
        (rewrite.finishedAt ? (
          <p className="text-secondary">
            Every site's routes are in this format: {rewrite.sites} rewritten, finished{' '}
            {when(rewrite.finishedAt)}.
          </p>
        ) : (
          <p className="text-secondary">
            Maintenance is rewriting every site's routes into this format: {rewrite.sites} done so
            far.
          </p>
        ))}
      <p className="text-secondary">
        Compact takes about a third of the space. Releases before 0.16.0 read only JSON: before
        rolling back to one, switch to JSON and wait until the rewrite has finished.
      </p>
      <button
        type="button"
        className="btn btn-sm"
        disabled={choose.isPending}
        onClick={() => {
          if (window.confirm(`Write ${FORMAT_NAMES[other]} and rewrite every site's routes?`)) {
            choose.mutate(other)
          }
        }}
      >
        Switch to {FORMAT_NAMES[other]}
      </button>
      {choose.isError && <p className="text-error">{errorMessage(choose.error)}</p>}
    </div>
  )
}

export default function AdminRoutes() {
  const { data: me } = useMe()
  const allowed = showsAdmin(me)
  const routes = useAdminRouteTable(allowed)

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Routes"
          description="The route table the edge reads to find every site's files: how full it is, the format its entries are written in, and how long maintenance takes to go round every site."
        />
      </div>
      {routes.isPending ? (
        <div className="surface-panel text-center">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading"
          />
        </div>
      ) : routes.isError ? (
        <div className="surface-panel text-sm text-error">{errorMessage(routes.error)}</div>
      ) : (
        <>
          <section id="usage" className="space-y-3">
            <h2 className="text-base font-semibold">Usage</h2>
            <div className="surface-panel text-sm">
              <Usage usage={routes.data.usage} />
            </div>
          </section>
          <section id="format" className="space-y-3">
            <h2 className="text-base font-semibold">Format</h2>
            <div className="surface-panel text-sm">
              <Format data={routes.data} />
            </div>
          </section>
          <section id="maintenance" className="space-y-3">
            <h2 className="text-base font-semibold">Maintenance</h2>
            <div className="surface-panel text-sm">
              <Lap lastLap={routes.data.lastLap} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
