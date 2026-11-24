/**
 * Admin → Usage, worked out apart from React: who sees it, and the shapes its charts draw from the
 * instance's usage (`GET /api/admin/usage`, @fling/shared/metrics). Counts only: views where the
 * instance counts them (`viewCounts`), pushes always, and the site tallies of maintenance's last
 * lap of the site directory.
 */
import type { InstanceMetadata, Me } from '@fling/shared'
import type { InstanceUsage, UsageTally, ViewCounting } from '@fling/shared/metrics'
import { showsAdmin } from './admin'
import { countLabel } from './metrics'

/** Admin → Usage. */
/**
 * Whether the Sites page shows your sites' activity and each site's sparkline (and asks for them):
 * only where the instance counts views. Turned off by its operator (SITE_VIEW_COUNTS=off), there
 * are no views to show, so neither appears and nothing is read.
 */
export const activityShown = (
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
) => instance?.capabilities.metrics === true && instance.capabilities.viewCounts === true

export const ADMIN_USAGE_PATH = '/admin/usage'

/** Whether Admin offers Usage: admins, on an instance with metrics. */
export const showsUsageAdmin = (
  me: Me | null | undefined,
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
) => showsAdmin(me) && instance?.capabilities.metrics === true

/** Whether All sites shows when each site was last viewed: metrics on, and views counted. */
export const showsLastViewed = (
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
) => instance?.capabilities.metrics === true && instance.capabilities.viewCounts === true

type Count = 'views' | 'pushes'

/** What the pulse charts: views where they are counted, else pushes. */
export const pulseCount = (u: Pick<InstanceUsage, 'viewCounts'>): Count =>
  u.viewCounts ? 'views' : 'pushes'

/** A whole number as a share of another, 0–1; 0 when there is nothing to share. */
export const share = (n: number, of: number) => (of > 0 ? Math.min(1, n / of) : 0)

/** `42%`, rounded; a share above 0 never shows as 0%. */
export function percent(s: number): string {
  if (s > 0 && s < 0.005) return '<1%'
  return `${Math.round(s * 100)}%`
}

/** The index of the busiest day, the latest of a tie; null when every day is 0. */
export function peakIndex(days: InstanceUsage['days'], key: Count): number | null {
  let peak: number | null = null
  days.forEach((d, i) => {
    if (d[key] > 0 && (peak === null || d[key] >= (days[peak]?.[key] ?? 0))) peak = i
  })
  return peak
}

export interface PulsePoint {
  x: number
  y: number
}

/** The days as points in a `width` × `height` box: oldest at the left, 0 on the bottom edge. */
export function pulsePoints(values: readonly number[], width: number, height: number) {
  const max = Math.max(0, ...values)
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values.map((v, i) => ({
    x: values.length > 1 ? i * step : width / 2,
    y: height - (max === 0 ? 0 : (v / max) * height),
  }))
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * A smooth line through the points (monotone cubic, Fritsch–Carlson): it never swings above a
 * peak or below the baseline between two days, so the curve never shows a count that wasn't.
 */
export function smoothLine(points: readonly PulsePoint[]): string {
  const first = points[0]
  if (!first) return ''
  if (points.length === 1) return `M${round(first.x)},${round(first.y)}`
  const n = points.length
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as PulsePoint
    const b = points[i + 1] as PulsePoint
    dx.push(b.x - a.x)
    slope.push((b.y - a.y) / (b.x - a.x || 1))
  }
  const tangent: number[] = [slope[0] ?? 0]
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1] ?? 0
    const s1 = slope[i] ?? 0
    const h0 = dx[i - 1] ?? 0
    const h1 = dx[i] ?? 0
    // Flat at a peak, a trough or a level stretch; else the weighted harmonic mean of the slopes.
    tangent.push(s0 * s1 <= 0 ? 0 : (3 * (h0 + h1)) / ((2 * h1 + h0) / s0 + (h1 + 2 * h0) / s1))
  }
  tangent.push(slope[n - 2] ?? 0)
  let d = `M${round(first.x)},${round(first.y)}`
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as PulsePoint
    const b = points[i + 1] as PulsePoint
    const h = (dx[i] ?? 0) / 3
    d += `C${round(a.x + h)},${round(a.y + h * (tangent[i] ?? 0))} ${round(b.x - h)},${round(b.y - h * (tangent[i + 1] ?? 0))} ${round(b.x)},${round(b.y)}`
  }
  return d
}

/** The same line closed down to the bottom edge, for the area under it. */
export function smoothArea(points: readonly PulsePoint[], height: number): string {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return ''
  return `${smoothLine(points)}L${round(last.x)},${height}L${round(first.x)},${height}Z`
}

/** A day in words: `Sun 22 Nov`. */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
}

/** A month in words: `November 2026`, or `Nov` short. */
export function monthLabel(month: string, short = false): string {
  const date = new Date(`${month}-01T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? month
    : date.toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        month: short ? 'short' : 'long',
        ...(short ? {} : { year: 'numeric' }),
      })
}

/** What one day of the pulse says: `Sun 22 Nov: 312 views, 2 pushes`. */
export function dayReadout(d: InstanceUsage['days'][number], viewCounts: boolean): string {
  const counts = viewCounts
    ? `${countLabel(d.views, 'views')}, ${countLabel(d.pushes, 'pushes')}`
    : countLabel(d.pushes, 'pushes')
  return `${dayLabel(d.day)}: ${counts}`
}

/** The pulse in words, for screen readers: its range, its total and its busiest day. */
export function pulseSummary(
  u: Pick<InstanceUsage, 'days' | 'viewCounts'>,
  across = 'every site'
): string {
  const key = pulseCount(u)
  const first = u.days[0]
  const last = u.days.at(-1)
  if (!first || !last) return ''
  const total = u.days.reduce((n, d) => n + d[key], 0)
  const pushes = u.days.reduce((n, d) => n + d.pushes, 0)
  const range = `${key === 'views' ? 'Views' : 'Pushes'} per day across ${across}, ${dayLabel(first.day)} to ${dayLabel(last.day)}: ${countLabel(total, key)}`
  const peak = peakIndex(u.days, key)
  const busiest = peak === null ? undefined : u.days[peak]
  const most = busiest
    ? `, the most on ${dayLabel(busiest.day)} (${countLabel(busiest[key], key)})`
    : ''
  const sparks = key === 'views' ? `, and ${countLabel(pushes, 'pushes')}` : ''
  return `${range}${most}${sparks}.`
}

/** How warm a heatmap cell is: 0 for nothing, else 1–4 in quarters of the busiest day. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4
}

export interface HeatCell {
  day: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

/**
 * The days as a calendar, a column a week (Monday at the top): null where a week's column has a
 * day outside the range, before the first day and after the last.
 */
export function heatmapWeeks(days: InstanceUsage['days'], key: Count): (HeatCell | null)[][] {
  const max = Math.max(0, ...days.map(d => d[key]))
  const cells: (HeatCell | null)[] = []
  const first = days[0]
  if (!first) return []
  const lead = (new Date(`${first.day}T00:00:00Z`).getUTCDay() + 6) % 7
  for (let i = 0; i < lead; i++) cells.push(null)
  for (const d of days) cells.push({ day: d.day, count: d[key], level: heatLevel(d[key], max) })
  while (cells.length % 7) cells.push(null)
  const weeks: (HeatCell | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** The months as bars, each against the busiest month (0–1). */
export function monthBars(months: InstanceUsage['months'], key: Count) {
  const max = Math.max(0, ...months.map(m => m[key]))
  return months.map(m => ({ month: m.month, count: m[key], ratio: share(m[key], max) }))
}

export interface FunnelRing {
  key: keyof UsageTally['viewed']
  label: string
  count: number
  /** of the live sites */
  share: number
}

/**
 * The live sites and how many were viewed lately, widest window first (the outer ring), with the
 * never-viewed apart.
 */
export function funnel(lap: Pick<UsageTally, 'live' | 'viewed' | 'neverViewed'>) {
  const ring = (key: FunnelRing['key'], label: string): FunnelRing => ({
    key,
    label,
    count: lap.viewed[key],
    share: share(lap.viewed[key], lap.live),
  })
  return {
    live: lap.live,
    rings: [
      ring('days90', 'Viewed in 90 days'),
      ring('days28', 'Viewed in 28 days'),
      ring('days7', 'Viewed in 7 days'),
    ],
    neverViewed: { count: lap.neverViewed, share: share(lap.neverViewed, lap.live) },
  }
}

const sites = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'site' : 'sites'}`

/** The rings in words, for screen readers. */
export function funnelSummary(f: ReturnType<typeof funnel>): string {
  if (f.live === 0) return 'No live sites yet.'
  const rings = f.rings.map(r => `${sites(r.count)} (${percent(r.share)}) ${r.label.toLowerCase()}`)
  return `Of ${sites(f.live)} live: ${rings.join(', ')}; ${sites(f.neverViewed.count)} never viewed.`
}

/** The most viewed, each with its bar against the first, and whether it is on the podium. */
export function leaderboard(top: UsageTally['top']) {
  const max = top[0]?.views ?? 0
  return top.map((s, i) => ({ ...s, rank: i + 1, ratio: share(s.views, max), podium: i < 3 }))
}

const DAY_MS = 86_400_000

/** How long a site has gone unused, in words without "ago": `3 days`, `4 months`, `2 years`. */
export function idleFor(days: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (days < 1) return 'under a day'
  if (days < 14) return plural(Math.floor(days), 'day')
  if (days < 60) return plural(Math.floor(days / 7), 'week')
  if (days < 730) return plural(Math.floor(days / 30.44), 'month')
  return plural(Math.floor(days / 365.25), 'year')
}

/** A year unused is as dusty as a site gets. */
const DUSTIEST_DAYS = 365

/** Unused for less than this, a site isn't gathering dust, however few sites there are. */
export const DUST_AFTER_DAYS = 7

/**
 * The longest unused, unused for DUST_AFTER_DAYS or more, each with how long and how dusty (0–1,
 * growing fast at first and slowly after, a year or more is 1).
 */
export function gatheringDust(idle: UsageTally['idle'], now: number = Date.now()) {
  return idle
    .map(s => {
      const at = Date.parse(s.lastActiveAt)
      const days = Number.isNaN(at) ? 0 : Math.max(0, (now - at) / DAY_MS)
      const dust = Math.min(1, Math.log1p(days) / Math.log1p(DUSTIEST_DAYS))
      return { ...s, days, idleFor: idleFor(days), dust: Math.round(dust * 100) / 100 }
    })
    .filter(s => s.days >= DUST_AFTER_DAYS)
}

/** What the page says instead of the site tallies, or above them; null: nothing to say. */
export function lapNotice(u: Pick<InstanceUsage, 'sweep' | 'lap'>): {
  tone: 'empty' | 'info'
  text: string
} | null {
  if (!u.sweep) {
    return u.lap
      ? {
          tone: 'info',
          text: 'Maintenance’s sweep is off, so these site tallies are from its last lap and aren’t being refreshed.',
        }
      : {
          tone: 'empty',
          text: 'The site tallies come from maintenance’s sweep of every site, which is off on this Fling.',
        }
  }
  if (!u.lap) {
    return {
      tone: 'empty',
      text: 'Maintenance hasn’t been round every site yet. The site tallies appear once its first lap ends.',
    }
  }
  if (u.lap.partial) {
    return {
      tone: 'info',
      text: 'This lap began before maintenance started tallying, so some sites are missing from these numbers. The next lap counts them all.',
    }
  }
  return null
}

/** Whether nothing has happened yet: no views, no pushes, in 12 months. */
export const isQuiet = (u: Pick<InstanceUsage, 'totals'>) =>
  u.totals.months.views === 0 && u.totals.months.pushes === 0

/**
 * What the View counting section says of maintenance's rollout of the switch to every site: under
 * way, with how many done, or finished (null: nothing to say, as on an instance that never set it).
 */
export function rolloutText(c: ViewCounting): string | null {
  const r = c.rollout
  if (!r) return null
  const sites = `${r.sites.toLocaleString()} ${r.sites === 1 ? 'site' : 'sites'}`
  if (r.finishedAt) {
    return c.on
      ? `Every live site counts views (maintenance went through ${sites}).`
      : `No site counts views (maintenance went through ${sites}).`
  }
  return c.on
    ? `Maintenance is adding view counting to every live site, without publishing them again: ${sites} done so far.`
    : `Maintenance is taking view counting off every live site: ${sites} done so far.`
}
