/**
 * A site's metrics: counts only, never who. Views (a page load the view beacon reported,
 * view-beacon.ts) and pushes (a version going live) per UTC day, ISO week and calendar month,
 * plus when the site was last viewed and last pushed. The API stores each count in all three
 * buckets at once (apps/api/src/views.ts); each bucket expires on its own, so a read takes each
 * range from the buckets of its own size, and nothing rolls them up.
 *
 * `GET /api/sites/:name/metrics` answers SiteMetricsSchema: the last METRIC_DAYS days, METRIC_WEEKS
 * weeks and METRIC_MONTHS months, oldest first, the current one last and possibly partial, every
 * bucket present (zero when nothing happened).
 */
import { z } from 'zod'

/** Days, weeks and months a site's metrics go back (the current one included). */
export const METRIC_DAYS = 28
export const METRIC_WEEKS = 8
export const METRIC_MONTHS = 12

const Counts = { views: z.number().int().nonnegative(), pushes: z.number().int().nonnegative() }

export const SiteMetricsSchema = z.object({
  name: z.string(),
  /**
   * Whether this instance counts views (the `viewCounts` capability): without it, `views` are
   * always 0 and only pushes are counted.
   */
  viewCounts: z.boolean(),
  /** when the site's first count was stored (its metrics go back no further); null: none yet */
  since: z.string().nullable(),
  lastViewAt: z.string().nullable(),
  lastPushAt: z.string().nullable(),
  /** `YYYY-MM-DD` (UTC) */
  days: z.array(z.object({ day: z.string(), ...Counts })),
  /** `YYYY-Www` (ISO 8601 week), with the UTC day its Monday falls on */
  weeks: z.array(z.object({ week: z.string(), start: z.string(), ...Counts })),
  /** `YYYY-MM` */
  months: z.array(z.object({ month: z.string(), ...Counts })),
  totals: z.object({
    /** over `days` */
    days: z.object(Counts),
    /** over `months` */
    months: z.object(Counts),
  }),
})
export type SiteMetrics = z.infer<typeof SiteMetricsSchema>

const DAY_MS = 86_400_000

/** The UTC day of `at`: `YYYY-MM-DD`. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10)

/** The UTC month of `at`: `YYYY-MM`. */
export const monthOf = (at: Date): string => at.toISOString().slice(0, 7)

/** The Monday (UTC midnight) of the ISO week `at` is in. */
export function weekStartOf(at: Date): Date {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const weekday = (new Date(day).getUTCDay() + 6) % 7 // Monday 0 … Sunday 6
  return new Date(day - weekday * DAY_MS)
}

/** The ISO 8601 week of `at`: `YYYY-Www`, its year the one its Thursday falls in. */
export function weekOf(at: Date): string {
  const thursday = new Date(weekStartOf(at).getTime() + 3 * DAY_MS)
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** The buckets of the metrics a read at `now` returns, oldest first. */
export function metricRanges(now: Date) {
  const days: string[] = []
  for (let i = METRIC_DAYS - 1; i >= 0; i--) days.push(dayOf(new Date(now.getTime() - i * DAY_MS)))
  const weeks: { week: string; start: string }[] = []
  const monday = weekStartOf(now).getTime()
  for (let i = METRIC_WEEKS - 1; i >= 0; i--) {
    const start = new Date(monday - i * 7 * DAY_MS)
    weeks.push({ week: weekOf(start), start: dayOf(start) })
  }
  const months: string[] = []
  for (let i = METRIC_MONTHS - 1; i >= 0; i--) {
    months.push(monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))))
  }
  return { days, weeks, months }
}

/** How many sites Admin → Usage lists as the most viewed and as the longest unused. */
export const USAGE_LIST_LENGTH = 20

/**
 * What maintenance's sweep tallies of the sites' use as it goes round the site directory once
 * (a lap; apps/api/src/maintenance.ts), from each site's activity and day buckets. Kept on the
 * sweep's cursor while the lap is under way, and as the last lap's once it ends.
 */
export const UsageTallySchema = z.object({
  /** sites in the directory */
  sites: z.number().int().nonnegative(),
  /** of them, published and not archived */
  live: z.number().int().nonnegative(),
  /** live sites viewed within the last 7, 28 and 90 days of when the sweep reached them */
  viewed: z.object({
    days7: z.number().int().nonnegative(),
    days28: z.number().int().nonnegative(),
    days90: z.number().int().nonnegative(),
  }),
  /** live sites with no view counted, ever */
  neverViewed: z.number().int().nonnegative(),
  /** the live sites viewed most over their last METRIC_DAYS days, most first */
  top: z.array(z.object({ name: z.string(), views: z.number().int().nonnegative() })),
  /**
   * the live sites used least lately, longest first: the latest of their last view and last push,
   * else when the site last changed
   */
  idle: z.array(z.object({ name: z.string(), lastActiveAt: z.string() })),
  /** the lap began before tallying did, so the sites before where it started are missing */
  partial: z.boolean().optional(),
})
export type UsageTally = z.infer<typeof UsageTallySchema>

/** `GET /api/admin/usage`: every site's views and pushes together, and the last lap's tally. */
export const InstanceUsageSchema = z.object({
  viewCounts: z.boolean(),
  /** whether maintenance sweeps the site directory (MAINTENANCE_SWEEP_ENABLED): without it, no lap */
  sweep: z.boolean(),
  days: z.array(z.object({ day: z.string(), ...Counts })),
  weeks: z.array(z.object({ week: z.string(), start: z.string(), ...Counts })),
  months: z.array(z.object({ month: z.string(), ...Counts })),
  totals: z.object({ days: z.object(Counts), months: z.object(Counts) }),
  /** the last lap's tally, with when it began and ended; null before the first lap ends */
  lap: UsageTallySchema.extend({ lapStartedAt: z.string(), finishedAt: z.string() }).nullable(),
})
export type InstanceUsage = z.infer<typeof InstanceUsageSchema>
