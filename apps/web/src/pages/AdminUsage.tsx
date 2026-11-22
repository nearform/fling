/**
 * Admin → Usage (`/admin/usage`; admins, on an instance with the `metrics` capability; the API
 * answers 404 to anyone else): every site's views and pushes added together over the last 28
 * days and 12 months, and what maintenance's last lap of the site directory tallied of the sites
 * themselves: how many are live, how many were viewed lately, the most viewed and the longest
 * unused. Counts only: nothing about who viewed exists to show. Where the instance doesn't count
 * views, the page shows pushes and says so.
 */
import '../components/usage/usage.css'
import { type InstanceUsage, METRIC_DAYS, METRIC_MONTHS } from '@fling/shared/metrics'
import type { ReactNode } from 'react'
import { PageHeader } from '../components/PageHeader'
import {
  ActivityRings,
  CountUp,
  GatheringDust,
  Heatmap,
  MonthStrip,
  MostViewed,
  Pulse,
} from '../components/usage/UsageCharts'
import { useInstance } from '../hooks/instance'
import { useAdminUsage, useMe } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'
import {
  DUST_AFTER_DAYS,
  dayLabel,
  isQuiet,
  lapNotice,
  monthLabel,
  pulseCount,
  showsUsageAdmin,
} from '../lib/usage'

function Total({ label, days, months }: { label: string; days: number; months: number }) {
  return (
    <div className="usage-total">
      <dt>{label}</dt>
      <dd>
        <span className="usage-total-big tabular-nums">
          <CountUp value={days} />
        </span>
        <span className="text-sm text-secondary"> in {METRIC_DAYS} days</span>
        <span className="block text-xs text-muted tabular-nums">
          <CountUp value={months} ms={1200} /> in {METRIC_MONTHS} months
        </span>
      </dd>
    </div>
  )
}

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-3">
      <header className="usage-section-head">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {aside && <p className="text-sm text-secondary">{aside}</p>}
      </header>
      <div className="usage-section surface-panel text-sm">{children}</div>
    </section>
  )
}

/** Every number the charts draw, as tables, for anyone who'd rather read them. */
function Numbers({ usage }: { usage: InstanceUsage }) {
  const views = usage.viewCounts
  return (
    <details className="usage-numbers">
      <summary className="text-sm">The numbers</summary>
      <div className="usage-numbers-tables">
        <table className="table table-xs">
          <caption className="text-xs text-muted">By UTC day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {views && <th scope="col">Views</th>}
              <th scope="col">Pushes</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {[...usage.days].reverse().map(d => (
              <tr key={d.day}>
                <th scope="row">{dayLabel(d.day)}</th>
                {views && <td>{d.views.toLocaleString()}</td>}
                <td>{d.pushes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="table table-xs">
          <caption className="text-xs text-muted">By month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {views && <th scope="col">Views</th>}
              <th scope="col">Pushes</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {[...usage.months].reverse().map(m => (
              <tr key={m.month}>
                <th scope="row">{monthLabel(m.month)}</th>
                {views && <td>{m.views.toLocaleString()}</td>}
                <td>{m.pushes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

function Activity({ usage, fling }: { usage: InstanceUsage; fling: string }) {
  const key = pulseCount(usage)
  const quiet = isQuiet(usage)
  return (
    <Section id="activity" title="Activity" aside="Every site together">
      <dl className="usage-totals">
        {usage.viewCounts && (
          <Total label="Views" days={usage.totals.days.views} months={usage.totals.months.views} />
        )}
        <Total label="Pushes" days={usage.totals.days.pushes} months={usage.totals.months.pushes} />
      </dl>
      {!usage.viewCounts && (
        <p className="text-sm text-secondary">
          {fling} doesn’t count views, so this is pushes: each time a version went live.
        </p>
      )}
      <div className="usage-pulse-wrap">
        <Pulse usage={usage} />
        {quiet && (
          <p className="usage-quiet text-sm text-secondary">
            All quiet so far. {key === 'views' ? 'Views and pushes' : 'Pushes'} show up here as they
            happen.
          </p>
        )}
      </div>
      <div className="usage-calendars">
        <div>
          <h3 className="usage-subhead">Last {METRIC_DAYS} days</h3>
          <Heatmap usage={usage} />
        </div>
        <div>
          <h3 className="usage-subhead">Last {METRIC_MONTHS} months</h3>
          <MonthStrip usage={usage} />
        </div>
      </div>
      <Numbers usage={usage} />
    </Section>
  )
}

function Sites({ usage, fling }: { usage: InstanceUsage; fling: string }) {
  const notice = lapNotice(usage)
  const lap = usage.lap
  const asOf = lap ? (
    <>
      As of{' '}
      <time dateTime={lap.finishedAt} title={fullDate(lap.finishedAt)}>
        {timeAgo(lap.finishedAt)}
      </time>
      , from maintenance’s last lap of every site
    </>
  ) : undefined
  return (
    <>
      {notice && (
        <p className="usage-notice text-sm" data-tone={notice.tone} role="status">
          {notice.text}
        </p>
      )}
      {lap && (
        <>
          {usage.viewCounts ? (
            <Section id="lively" title="How lively the sites are" aside={asOf}>
              <ActivityRings lap={lap} />
            </Section>
          ) : (
            <p className="usage-notice text-sm" data-tone="info">
              Views aren’t counted on {fling}, so there are no viewed or most-viewed sites to show.
            </p>
          )}
          <div className="usage-lists">
            {usage.viewCounts && (
              <Section
                id="most-viewed"
                title="Most viewed"
                aside={`Live sites, over ${METRIC_DAYS} days`}
              >
                <MostViewed top={lap.top} />
              </Section>
            )}
            <Section
              id="gathering-dust"
              title="Gathering dust"
              aside={`Live sites not viewed or pushed for ${DUST_AFTER_DAYS} days or more`}
            >
              <GatheringDust idle={lap.idle} />
            </Section>
          </div>
        </>
      )}
    </>
  )
}

export default function AdminUsage() {
  const { data: me } = useMe()
  const instance = useInstance()
  const allowed = showsUsageAdmin(me, instance)
  const usage = useAdminUsage(allowed)
  const fling = instance?.name ?? 'this Fling'

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : me?.admin
            ? 'This Fling doesn’t keep metrics.'
            : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Usage"
          description="How much every site is viewed and pushed to, and which sites are busy or quiet. Counts only: nothing is kept about who viewed."
        />
      </div>
      {usage.isPending ? (
        <div className="surface-panel text-center">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading usage"
          />
        </div>
      ) : usage.isError ? (
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(usage.error)}
          <button type="button" className="btn btn-sm" onClick={() => usage.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="usage-page">
          <Activity usage={usage.data} fling={fling} />
          <Sites usage={usage.data} fling={fling} />
        </div>
      )}
    </div>
  )
}
