/**
 * A site's metrics (@fling/shared/metrics): its views and pushes per UTC day, ISO week and month,
 * and when it was last viewed and pushed. Counts only: nothing is stored about who viewed.
 *
 * - **Pushes** are counted where a version goes live (publish, the repointed shortcut, rollback,
 *   and the same for a Path, counted to its site), after it is live, so a failed publish counts
 *   nothing (`countPush`). Always on.
 * - **Views** come from the view beacon (@fling/shared/view-beacon), with SITE_VIEW_COUNTS on: the
 *   routing decision lets a page's beacon through to SITE_SEEN_PATH, and the platform hands the
 *   site to a `ViewCounter`, which keeps the counts in memory and writes them in batches, so a
 *   busy site costs a few writes a flush, not a few per view. When the platform flushes is its
 *   own: after each request at most every FLUSH_INTERVAL_MS (AWS's Lambda, the Worker), or on a
 *   timer (the Node host). Counts not yet written when a runtime is frozen or stopped are lost:
 *   at most an interval's worth.
 *
 * **View counting** is an admin's switch (Admin → Usage, `setViewCounting`), within what the
 * instance allows (SITE_VIEW_COUNTS): on, every live version's pages are served from their counted
 * copies and views are counted; off, the pages are served as published and nothing is counted,
 * while the counts so far stay. It is read on every route write and every flush, never cached.
 * Maintenance rolls a change out to every site already live, a batch a run, without a new
 * version (`rolloutViewCounting`); its first run does the same for the sites live before view
 * counting existed, so they count views without being published again.
 *
 * Each count goes to all three of its buckets with an atomic add (Store.addSiteCounts), and each
 * bucket expires on its own (BUCKET_KEEP_MS), so there is no roll-up job: a read takes days,
 * weeks and months each from buckets of its own size. A view or push never touches the site
 * record (the buckets and the activity item are items of their own in the site's partition), so
 * it never bumps the site's revision, and deleting a site deletes its metrics.
 */
import {
  dayOf,
  type InstanceUsage,
  METRIC_DAYS,
  METRIC_MONTHS,
  METRIC_WEEKS,
  MY_METRICS_SITES,
  metricRanges,
  type SiteDays,
  type SiteMetrics,
  type SitesMetrics,
  USAGE_LIST_LENGTH,
  type UsageTally,
  type ViewCounting,
  weekStartOf,
} from '@fling/shared/metrics'
import { ensure } from './admin.ts'
import { audit } from './audit.ts'
import { manifestKey } from './blobs/types.ts'
import { mapLimit } from './lib/concurrency.ts'
import { badRequest } from './lib/errors.ts'
import { pathRef, refreshHome, syncPathRoute } from './paths.ts'
import { type Actor, can, type Principal } from './policy.ts'
import { renderVersion } from './rendering.ts'
import { listSites, requireSite, type StoredManifest, syncRouteTable } from './sites.ts'
import type {
  SiteCounts,
  SiteMetricRecord,
  SiteRecord,
  SiteRef,
  Store,
  User,
  VersionRecord,
  ViewCountingRecord,
} from './store/types.ts'
import type { Clock, Deps } from './types.ts'

const DAY_MS = 86_400_000
/** How often a ViewCounter writes, at most, when flushed after requests. */
export const FLUSH_INTERVAL_MS = 10_000
const FLUSH_CONCURRENCY = 8

/** How long past its start each size of bucket is kept: one more than a read goes back. */
const BUCKET_KEEP_MS = {
  D: (METRIC_DAYS + 1) * DAY_MS,
  W: (METRIC_WEEKS + 1) * 7 * DAY_MS,
  M: (METRIC_MONTHS + 1) * 31 * DAY_MS,
}

/** When each of the buckets `at` falls in expires. */
export function bucketExpiry(at: Date): Record<SiteMetricRecord['size'], string> {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  const month = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
  return {
    D: new Date(day + BUCKET_KEEP_MS.D).toISOString(),
    W: new Date(weekStartOf(at).getTime() + BUCKET_KEEP_MS.W).toISOString(),
    M: new Date(month + BUCKET_KEEP_MS.M).toISOString(),
  }
}

/** Whether views are counted now: the instance allows it and view counting is on. */
export async function viewCountingOn(deps: Pick<Deps, 'config' | 'store'>): Promise<boolean> {
  if (!deps.config.viewCounts) return false
  return (await deps.store.getViewCounting())?.on ?? true
}

/**
 * Whether the edge serves a version's copies with the view beacon (route value `c`): it has them,
 * and views are counted now.
 */
export async function countsViews(deps: Deps, version: Pick<VersionRecord, 'counted'> | null) {
  return version?.counted === true && (await viewCountingOn(deps))
}

/** Store `counts` for a site, now. */
function addCounts(store: Store, clock: Clock, siteId: string, counts: Partial<SiteCounts>) {
  const at = clock.now()
  return store.addSiteCounts(siteId, at, counts, bucketExpiry(at))
}

/** Store `counts` among every site's together, now. */
function addInstance(store: Store, clock: Clock, counts: Partial<SiteCounts>) {
  const at = clock.now()
  return store.addInstanceCounts(at, counts, bucketExpiry(at))
}

const warn = (msg: string, fields: Record<string, unknown>) =>
  console.warn(JSON.stringify({ level: 'warn', msg, ...fields }))

/**
 * Count a push to the site (`siteId`: the site's, also for a Path's version). A version that has
 * gone live is live whatever happens here, so a failure is logged, never thrown.
 */
export async function countPush(deps: Deps, siteId: string) {
  try {
    await addCounts(deps.store, deps.clock, siteId, { pushes: 1 })
    await addInstance(deps.store, deps.clock, { pushes: 1 })
  } catch (err) {
    warn('push not counted', { siteId, error: String(err) })
  }
}

/**
 * Views counted in memory, written in batches: one add per bucket per site a flush, however many
 * views it holds. One per runtime instance (a warm Lambda, a Worker isolate, a Node process);
 * several write safely side by side, since every write is an atomic add.
 */
export class ViewCounter {
  private pending = new Map<string, number>()
  private lastFlush: number
  private flushing: Promise<void> | null = null

  constructor(
    private store: Store,
    private clock: Clock,
    private intervalMs = FLUSH_INTERVAL_MS,
    /** whether views are counted now (`viewCountingOn`): off, a flush drops what it holds */
    private counting: () => Promise<boolean> = async () => true
  ) {
    // A new runtime writes its first views at once; from then on at most once an interval.
    this.lastFlush = Number.NEGATIVE_INFINITY
  }

  /** A view of the site, to be written by a later flush. */
  count(siteId: string, n = 1) {
    this.pending.set(siteId, (this.pending.get(siteId) ?? 0) + n)
  }

  /** Views counted and not written yet, by site. */
  get waiting(): ReadonlyMap<string, number> {
    return this.pending
  }

  /** Flush when there is something to write and the interval has passed since the last flush. */
  flushDue(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve()
    if (this.clock.now().getTime() - this.lastFlush < this.intervalMs) return Promise.resolve()
    return this.flush()
  }

  /**
   * Write every count held now. Counts that fail to write are held for the next flush; one flush
   * runs at a time (a second call waits for it, then writes what came in meanwhile).
   */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing
    if (this.pending.size === 0) return
    const batch = this.pending
    this.pending = new Map()
    this.lastFlush = this.clock.now().getTime()
    this.flushing = (async () => {
      // Pages served before view counting went off may still report a view: they aren't counted.
      if (!(await this.counting().catch(() => true))) return
      let written = 0
      await mapLimit([...batch], FLUSH_CONCURRENCY, async ([siteId, views]) => {
        try {
          await addCounts(this.store, this.clock, siteId, { views })
          written += views
        } catch (err) {
          this.count(siteId, views)
          warn('views not written', { siteId, views, error: String(err) })
        }
      })
      // Every site's together: one add a flush, whatever the number of sites.
      try {
        await addInstance(this.store, this.clock, { views: written })
      } catch (err) {
        warn("instance's views not written", { views: written, error: String(err) })
      }
    })()
    try {
      await this.flushing
    } finally {
      this.flushing = null
    }
  }
}

/** A site's metrics, for its owners, publishers and admins (`site.metrics.read`). */
export async function siteMetrics(deps: Deps, user: User, name: string): Promise<SiteMetrics> {
  const site = await requireSite(deps, user, name, 'site.metrics.read')
  const { buckets, activity } = await deps.store.getSiteMetrics(site.id)
  return {
    name: site.name,
    viewCounts: deps.config.viewCounts,
    counting: await viewCountingOn(deps),
    since: activity?.since ?? null,
    lastViewAt: activity?.lastViewAt ?? null,
    lastPushAt: activity?.lastPushAt ?? null,
    ...series(buckets, deps.clock.now()),
  }
}

const sum = (list: SiteCounts[]): SiteCounts =>
  list.reduce((t, c) => ({ views: t.views + c.views, pushes: t.pushes + c.pushes }), {
    views: 0,
    pushes: 0,
  })

/** The days, weeks and months a read at `now` returns from `buckets`, every one there, and totals. */
function series(buckets: readonly SiteMetricRecord[], now: Date) {
  const found = new Map(buckets.map(b => [`${b.size}#${b.bucket}`, b]))
  const counts = (size: SiteMetricRecord['size'], bucket: string): SiteCounts => {
    const b = found.get(`${size}#${bucket}`)
    return { views: b?.views ?? 0, pushes: b?.pushes ?? 0 }
  }
  const ranges = metricRanges(now)
  const days = ranges.days.map(day => ({ day, ...counts('D', day) }))
  const weeks = ranges.weeks.map(w => ({ ...w, ...counts('W', w.week) }))
  const months = ranges.months.map(month => ({ month, ...counts('M', month) }))
  return { days, weeks, months, totals: { days: sum(days), months: sum(months) } }
}

/**
 * The Sites list's metrics (`GET /api/sites?metrics=1`, sites.ts `listSites`): of `live`, the
 * caller's live sites, the MY_METRICS_SITES updated last that they may read the metrics of
 * (`site.metrics.read`: they own or publish them), each one's days and them all added up. One
 * batch read (`Store.getSitesMetrics`), whatever the number of sites. Also `fling stats` and
 * `fling_stats` without a name.
 */
export async function listedMetrics(
  deps: Deps,
  actor: Actor,
  live: readonly SiteRecord[]
): Promise<{ metrics: SitesMetrics; days: Map<string, SiteDays> }> {
  const readable = live
    .filter(s => can(actor, 'site.metrics.read', s))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const read = readable.slice(0, MY_METRICS_SITES)
  const now = deps.clock.now()
  const each = await deps.store.getSitesMetrics(
    read.map(s => s.id),
    now
  )
  const added = new Map<string, SiteMetricRecord>()
  const days = new Map<string, SiteDays>()
  let since: string | null = null
  let lastViewAt: string | null = null
  let lastPushAt: string | null = null
  const earliest = (a: string | null, b?: string) => (b && (!a || b < a) ? b : a)
  const latest = (a: string | null, b?: string) => (b && (!a || b > a) ? b : a)
  each.forEach(({ buckets, activity }, i) => {
    const site = read[i]
    if (site) {
      const own = series(buckets, now).days
      days.set(site.id, { views: own.map(d => d.views), pushes: own.map(d => d.pushes) })
    }
    for (const b of buckets) {
      const k = `${b.size}#${b.bucket}`
      const t = added.get(k)
      added.set(k, t ? { ...t, views: t.views + b.views, pushes: t.pushes + b.pushes } : { ...b })
    }
    since = earliest(since, activity?.since)
    lastViewAt = latest(lastViewAt, activity?.lastViewAt)
    lastPushAt = latest(lastPushAt, activity?.lastPushAt)
  })
  return {
    metrics: {
      viewCounts: deps.config.viewCounts,
      counting: await viewCountingOn(deps),
      sites: read.length,
      of: readable.length,
      since,
      lastViewAt,
      lastPushAt,
      ...series([...added.values()], now),
    },
    days,
  }
}

/** The caller's live sites added up (`fling_stats` without a name): the Sites list's metrics. */
export async function yourSitesMetrics(deps: Deps, user: User): Promise<SitesMetrics> {
  const { metrics } = await listSites(deps, user, false, {}, { metrics: true })
  if (!metrics) throw badRequest('This Fling has no site metrics', 'no_metrics')
  return metrics
}

/** Admin → Usage: every site's views and pushes together, and the sweep's last lap's tally. */
export async function instanceUsage(deps: Deps, p: Principal): Promise<InstanceUsage> {
  ensure(p, 'admin.usage.read')
  const [buckets, cursor, deleted] = await Promise.all([
    deps.store.getInstanceMetrics(),
    deps.store.getMaintenanceCursor(),
    deps.store.deletedTotals(),
  ])
  return {
    viewCounts: deps.config.viewCounts,
    ...(deps.config.viewCounts
      ? { counting: viewCounting(await deps.store.getViewCounting()) }
      : {}),
    sweep: deps.config.maintenanceSweep,
    ...series(buckets, deps.clock.now()),
    lap: cursor?.lastUsage ?? null,
    // The deleted sites still kept (deletion.ts), from the deleted-site records' totals.
    deleted,
  }
}

/** A tally with nothing in it; `partial` when the lap it starts in began before it. */
export function emptyTally(partial = false): UsageTally {
  return {
    sites: 0,
    live: 0,
    viewed: { days7: 0, days28: 0, days90: 0 },
    neverViewed: 0,
    top: [],
    idle: [],
    ...(partial ? { partial: true } : {}),
  }
}

/** The first USAGE_LIST_LENGTH of `list` with `item`, in the order `before` gives. */
function keepFirst<T>(list: T[], item: T, before: (a: T, b: T) => number) {
  return [...list, item].sort(before).slice(0, USAGE_LIST_LENGTH)
}

/**
 * Maintenance's sweep, at each site of the directory: add it to the lap's tally. A live site costs
 * its buckets and activity (one query, one read); any other nothing.
 */
export async function tallySite(deps: Deps, tally: UsageTally, site: SiteRecord) {
  tally.sites++
  if (site.archived || !site.currentVersionId) return
  tally.live++
  const now = deps.clock.now().getTime()
  const { buckets, activity } = await deps.store.getSiteMetrics(site.id)
  const viewedAt = activity?.lastViewAt ? Date.parse(activity.lastViewAt) : null
  if (viewedAt === null) tally.neverViewed++
  else {
    const ago = now - viewedAt
    if (ago <= 7 * DAY_MS) tally.viewed.days7++
    if (ago <= 28 * DAY_MS) tally.viewed.days28++
    if (ago <= 90 * DAY_MS) tally.viewed.days90++
  }
  const from = dayOf(new Date(now - (METRIC_DAYS - 1) * DAY_MS))
  const views = buckets
    .filter(b => b.size === 'D' && b.bucket >= from)
    .reduce((t, b) => t + b.views, 0)
  if (views > 0) {
    tally.top = keepFirst(tally.top, { name: site.name, views }, (a, b) => b.views - a.views)
  }
  const lastActiveAt =
    [activity?.lastViewAt, activity?.lastPushAt]
      .filter((t): t is string => !!t)
      .sort()
      .at(-1) ?? site.updatedAt
  tally.idle = keepFirst(tally.idle, { name: site.name, lastActiveAt }, (a, b) =>
    a.lastActiveAt < b.lastActiveAt ? -1 : a.lastActiveAt > b.lastActiveAt ? 1 : 0
  )
}

/** What Admin → Usage shows of view counting, from its record (none: on, not rolled out yet). */
function viewCounting(record: ViewCountingRecord | null): ViewCounting {
  if (!record) return { on: true, rollout: { sites: 0 } }
  return {
    on: record.on,
    ...(record.setBy ? { setBy: record.setBy } : {}),
    setAt: record.setAt,
    rollout: {
      sites: record.rollout.sites,
      ...(record.rollout.finishedAt ? { finishedAt: record.rollout.finishedAt } : {}),
    },
  }
}

/**
 * Turn view counting on or off (Admin → Usage), and start maintenance's rollout of it to every
 * live site. Setting what is already set starts the rollout again.
 */
export async function setViewCounting(deps: Deps, p: Principal, on: boolean) {
  ensure(p, 'admin.usage.write')
  if (!deps.config.viewCounts) {
    throw badRequest('This Fling doesn’t count views (SITE_VIEW_COUNTS is off)', 'view_counts_off')
  }
  await deps.store.putViewCounting({
    on,
    setBy: p.email,
    setAt: deps.clock.now().toISOString(),
    rollout: { after: null, sites: 0 },
  })
  await audit(deps, { action: 'usage.view_counting', actor: p.email, target: on ? 'on' : 'off' })
  return instanceUsage(deps, p)
}

/** Directory entries read a query of the rollout. */
const ROLLOUT_PAGE = 50

/**
 * Bring a live version's pages in line with view counting, without a new version. On: one never
 * counted gets its counted copies (and is marked counted, or as one that can't be); one with
 * Markdown has its pages rendered again with the beacon. Off: one with Markdown has its pages
 * rendered again without it. The copies stay, so turning counting back on needs no copying.
 */
async function applyToVersion(
  deps: Deps,
  ref: SiteRef,
  storageId: string,
  versionId: string,
  on: boolean
) {
  const version = await deps.store.getVersion(ref, versionId)
  if (version?.status !== 'complete') return
  const untried = version.counted === undefined
  if (!(version.markdown || (on && untried))) return
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(storageId, versionId))
  if (!manifest) return
  const rendered = await renderVersion(deps, storageId, versionId, manifest.files, {
    counting: on,
  })
  if (on && untried) await deps.store.putVersion(ref, { ...version, counted: !!rendered.counted })
}

/** Apply view counting as it is now to a site, its Paths and their routes. */
async function applyToSite(deps: Deps, site: SiteRecord, on: boolean) {
  // Archived ones too, so unarchiving one serves it as view counting is then.
  if (site.currentVersionId) {
    await applyToVersion(deps, site, site.id, site.currentVersionId, on)
  }
  const paths = await deps.store.listPaths(site.id)
  for (const path of paths) {
    if (path.currentVersionId) {
      await applyToVersion(deps, pathRef(site, path), path.id, path.currentVersionId, on)
    }
  }
  await syncRouteTable(deps, site)
  for (const path of paths) await syncPathRoute(deps, site, path)
  if (site.paths) await refreshHome(deps, site)
}

/**
 * Maintenance's part: apply view counting to the next sites in the directory, until the deadline
 * or the end; returns how many it did. With none set, it starts with it on, for the sites live
 * before view counting existed. Each page's progress is kept only while the setting is the one it
 * began under, so a newer one starts its own rollout.
 */
export async function rolloutViewCounting(deps: Deps, deadline: number | undefined) {
  if (!deps.config.viewCounts) return 0
  let record = await deps.store.getViewCounting()
  if (!record) {
    const first: ViewCountingRecord = {
      on: true,
      setAt: deps.clock.now().toISOString(),
      rollout: { after: null, sites: 0 },
    }
    if (!(await deps.store.putViewCounting(first, null))) return 0
    record = first
  }
  if (record.rollout.finishedAt) return 0
  let done = 0
  for (;;) {
    const page = await deps.store.pageSites({ after: record.rollout.after, limit: ROLLOUT_PAGE })
    let after = record.rollout.after
    let sites = record.rollout.sites
    let stopped = false
    for (const entry of page.sites) {
      if (deadline !== undefined && Date.now() > deadline) {
        stopped = true
        break
      }
      const site = await deps.store.findSite(entry.name)
      if (site) {
        try {
          await applyToSite(deps, site, record.on)
        } catch (err) {
          warn('view counting not applied', { site: site.name, error: String(err) })
        }
        sites++
        done++
      }
      after = entry.name
    }
    const finished = !stopped && !page.more
    const next: ViewCountingRecord = {
      ...record,
      rollout: {
        after,
        sites,
        ...(finished ? { finishedAt: deps.clock.now().toISOString() } : {}),
      },
    }
    if (!(await deps.store.putViewCounting(next, record.setAt))) return done
    if (finished) {
      console.log(JSON.stringify({ level: 'info', msg: 'view counting rolled out', ...next }))
    }
    if (finished || stopped) return done
    record = next
  }
}
