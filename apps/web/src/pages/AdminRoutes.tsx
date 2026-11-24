/**
 * Admin → Routes (`/admin/routes`; admins only, the API answers 404 to anyone else): the route
 * table, which the edge reads to find each site's files. How full the store is where it has a
 * size limit, and the format the API writes, which an admin chooses here (route-format.ts), with
 * maintenance's rewrite of every site's routes into it, and how long maintenance's last lap of
 * every site took. Each says how much room is left at today's pace (lib/headroom.ts): how many
 * more routes fit, and how many more sites one run's sweep gets through.
 */
import type { AdminRouteTable, RouteFormat } from '@fling/shared'
import { PageHeader } from '../components/PageHeader'
import { useAdminRouteTable, useMe, useSetRouteFormat } from '../hooks/queries'
import { showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import {
  compactFits,
  lapRoom,
  roughly,
  routeRoom,
  share,
  shortDuration,
  size,
} from '../lib/headroom'

const FORMAT_NAMES: Record<RouteFormat, string> = { json: 'JSON', compact: 'Compact' }

/** From this share of its limit the store is nearly full (maintenance logs it; AWS alarms). */
const NEARLY_FULL = 0.7

const when = (iso: string) => new Date(iso).toLocaleString()

function Usage({ data }: { data: AdminRouteTable }) {
  const usage = data.usage
  if (!usage) {
    return (
      <p className="text-secondary">
        This instance's route store has no size limit, so there is nothing to fill up.
      </p>
    )
  }
  const full = usage.bytes / usage.limitBytes
  const room = routeRoom(usage)
  return (
    <div className="space-y-2">
      <p>
        <strong>{size(usage.bytes)}</strong> of {size(usage.limitBytes)} used (
        {share(usage.bytes, usage.limitBytes)})
      </p>
      <progress
        className={`progress w-full ${full >= NEARLY_FULL ? 'progress-warning' : ''}`}
        value={usage.bytes}
        max={usage.limitBytes}
      />
      {room && (
        <p>
          Its {room.routes.toLocaleString()} routes take about {size(room.perRoute)} each, so
          there's room for about <strong>{roughly(room.room)} more</strong>
          {compactFits(data.format) && full < NEARLY_FULL && (
            <>, and about three times that in Compact</>
          )}
          .
        </p>
      )}
      <p className="text-secondary">
        Each live site has a route, as does each live Path and share link.
      </p>
      {full >= NEARLY_FULL && (
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

function Lap({ data }: { data: AdminRouteTable }) {
  const { lastLap, maintenance } = data
  const every = duration(maintenance.everyMs)
  if (!lastLap) {
    return (
      <p className="text-secondary">
        Maintenance hasn't finished a lap of every site yet. It runs every {every} and goes on from
        where it stopped.
      </p>
    )
  }
  const room = lapRoom(lastLap, maintenance)
  const sites = (n: number) => `${n.toLocaleString()} site${n === 1 ? '' : 's'}`
  return (
    <div className="space-y-2">
      {room ? (
        room.runs === 1 ? (
          <p>
            The last lap went through all {sites(room.sites)} in{' '}
            <strong>{shortDuration(room.workMs)}</strong>, in one run, finished{' '}
            {when(lastLap.finishedAt)}. Maintenance runs every {every}, so no site waits longer than
            that for its sweep.
          </p>
        ) : (
          <p>
            The last lap took <strong>{room.runs} runs</strong> to go through all{' '}
            {sites(room.sites)} ({shortDuration(room.workMs)} of work), finished{' '}
            {when(lastLap.finishedAt)}: a site waits up to {duration(lastLap.lapMs)} for its sweep.
          </p>
        )
      ) : (
        <p>
          The last lap took <strong>{duration(lastLap.lapMs)}</strong>, finished{' '}
          {when(lastLap.finishedAt)}.
        </p>
      )}
      {room && (
        <p>
          A run works for up to {duration(maintenance.budgetMs)}: at this pace one run gets through
          about <strong>{roughly(room.perRun)} sites</strong>
          {room.perRun > room.sites ? (
            <>, so a lap stays within one run until there are about that many.</>
          ) : (
            <>. Beyond that, each extra run adds {every} to a site's wait.</>
          )}
        </p>
      )}
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
              <Usage data={routes.data} />
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
              <Lap data={routes.data} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
