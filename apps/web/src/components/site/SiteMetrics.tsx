/**
 * The site page's Metrics panel (`metrics` capability), for the site's owners, publishers and
 * admins (`site.metrics.read`): its views and pushes over the last 28 days and 12 months, when it
 * was last viewed and last pushed, and a bar a day for the 28 days. Views only where the instance
 * counts them (`viewCounts`); without, the panel shows pushes and says views aren't counted.
 * Counts only: nothing about who viewed exists to show.
 */
import {
  METRIC_DAYS,
  METRIC_MONTHS,
  type SiteMetrics as SiteMetricsData,
} from '@fling/shared/metrics'
import { useInstance } from '../../hooks/instance'
import { useSiteMetrics } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { fullDate, timeAgo, utcDate } from '../../lib/format'
import { chartedCount, chartSummary, countLabel, metricBars } from '../../lib/metrics'
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
          <DayChart metrics={m} />
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
      <dt className="text-sm text-secondary">{label}</dt>
      <dd>
        <span className="text-xl font-medium tabular-nums">{days.toLocaleString()}</span>
        <span className="text-sm text-secondary"> in {METRIC_DAYS} days</span>
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
      <dt className="text-sm text-secondary">{label}</dt>
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

/** A bar a day, oldest first; each bar's title says its day and count. */
function DayChart({ metrics }: { metrics: SiteMetricsData }) {
  const key = chartedCount(metrics)
  const bars = metricBars(metrics, key)
  const height = 40
  return (
    <figure className="site-metrics-chart">
      <svg
        viewBox={`0 0 ${bars.length * 4} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={chartSummary(bars, key)}
      >
        {bars.map((b, i) => {
          // An empty day still shows, as a sliver on the baseline.
          const h = Math.max(1, b.ratio * height)
          return (
            <rect
              key={b.day}
              x={i * 4 + 0.5}
              y={height - h}
              width={3}
              height={h}
              data-empty={b.count === 0 ? '' : undefined}
            >
              <title>{`${b.day}: ${countLabel(b.count, key)}`}</title>
            </rect>
          )
        })}
      </svg>
      <figcaption className="flex justify-between text-xs text-muted tabular-nums">
        <span>{bars[0]?.day}</span>
        <span>{key === 'views' ? 'Views' : 'Pushes'} per day</span>
        <span>Today</span>
      </figcaption>
    </figure>
  )
}
