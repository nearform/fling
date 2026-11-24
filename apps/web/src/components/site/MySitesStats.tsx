/**
 * The Sites page's strip, where the instance counts views (lib/usage.ts `activityShown`): the views
 * and pushes of every live site the person owns or publishes, added up, as a dense version of
 * Admin → Usage's pulse. They come with the list of those sites (`GET /api/sites?metrics=1`,
 * `useSitesMetrics`), read in one batch. Folded (as it starts, and as it stays once left so, per
 * browser) it is one row: the days as a small trend and their totals, at the row's end.
 */
import { METRIC_DAYS, METRIC_MONTHS, type SitesMetrics } from '@fling/shared/metrics'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import type { UseQueryResult } from '@tanstack/react-query'
import { useId } from 'react'
import { useInstance } from '../../hooks/instance'
import { useBooleanPreference } from '../../hooks/useLocalStoragePreference'
import { errorMessage } from '../../lib/api'
import { fullDate, timeAgo } from '../../lib/format'
import { countLabel } from '../../lib/metrics'
import { pulseCount } from '../../lib/usage'
import { DayTrend } from '../usage/DayTrend'
import { Pulse } from '../usage/UsageCharts'
import '../usage/usage.css'

export function MySitesStats({ metrics }: { metrics: UseQueryResult<SitesMetrics | null> }) {
  const id = useId()
  const instance = useInstance()
  const [open, setOpen] = useBooleanPreference('sitesStatsOpen', false)
  const m = metrics.data

  return (
    <section className="usage-strip surface-panel" aria-labelledby={`${id}-title`}>
      <div className="usage-strip-head">
        <button
          type="button"
          className="usage-strip-toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(o => !o)}
        >
          <ChevronRightIcon className="usage-strip-chevron h-4 w-4" aria-hidden />
          <span id={`${id}-title`} className="text-sm font-medium">
            Activity
          </span>
          <span className="text-xs text-muted">Your live sites together</span>
        </button>
        {!open && m && <Glance metrics={m} />}
      </div>
      {open && (
        <div id={`${id}-body`} className="usage-strip-body">
          {metrics.isError ? (
            <p className="text-sm text-error">{errorMessage(metrics.error)}</p>
          ) : !m ? (
            <span
              className="loading loading-spinner loading-sm text-muted"
              role="status"
              aria-label="Loading activity"
            />
          ) : (
            <>
              <dl className="usage-strip-stats">
                {m.viewCounts && (
                  <Stat label="Views" days={m.totals.days.views} months={m.totals.months.views} />
                )}
                <Stat label="Pushes" days={m.totals.days.pushes} months={m.totals.months.pushes} />
                {m.viewCounts && <When label="Last viewed" at={m.lastViewAt} />}
                <When label="Last pushed" at={m.lastPushAt} />
              </dl>
              <Pulse usage={m} dense across="your live sites" />
              {(m.sites < m.of || (m.viewCounts && m.counting === false)) && (
                <p className="text-xs text-secondary">
                  {m.sites < m.of &&
                    `Your ${m.sites.toLocaleString()} most recently updated sites, of ${m.of.toLocaleString()}. `}
                  {m.viewCounts &&
                    m.counting === false &&
                    `View counting is off on ${instance?.name ?? 'this Fling'}: these are the views counted before it was turned off.`}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** Folded: the 28 days as a small trend (`DayTrend`), then their totals, at the row's end. */
function Glance({ metrics: m }: { metrics: SitesMetrics }) {
  const key = pulseCount(m)
  return (
    <p className="usage-strip-glance text-xs text-secondary tabular-nums">
      <DayTrend counts={m.days.map(d => d[key])} className="usage-strip-trend" />
      <span>
        {m.viewCounts && <>{countLabel(m.totals.days.views, 'views')} · </>}
        {countLabel(m.totals.days.pushes, 'pushes')} in {METRIC_DAYS} days
        {m.viewCounts && m.lastViewAt && <> · last viewed {timeAgo(m.lastViewAt)}</>}
      </span>
    </p>
  )
}

function Stat({ label, days, months }: { label: string; days: number; months: number }) {
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd>
        <span className="text-lg font-semibold tabular-nums">{days.toLocaleString()}</span>
        <span className="text-xs text-secondary"> in {METRIC_DAYS} days</span>
        <span className="block text-xs text-muted tabular-nums">
          {months.toLocaleString()} in {METRIC_MONTHS} months
        </span>
      </dd>
    </div>
  )
}

function When({ label, at }: { label: string; at: string | null }) {
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="text-sm">
        {at ? (
          <span title={fullDate(at)}>{timeAgo(at)}</span>
        ) : (
          <span className="text-muted">Never</span>
        )}
      </dd>
    </div>
  )
}
