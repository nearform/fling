/**
 * Admin → Usage (`/admin/usage`; admins, on an instance with the `metrics` capability; the API
 * answers 404 to anyone else): every site's views and pushes added together over the last 28
 * days and 12 months, and what maintenance's last lap of the site directory tallied of the sites
 * themselves: how many are live, how many were viewed lately, the most viewed and the longest
 * unused. Counts only: nothing about who viewed exists to show. Where the instance doesn't count
 * views, the page shows pushes and says so. A line counts the deleted sites still kept, linking to
 * Admin → Deleted.
 */
import '../components/usage/usage.css'
import { type InstanceUsage, METRIC_DAYS, METRIC_MONTHS } from '@fling/shared/metrics'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
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
import { useAdminUsage, useMe, useSetViewCounting } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { ADMIN_DELETED_PATH, deletedUsageText } from '../lib/deleted'
import { fullDate, timeAgo } from '../lib/format'
import {
  DUST_AFTER_DAYS,
  dayLabel,
  isQuiet,
  lapNotice,
  monthLabel,
  pulseCount,
  rolloutText,
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
      {usage.counting?.on === false && (
        <p className="text-sm text-secondary">
          View counting is off: these are the views counted before it was turned off. Pushes are
          still counted.
        </p>
      )}
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

/** How many deleted sites are kept, and about how much (a guide, like the view tally). */
function Deleted({ usage }: { usage: InstanceUsage }) {
  return (
    <Section id="deleted" title="Deleted sites" aside="Kept until restored or deleted for good">
      <p>
        {deletedUsageText(usage.deleted)}{' '}
        <Link className="link" to={ADMIN_DELETED_PATH}>
          See, restore or delete them for good
        </Link>
      </p>
    </Section>
  )
}

/**
 * The switch: view counting on or off for every site. Turning it off keeps the views counted so
 * far; either way maintenance applies it to every live site, which the section follows.
 */
function ViewCountingSwitch({ usage, fling }: { usage: InstanceUsage; fling: string }) {
  const set = useSetViewCounting()
  const c = usage.counting
  if (!c) return null
  const progress = rolloutText(c)
  const next = !c.on
  const confirm = next
    ? `Turn view counting on? Every live site's pages get the view beacon, without being published again, and views are counted from then on.`
    : `Turn view counting off? The view beacon comes off every site and no more views are counted. The views counted so far stay, and pushes are still counted.`
  return (
    <Section id="view-counting" title="View counting" aside="Whether the sites' pages count views">
      <div className="space-y-3">
        <p>
          <strong>{c.on ? 'On' : 'Off'}</strong>
          {c.setBy && c.setAt && (
            <span className="text-secondary">
              {' '}
              (turned {c.on ? 'on' : 'off'} by {c.setBy},{' '}
              <time dateTime={c.setAt} title={fullDate(c.setAt)}>
                {timeAgo(c.setAt)}
              </time>
              )
            </span>
          )}
        </p>
        {progress && (
          <p className="text-secondary" role="status">
            {progress}
          </p>
        )}
        <p className="text-secondary">
          {c.on
            ? `Each page carries a small script that tells the site, once per page load, that it was viewed. Turning it off takes the script off every site on ${fling}; the views counted so far stay.`
            : `Turning it on adds the script to every live site, without publishing them again. The views counted before it was turned off are still shown.`}
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={set.isPending}
          onClick={() => {
            if (window.confirm(confirm)) set.mutate(next)
          }}
        >
          {next ? 'Turn on for every site' : 'Turn off for every site'}
        </button>
        {set.isError && <p className="text-error">{errorMessage(set.error)}</p>}
      </div>
    </Section>
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
          <Deleted usage={usage.data} />
          <ViewCountingSwitch usage={usage.data} fling={fling} />
        </div>
      )}
    </div>
  )
}
