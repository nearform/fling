/**
 * Maintenance, run on a schedule (hourly: the AWS scheduler's `{fling: "maintain"}`, the Worker's
 * hourly cron). It deletes what nothing serves any more, a site at a time from the site directory,
 * until its deadline; the next run starts again from the top, and finds done what was done.
 *
 * Retention (`VERSION_RETENTION`, config.ts; 0 keeps everything): each site and each of its Paths
 * (paths.ts) keeps its current version and its newest N complete versions. Every version owns its
 * files (`<storage>/<versionId>/`), so deleting one touches nothing else. Mark, then sweep:
 *   1. **Mark**: a complete version past the newest N becomes `pruning` (`prunedAt`). So does a
 *      pending one older than PENDING_TTL_MS (a deploy staged and never finalized).
 *   2. **Sweep**, at least GRACE_MS after the mark: claimed as `sweeping` (moveVersion, so only one
 *      run does it), its files, manifest and forms config are deleted, then its records
 *      (deleteVersion: both its keys).
 * The grace covers a route still naming it (Cloudflare's KV trails a change by about a minute), a
 * pull's signed URLs (PULL_URL_TTL_SECONDS) and a finalize in flight. A version that became current
 * meanwhile (a rollback, or a deploy of the same files) is unmarked, never swept. Publication
 * revives a `pruning` version it repoints to, and answers 409 `retry_later` for one `sweeping`.
 *
 * Rendered home pages (paths.ts `refreshHome`): each one a site replaced (`homeOld`) is deleted
 * GRACE_MS after it was replaced (`sweepHomes`).
 */
import { renderedObjectKey, siteVersionPrefix } from '@fling/shared'
import { formsKey, manifestKey } from './blobs/types.ts'
import { pathRef } from './paths.ts'
import type { SiteRecord, SiteRef, VersionRecord } from './store/types.ts'
import { ConditionFailed } from './table/types.ts'
import type { Deps } from './types.ts'

/** How long a marked version or a replaced home page waits before it is deleted. */
export const GRACE_MS = 60 * 60 * 1000
/** A pending version older than this is a deploy nobody will finalize. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000
/** Replaced home pages older than this are taken to be deleted already (`sweepHomes`). */
const HOME_WINDOW_MS = 2 * 24 * 60 * 60 * 1000
/** The most sites one run reads from the directory. */
const MAX_SITES = 100_000

export interface MaintainResult {
  sites: number
  marked: number
  swept: number
  unmarked: number
  homes: number
  /** stopped at the deadline before the last site */
  partial: boolean
}

export async function maintain(
  deps: Deps,
  opts: { deadline?: number } = {}
): Promise<MaintainResult> {
  const result: MaintainResult = {
    sites: 0,
    marked: 0,
    swept: 0,
    unmarked: 0,
    homes: 0,
    partial: false,
  }
  const { sites } = await deps.store.listAllSites({ max: MAX_SITES })
  for (const entry of sites) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      result.partial = true
      break
    }
    const site = await deps.store.findSite(entry.name)
    if (!site) continue
    result.sites++
    await maintainTarget(deps, site, site.id, site.currentVersionId, result)
    for (const path of await deps.store.listPaths(site.id)) {
      await maintainTarget(deps, pathRef(site, path), path.id, path.currentVersionId, result)
    }
    await sweepHomes(deps, site, result)
  }
  return result
}

/** Retention for one site or Path (see the header): `storage` is where its files are. */
export async function maintainTarget(
  deps: Deps,
  ref: SiteRef,
  storage: string,
  current: string | null,
  result: MaintainResult
) {
  const now = deps.clock.now().getTime()
  const keep = deps.config.versionRetention
  const versions = await deps.store.listVersions(ref)
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
      await deps.blobs.deletePrefix(siteVersionPrefix(storage, v.id))
      await deps.blobs.delete(manifestKey(storage, v.id))
      await deps.blobs.delete(formsKey(storage, v.id))
      await deps.store.deleteVersion(ref, v.id)
      result.swept++
    }
  }
  const stamp = new Date(now).toISOString()
  const mark = async (v: VersionRecord) => {
    if (await deps.store.moveVersion(ref, v.status, { ...v, status: 'pruning', prunedAt: stamp })) {
      result.marked++
    }
  }
  for (const v of versions) {
    if (v.status === 'pending' && now - Date.parse(v.createdAt) >= PENDING_TTL_MS) await mark(v)
  }
  if (keep === 0) return
  const complete = versions
    .filter(v => v.status === 'complete' && v.id !== current)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1))
  for (const v of complete.slice(keep)) await mark(v)
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
 * objects every hour; one missed for longer than the window stays, a few small objects.
 */
async function sweepHomes(deps: Deps, site: SiteRecord, result: MaintainResult) {
  const now = deps.clock.now().getTime()
  for (const h of site.homeOld ?? []) {
    const age = now - Date.parse(h.at)
    if (age < GRACE_MS || age >= HOME_WINDOW_MS || h.sha === site.home) continue
    await deps.blobs.delete(renderedObjectKey(site.id, h.sha, 'html'))
    await deps.blobs.delete(renderedObjectKey(site.id, h.sha, 'json'))
    result.homes++
  }
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
