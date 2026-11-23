/**
 * Maintenance, run on a schedule (every MAINTAIN_EVERY_MS on every platform, each run up to
 * MAINTAIN_BUDGET_MS). It deletes what nothing serves any more, a site at a time, from two
 * sources, so its cost follows the work there is rather than the number of sites:
 *
 * - **The queue** (`MAINTAIN/DUE#<dueAt>#<siteId>`, store/records.ts), first. Whatever makes work
 *   for a site queues it for when that work is due (`queueMaintenance`): going live (retention),
 *   staging a deploy (its pending TTL), a replaced home page. Maintaining a site queues it again
 *   for its next due time (a mark's grace, a staging URL's expiry), so one event carries a site
 *   through to the end of its work.
 * - **The sweep** of the site directory (unless MAINTENANCE_SWEEP_ENABLED is off, config.ts),
 *   with what time is left, at least SWEEP_SHARE of the budget. It goes on from where the last run stopped (`MAINTAIN/CURSOR`) and starts again at
 *   the top once it has reached the end (a lap), so every site is maintained at least once a lap:
 *   what nothing queued (sites from before the queue, a change to VERSION_RETENTION, a queue
 *   write that failed) is found there. A lap's length is logged, and the last one is kept on the
 *   cursor for Admin → Routes (route-format.ts `routeTableStatus`). The sweep also tallies the
 *   sites' use as it goes (views.ts `tallySite`: how many were viewed lately, the most viewed and
 *   the longest unused), kept on the cursor and, at the end of a lap, as the last lap's for
 *   Admin → Usage. Runs that overlap may both tally a page; the tally is a guide, not a ledger.
 * - **Rollouts** that reach every site, a page of the directory at a time, before the sweep: the
 *   route format an admin chose (route-format.ts `rewriteRoutes`) and view counting turned on or
 *   off (views.ts `rolloutViewCounting`).
 *
 * Every run is safe to repeat and to overlap another: claims are conditional writes, and work
 * found done costs only its reads.
 *
 * Retention (`VERSION_RETENTION`, config.ts; 0 keeps everything): each site and each of its Paths
 * (paths.ts) keeps its current version and its newest N complete versions. Every version owns its
 * files (`<storage>/<versionId>/`), so deleting one touches nothing else. Mark, then sweep:
 *   1. **Mark**: a complete version past the newest N becomes `pruning` (`prunedAt`). So does a
 *      pending one older than PENDING_TTL_MS (a deploy staged and never finalized).
 *   2. **Sweep**, at least GRACE_MS after the mark: claimed as `sweeping` (moveVersion, so only one
 *      run does it), its files, manifest and forms config are deleted, then its records
 *      (deleteVersion: both its keys). A version with a site server is retired from its platform
 *      first (`SiteServers.retire`).
 * The grace covers a route still naming it (Cloudflare's KV trails a change by about a minute), a
 * pull's signed URLs (PULL_URL_TTL_SECONDS) and a finalize in flight. A version that became current
 * meanwhile (a rollback, or a deploy of the same files) is unmarked, never swept. Publication
 * revives a `pruning` version it repoints to, and answers 409 `retry_later` for one `sweeping`.
 *
 * Staged uploads (a store bound by MD5, `Blobs.uploadDigest`): finalize deletes a version's
 * staging copies, but its upload URLs stay good for UPLOAD_URL_TTL_SECONDS, so a PUT after
 * finalize recreates one that nothing serves. Each complete version's staging prefix is deleted
 * once, in the window from that TTL to STAGED_WINDOW_MS after the version was made; a pending
 * one's staged files are its uploads, kept until it is finalized or swept.
 *
 * Rendered home pages (paths.ts `refreshHome`): each one a site replaced (`homeOld`) is deleted
 * GRACE_MS after it was replaced (`sweepHomes`).
 *
 * The revocation list (revocations.ts): due entries are taken off first, so a run that stops at its
 * deadline among the sites has still swept them; one that fails is logged and the rest runs. Every
 * instance has this tick, mail or not.
 */
import { renderedObjectKey, siteVersionPrefix } from '@fling/shared'
import { formsKey, manifestKey, stagedPrefix, UPLOAD_URL_TTL_SECONDS } from './blobs/types.ts'
import { pathRef } from './paths.ts'
import { sweepRevocations } from './revocations.ts'
import { rewriteRoutes } from './route-format.ts'
import { serverSite, serverVersion } from './servers/index.ts'
import type { SiteRecord, SiteRef, VersionRecord } from './store/types.ts'
import { ConditionFailed } from './table/types.ts'
import type { Deps } from './types.ts'
import { emptyTally, rolloutViewCounting, tallySite } from './views.ts'

/** How long a marked version or a replaced home page waits before it is deleted. */
export const GRACE_MS = 60 * 60 * 1000
/** A pending version older than this is a deploy nobody will finalize. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000
/** Replaced home pages older than this are taken to be deleted already (`sweepHomes`). */
const HOME_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
/**
 * After its upload URLs expire, how long a complete version's staging prefix is swept for. The
 * queue brings the site back as they expire; the window lets a run that is late still sweep it,
 * and older versions cost nothing.
 */
const STAGED_WINDOW_MS = 3 * 60 * 60 * 1000
/** How often every platform's scheduler runs maintenance. */
export const MAINTAIN_EVERY_MS = 15 * 60 * 1000
/** How long one run works; the next carries on. Well under the interval, so runs rarely overlap. */
export const MAINTAIN_BUDGET_MS = 4 * 60 * 1000
/** The share of a run's time kept for the sweep when the queue has more than it can do. */
const SWEEP_SHARE = 0.25
/** Queue entries read a query. */
const QUEUE_PAGE = 100
/** Directory entries read a query of the sweep. */
const SWEEP_PAGE = 50

export interface MaintainResult {
  /** sites maintained, from the queue and the sweep */
  sites: number
  /** of them, from the queue */
  queued: number
  marked: number
  swept: number
  unmarked: number
  homes: number
  /** revocations taken off the edge's list */
  revocations: number
  /** sites whose routes were rewritten into the chosen format (route-format.ts) */
  routes: number
  /** sites view counting was rolled out to (views.ts `rolloutViewCounting`) */
  viewCounting: number
  /** stopped at the deadline with work left (queued, or the sweep's lap unfinished) */
  partial: boolean
  /** the sweep reached the end of the directory, a lap that began then (ISO) */
  lapStartedAt?: string
}

export async function maintain(
  deps: Deps,
  opts: { deadline?: number } = {}
): Promise<MaintainResult> {
  const result: MaintainResult = {
    sites: 0,
    queued: 0,
    marked: 0,
    swept: 0,
    unmarked: 0,
    homes: 0,
    revocations: 0,
    routes: 0,
    viewCounting: 0,
    partial: false,
  }
  const started = Date.now()
  // A sweep that fails is logged and left to the next run; the rest of maintenance still runs.
  try {
    result.revocations = await sweepRevocations(deps, opts)
    if (result.revocations) {
      console.log(
        JSON.stringify({ level: 'info', msg: 'revocations swept', count: result.revocations })
      )
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'revocation sweep failed', err: String(err) })
    )
  }
  const done = new Set<string>()
  const sweep = deps.config.maintenanceSweep
  const queueDeadline =
    opts.deadline === undefined || !sweep
      ? opts.deadline
      : opts.deadline - Math.max(0, opts.deadline - started) * SWEEP_SHARE
  if (!(await drainQueue(deps, queueDeadline, done, result))) result.partial = true
  try {
    result.routes = await rewriteRoutes(deps, opts.deadline)
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'route rewrite failed', err: String(err) }))
  }
  try {
    result.viewCounting = await rolloutViewCounting(deps, opts.deadline)
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'view counting rollout failed', err: String(err) })
    )
  }
  if (sweep && !(await sweepDirectory(deps, opts.deadline, done, result))) result.partial = true
  await logRouteTableUsage(deps)
  return result
}

/**
 * Maintain the sites queued by now, oldest first, each once however often it is queued, until
 * none are left or the deadline; true when none are left. Entries queued meanwhile are due
 * later than the run's start, so they wait for the next run.
 */
async function drainQueue(
  deps: Deps,
  deadline: number | undefined,
  done: Set<string>,
  result: MaintainResult
): Promise<boolean> {
  const now = deps.clock.now().toISOString()
  for (;;) {
    const due = await deps.store.dueMaintenance(now, QUEUE_PAGE)
    if (!due.length) return true
    for (const entry of due) {
      if (deadline !== undefined && Date.now() > deadline) return false
      if (!done.has(entry.siteId)) {
        done.add(entry.siteId)
        const site = await deps.store.findSite(entry.name)
        // A site deleted since (or its name taken by another) has nothing left to do.
        if (site?.id === entry.siteId && (await maintainSite(deps, site, result))) result.queued++
      }
      await deps.store.deleteMaintenance(entry)
    }
  }
}

/**
 * The sweep: the site directory from the cursor, a page at a time, until the deadline or the end
 * of the directory (a lap: the cursor starts again at the top); true at the end.
 */
async function sweepDirectory(
  deps: Deps,
  deadline: number | undefined,
  done: Set<string>,
  result: MaintainResult
): Promise<boolean> {
  const now = deps.clock.now().toISOString()
  const cursor = (await deps.store.getMaintenanceCursor()) ?? { after: null, lapStartedAt: now }
  let after = cursor.after
  let finished = false
  // The sites' use, tallied as the lap goes (Admin → Usage); a lap that began before tallying did
  // is partial.
  const tally = cursor.tally ?? emptyTally(cursor.after !== null)
  try {
    for (;;) {
      const page = await deps.store.pageSites({ after, limit: SWEEP_PAGE })
      for (const entry of page.sites) {
        if (deadline !== undefined && Date.now() > deadline) return false
        const site = await deps.store.findSite(entry.name)
        if (site && !done.has(entry.siteId)) {
          done.add(entry.siteId)
          await maintainSite(deps, site, result)
        }
        if (site) {
          try {
            await tallySite(deps, tally, site)
          } catch (err) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                msg: 'usage not tallied',
                site: site.name,
                error: String(err),
              })
            )
          }
        }
        after = entry.name
      }
      if (!page.more) {
        finished = true
        return true
      }
    }
  } finally {
    if (finished) {
      result.lapStartedAt = cursor.lapStartedAt
      const lapMs = Date.parse(now) - Date.parse(cursor.lapStartedAt)
      console.log(JSON.stringify({ level: 'info', msg: 'maintenance lap', lapMs }))
      await deps.store.putMaintenanceCursor({
        after: null,
        lapStartedAt: now,
        lastLap: { lapMs, finishedAt: now },
        lastUsage: { ...tally, lapStartedAt: cursor.lapStartedAt, finishedAt: now },
      })
    } else {
      await deps.store.putMaintenanceCursor({
        after,
        lapStartedAt: cursor.lapStartedAt,
        ...(cursor.lastLap ? { lastLap: cursor.lastLap } : {}),
        ...(cursor.lastUsage ? { lastUsage: cursor.lastUsage } : {}),
        tally,
      })
    }
  }
}

/**
 * One site's maintenance: retention for it and each of its Paths, then its replaced home pages.
 * It queues the site again for the next time something it holds falls due. A site that fails is
 * logged and queued again after GRACE_MS, and the run goes on; returns whether it succeeded.
 */
async function maintainSite(
  deps: Deps,
  site: SiteRecord,
  result: MaintainResult
): Promise<boolean> {
  const now = deps.clock.now().getTime()
  try {
    let next = await maintainTarget(deps, site, site.id, site.currentVersionId, result)
    for (const path of await deps.store.listPaths(site.id)) {
      const ref = pathRef(site, path)
      next = earliest(next, await maintainTarget(deps, ref, path.id, path.currentVersionId, result))
    }
    next = earliest(next, await sweepHomes(deps, site, result))
    result.sites++
    if (next !== undefined) await queueMaintenance(deps, site, next)
    return true
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'site maintenance failed',
        site: site.name,
        err: String(err),
      })
    )
    await queueMaintenance(deps, site, now + GRACE_MS)
    return false
  }
}

/** From how full a route table with a size limit is logged as nearly full (AWS alarms on it). */
const ROUTE_TABLE_WARN = 0.7

async function logRouteTableUsage(deps: Deps) {
  if (!deps.routeTable.usage) return
  try {
    const { bytes, limitBytes } = await deps.routeTable.usage()
    const percent = Math.round((bytes / limitBytes) * 1000) / 10
    const full = bytes >= limitBytes * ROUTE_TABLE_WARN
    const fields = { bytes, limitBytes, percent }
    console.log(
      JSON.stringify(
        full
          ? { level: 'warn', msg: 'route table nearly full', ...fields }
          : { level: 'info', msg: 'route table usage', ...fields }
      )
    )
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'route table usage failed', err: String(err) })
    )
  }
}

const earliest = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)

/**
 * A staged deploy that went live: take its stale check (queued at PENDING_TTL_MS past its
 * staging) off the queue, which would find nothing to do. Never throws.
 */
export async function unqueueStaleCheck(
  deps: Deps,
  site: { id: string; name: string },
  version: { createdAt: string }
): Promise<void> {
  const dueAt = new Date(Date.parse(version.createdAt) + PENDING_TTL_MS).toISOString()
  try {
    await deps.store.deleteMaintenance({ siteId: site.id, name: site.name, dueAt })
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'maintenance not unqueued',
        site: site.name,
        err: String(err),
      })
    )
  }
}

/**
 * Queue maintenance for a site at `at` (epoch ms; now by default), for work that falls due then.
 * Never throws: a write that fails is logged, and the sweep reaches the site anyway.
 */
export async function queueMaintenance(
  deps: Deps,
  site: { id: string; name: string },
  at: number = deps.clock.now().getTime()
): Promise<void> {
  try {
    await deps.store.queueMaintenance({
      siteId: site.id,
      name: site.name,
      dueAt: new Date(at).toISOString(),
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'maintenance not queued',
        site: site.name,
        err: String(err),
      })
    )
  }
}

/**
 * Retention for one site or Path (see the header): `storage` is where its files are. Returns
 * when its next work falls due (epoch ms), if any is coming.
 */
export async function maintainTarget(
  deps: Deps,
  ref: SiteRef,
  storage: string,
  current: string | null,
  result: MaintainResult
): Promise<number | undefined> {
  const now = deps.clock.now().getTime()
  const keep = deps.config.versionRetention
  const versions = await deps.store.listVersions(ref)
  let next: number | undefined
  const later = (at: number) => {
    if (at > now) next = earliest(next, at)
  }
  for (const v of versions) {
    if (v.status === 'pruning' && v.id === current) {
      const { prunedAt: _, ...revived } = v
      if (await deps.store.moveVersion(ref, 'pruning', { ...revived, status: 'complete' })) {
        result.unmarked++
      }
      continue
    }
    const markedAt = v.prunedAt ? Date.parse(v.prunedAt) : Number.NaN
    const due = now - markedAt >= GRACE_MS
    // `sweeping` long after its mark: a sweep that stopped part way, finished here.
    if (
      (v.status === 'pruning' || (v.status === 'sweeping' && now - markedAt >= 2 * GRACE_MS)) &&
      due &&
      v.id !== current
    ) {
      if (v.status === 'pruning' && !(await claim(deps, ref, v))) continue
      // A site server's version is forgotten by its platform first (a Path's never has one).
      const site = 'name' in ref ? (ref as SiteRecord) : null
      if (v.server && site && deps.servers) {
        await deps.servers.retire(serverSite(site), serverVersion(storage, v.id))
      }
      await deps.blobs.deletePrefix(siteVersionPrefix(storage, v.id))
      // What was PUT to a staging URL after its version was checked (a store bound by MD5).
      await deps.blobs.deletePrefix(stagedPrefix(storage, v.id))
      await deps.blobs.delete(manifestKey(storage, v.id))
      await deps.blobs.delete(formsKey(storage, v.id))
      await deps.store.deleteVersion(ref, v.id)
      result.swept++
    } else if (v.status === 'pruning' && v.id !== current) later(markedAt + GRACE_MS)
    else if (v.status === 'sweeping') later(markedAt + 2 * GRACE_MS)
  }
  if (deps.blobs.uploadDigest === 'md5') {
    for (const v of versions) {
      const age = now - Date.parse(v.createdAt)
      const expired = age >= UPLOAD_URL_TTL_SECONDS * 1000
      if (
        v.status === 'complete' &&
        expired &&
        age < UPLOAD_URL_TTL_SECONDS * 1000 + STAGED_WINDOW_MS
      ) {
        await deps.blobs.deletePrefix(stagedPrefix(storage, v.id))
      } else if (v.status === 'complete' && !expired) {
        later(Date.parse(v.createdAt) + UPLOAD_URL_TTL_SECONDS * 1000)
      }
    }
  }
  const stamp = new Date(now).toISOString()
  const mark = async (v: VersionRecord) => {
    if (await deps.store.moveVersion(ref, v.status, { ...v, status: 'pruning', prunedAt: stamp })) {
      result.marked++
      later(now + GRACE_MS)
    }
  }
  for (const v of versions) {
    if (v.status !== 'pending') continue
    const expiry = Date.parse(v.createdAt) + PENDING_TTL_MS
    if (now >= expiry) await mark(v)
    else later(expiry)
  }
  if (keep === 0) return next
  const complete = versions
    .filter(v => v.status === 'complete' && v.id !== current)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1))
  for (const v of complete.slice(keep)) await mark(v)
  return next
}

/** `sweeping`, only if it is still `pruning`: of two runs, one sweeps it. */
async function claim(deps: Deps, ref: SiteRef, v: VersionRecord): Promise<boolean> {
  try {
    return await deps.store.moveVersion(ref, 'pruning', { ...v, status: 'sweeping' })
  } catch (err) {
    if (err instanceof ConditionFailed) return false
    throw err
  }
}

/**
 * Delete the rendered home pages the site replaced between GRACE_MS and HOME_WINDOW_MS ago. The
 * site's list (`homeOld`) is trimmed by refreshHome, never written here (a write of the whole
 * site could undo a change made meanwhile), so the window keeps a run from deleting the same
 * objects on every visit; one missed for longer than the window stays, a few small objects.
 */
async function sweepHomes(
  deps: Deps,
  site: SiteRecord,
  result: MaintainResult
): Promise<number | undefined> {
  const now = deps.clock.now().getTime()
  let next: number | undefined
  for (const h of site.homeOld ?? []) {
    const age = now - Date.parse(h.at)
    if (h.sha === site.home || age >= HOME_WINDOW_MS) continue
    if (age < GRACE_MS) {
      next = earliest(next, Date.parse(h.at) + GRACE_MS)
      continue
    }
    await deps.blobs.delete(renderedObjectKey(site.id, h.sha, 'html'))
    await deps.blobs.delete(renderedObjectKey(site.id, h.sha, 'json'))
    result.homes++
  }
  return next
}

/**
 * A version marked to delete (`pruning`) made complete again, as a publish of its files or a
 * rollback wants it back; any other version as it is.
 */
export async function reviveVersion(
  deps: Deps,
  ref: SiteRef,
  version: VersionRecord | null
): Promise<VersionRecord | null> {
  if (version?.status !== 'pruning') return version
  const { prunedAt: _, ...rest } = version
  const back: VersionRecord = { ...rest, status: 'complete' }
  if (await deps.store.moveVersion(ref, 'pruning', back)) return back
  return deps.store.getVersion(ref, version.id)
}
