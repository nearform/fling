/**
 * The site page's Metrics panel (`metrics` capability), for the site's owners, publishers and
 * admins (`site.metrics.read`): its views and pushes over the last 28 days and 12 months, when it
 * was last viewed and last pushed, and the days as the Sites page's Activity draws them (`Pulse`,
 * dense: a line you can read day by day, pushes marked beneath), so the two read alike. Views only
 * where the instance counts them (`viewCounts`); without, the panel shows pushes and says views
 * aren't counted. Counts only: nothing about who viewed exists to show.
 */
import { METRIC_DAYS, METRIC_MONTHS } from '@fling/shared/metrics'
import { useInstance } from '../../hooks/instance'
import { useSiteMetrics } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { fullDate, timeAgo, utcDate } from '../../lib/format'
import { Pulse } from '../usage/UsageCharts'
import '../usage/usage.css'
import { SiteSection } from './SiteSection'

export function SiteMetrics({ name }: { name: string }) {
  const instance = useInstance()
  const metrics = useSiteMetrics(name, true)
  const m = metrics.data

  return (
    <SiteSection
      title="Metrics"
      description={
        m && !m.viewCounts
          ? `Pushes: each time a version went live. ${instance?.name ?? 'This Fling'} doesn’t count views.`
          : 'Page loads and pushes (each time a version went live), by UTC day. Counts only: nothing is kept about who viewed.'
      }
    >
      {metrics.isError ? (
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(metrics.error)}
        </div>
      ) : !m ? (
        <span
          className="loading loading-spinner loading-sm text-muted"
          role="status"
          aria-label="Loading metrics"
        />
      ) : (
        <div className="site-metrics">
          <dl className="site-metrics-stats">
            {m.viewCounts && (
              <Stat label="Views" days={m.totals.days.views} months={m.totals.months.views} />
            )}
            <Stat label="Pushes" days={m.totals.days.pushes} months={m.totals.months.pushes} />
            {m.viewCounts && <When label="Last viewed" at={m.lastViewAt} />}
            <When label="Last pushed" at={m.lastPushAt} />
          </dl>
          <Pulse usage={m} dense across="this site" />
          {m.viewCounts && m.counting === false && (
            <p className="text-xs text-secondary">
              View counting is off on {instance?.name ?? 'this Fling'}: these are the views counted
              before it was turned off.
            </p>
          )}
          {m.since && (
            <p className="text-xs text-muted">
              Counted since <span title={fullDate(m.since)}>{utcDate(m.since)}</span>
            </p>
          )}
        </div>
      )}
    </SiteSection>
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
