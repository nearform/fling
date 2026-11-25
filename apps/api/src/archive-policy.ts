/**
 * The archive policy: archive the sites nobody uses, optionally delete what it archived, and
 * purge deleted sites after a while (the contract clients share is archive-policy.ts in
 * @fling/shared). Off until an operator sets ARCHIVE_INACTIVE_DAYS (or PURGE_DELETED_DAYS), and
 * then in dry run until an admin turns it live (`setArchivePolicyLive`, Admin → Archive policy).
 *
 * Activity: a site's is the latest of its last view, its last push, its creation and its last
 * unarchive (`unarchivedAt`); a site with no activity record (published before metrics) also has
 * its newest version's date. A view or a publish moves it, so nothing needs to tell the policy.
 *
 * The rules, for each site maintenance looks at (maintenance.ts, from its queue or its sweep):
 * - A site that is kept (`keep`, set by its owners or an admin: `setKeep`, sites.ts) is left alone,
 *   whatever else holds: no warning, no archive, no delete, and once deleted no purge.
 * - **Warn first, always.** Nothing is archived or deleted unless its owners were told at least
 *   ARCHIVE_WARN_DAYS before, while the policy was live: the warning (`policyWarning` on the
 *   site, with when it was given and the date it names) is recorded only by a live policy. It
 *   goes out ARCHIVE_WARN_DAYS before the site falls due, or at once for one already overdue (so
 *   going live warns the overdue sites first), and the date is then the later of the two. A
 *   warning holds only while the policy has stayed live since it was given (`at` no earlier than
 *   the switch's `setAt`), so going back to dry run and live again always warns first; and only
 *   while nothing has happened since: a view, a publish or an unarchive after it means the site is
 *   active again, and the next warning is a new one. Keeping a site, and any archive or unarchive,
 *   takes the warning back.
 * - **Archive** a live site (one with a current version) inactive for ARCHIVE_INACTIVE_DAYS once
 *   its warning's date has come: audited as the policy (`site.archive`, ARCHIVE_POLICY_ACTOR),
 *   then archived as an owner's archive does it (taken off the route table, its server disabled),
 *   with `archivedBy: 'policy'`.
 * - **Delete** (DELETE_ARCHIVED_DAYS) only a site the policy archived, that long after it did,
 *   warned the same way (`site.delete_due`), through deletion.ts `removeSite` as the policy:
 *   soft unless SITE_DELETE=hard. An instance without mail never deletes: the site page is the
 *   only warning there, which an archived site's owners may not open. It still archives.
 * - **Purge** (PURGE_DELETED_DAYS): deleted-site records older than that, whoever deleted them,
 *   oldest first and a few a run (`purgeDue`), through deletion.ts `purgeRecord` with every check
 *   an admin's purge makes (never a live id, nor one being restored), audited as the policy.
 *
 * Paused: while views aren't counted (SITE_VIEW_COUNTS off, or an admin turned view counting off)
 * the policy warns, archives and deletes nothing, since a site nobody viewed can't be told from
 * one nobody could count; and once counting is on it waits until views have been counted for
 * ARCHIVE_INACTIVE_DAYS without a break. Counting is measured from the later of the view-counting
 * switch's `onSince` (when an admin last turned it on from off; for the switch Fling set itself,
 * when it first did) and `countingSince` on the policy's own record, which every maintenance run
 * keeps (`observeCounting`): null while it sees no counting, and the time it first sees it again
 * after that, so an operator's SITE_VIEW_COUNTS off and on again is a break too. Purging goes on
 * while paused.
 *
 * Dry run: the same work out of what is due, and nothing done or sent. A site due now is queued
 * to be looked at again a day later, so the preview keeps listing it. The preview (admin page)
 * reads the maintenance queue for the next ARCHIVE_PREVIEW_DAYS and the oldest deleted-site
 * records, so a site maintenance hasn't reached since the policy was turned on shows once its
 * sweep has. Each site is queued for its next warning, archive or delete as it is maintained
 * (`policySite` returns when), so one look carries it to the next; a view moves that date without
 * touching the queue, and the queued look finds the newer activity and queues it later.
 */
import {
  ARCHIVE_POLICY_ACTOR,
  ARCHIVE_PREVIEW_DAYS,
  type ArchiveAction,
  type ArchivePolicyAction,
  type ArchivePolicyPause,
  type ArchivePolicyStatus,
  type ArchivePreviewPurge,
  type ArchivePreviewSite,
  type SiteArchiveDue,
} from '@fling/shared'
import { ensure } from './admin.ts'
import { audit } from './audit.ts'
import type { ArchivePolicyConfig } from './config.ts'
import { purgeRecord, removeSite } from './deletion.ts'
import { ApiError } from './lib/errors.ts'
import { notify } from './notifications/notify.ts'
import type { Principal } from './policy.ts'
import { serverSite } from './servers/index.ts'
import { archive, writeSite } from './sites.ts'
import {
  type DeletedSiteRecord,
  firstOwner,
  type SiteActivityRecord,
  type SiteRecord,
} from './store/types.ts'
import type { Deps } from './types.ts'
import { viewCountingIn } from './views.ts'

const DAY_MS = 86_400_000
/** How long a dry run waits before it looks again at a site it would act on now. */
const DRY_RUN_RECHECK_MS = DAY_MS
/** Deleted-site records a run reads a page of, and purges at most. */
const PURGE_PAGE = 50
const PURGE_MAX = 25
/** Queue entries and sites the preview reads at most, and what it lists of each. */
const PREVIEW_QUEUE = 500
const PREVIEW_SITES = 100
const PREVIEW_PURGE = 100
/** Audit entries read for the recent actions, and how many are listed. */
const RECENT_READ = 500
const RECENT_MAX = 50

/** What one maintenance run (or one read of the admin page) knows of the policy. */
export interface PolicyRun {
  settings: ArchivePolicyConfig
  /** sites are archived (ARCHIVE_INACTIVE_DAYS above 0) */
  archiving: boolean
  /** deleted sites are purged (PURGE_DELETED_DAYS above 0) */
  purging: boolean
  /** live: it acts; false: dry run */
  live: boolean
  setBy?: string
  setAt?: string
  /** the instance sends email (without it, never delete) */
  mail: boolean
  paused: ArchivePolicyPause | null
  countingSince: string | null
  now: number
}

/** What the policy does next to a site: `action` at `at`; `due` is the archive or delete date. */
export interface SitePlan {
  action: ArchiveAction
  at: number
  due: number
  /** the activity (or the archive) it is measured from */
  since: number
}

/** What a maintenance run's policy did (the counts in MaintainResult's `policy`). */
export interface PolicyCounts {
  warned: number
  archived: number
  deleted: number
  purged: number
  /** in dry run: what it would have done now */
  wouldAct: number
}

export const emptyPolicyCounts = (): PolicyCounts => ({
  warned: 0,
  archived: 0,
  deleted: 0,
  purged: 0,
  wouldAct: 0,
})

const latest = (...times: (string | undefined | null)[]) =>
  times.reduce<string | undefined>((a, t) => (t && (!a || t > a) ? t : a), undefined)

/**
 * The policy as it stands now. With `observe` (maintenance), keep the policy's record of view
 * counting (see the header); without it (a read), only work it out.
 */
export async function policyRun(deps: Deps, opts: { observe?: boolean } = {}): Promise<PolicyRun> {
  const settings = deps.config.archivePolicy
  const now = deps.clock.now()
  const nowIso = now.toISOString()
  const [record, switchRecord] = await Promise.all([
    deps.store.getArchivePolicy(),
    deps.store.getViewCounting(),
  ])
  const counting = viewCountingIn(deps.config, switchRecord)
  const switchSince = switchRecord?.on ? (switchRecord.onSince ?? switchRecord.setAt) : undefined
  // What it saw: none yet, the switch's word for it; seen off, counting again from now.
  let seen: string | null
  if (!counting) seen = null
  else if (record?.countingSince === null) seen = nowIso
  else seen = record?.countingSince ?? switchSince ?? nowIso
  if (opts.observe && record?.countingSince !== seen) {
    await deps.store.updateArchivePolicy({ countingSince: seen })
  }
  const countingSince = counting ? (latest(seen, switchSince) ?? nowIso) : null
  const archiving = settings.inactiveDays > 0
  let paused: ArchivePolicyPause | null = null
  if (archiving) {
    if (!deps.config.viewCounts) paused = { reason: 'view_counts_off' }
    else if (!counting || countingSince === null) paused = { reason: 'counting_off' }
    else {
      const until = Date.parse(countingSince) + settings.inactiveDays * DAY_MS
      if (until > now.getTime()) {
        paused = { reason: 'counting_too_short', until: new Date(until).toISOString() }
      }
    }
  }
  return {
    settings,
    archiving,
    purging: settings.purgeDeletedDays > 0,
    live: record?.live === true,
    ...(record?.setBy ? { setBy: record.setBy } : {}),
    ...(record?.setAt ? { setAt: record.setAt } : {}),
    mail: deps.config.mail !== undefined,
    paused,
    countingSince,
    now: now.getTime(),
  }
}

/** The site's activity (see the header), epoch ms. */
export async function activityOf(
  deps: Deps,
  site: SiteRecord,
  activity?: SiteActivityRecord | null
): Promise<number> {
  const counted = activity === undefined ? await deps.store.getSiteActivity(site.id) : activity
  let newest: string | undefined
  if (!counted) {
    const versions = await deps.store.listVersions(site)
    newest = latest(...versions.filter(v => v.status === 'complete').map(v => v.createdAt))
  }
  const at = latest(
    site.createdAt,
    site.unarchivedAt,
    counted?.lastViewAt,
    counted?.lastPushAt,
    newest
  )
  return Date.parse(at ?? site.createdAt)
}

/**
 * What the policy does next to the site, and when (now or later), from the site as stored and its
 * activity (`activityAt`; for an archived site it isn't read); null for nothing. Pure: the same
 * for maintenance, the preview and the site page.
 */
export function planSite(run: PolicyRun, site: SiteRecord, activityAt: number): SitePlan | null {
  if (site.keep || !run.archiving) return null
  const warnMs = run.settings.warnDays * DAY_MS
  // A warning given before the policy last went live (or while it is in dry run) holds nothing.
  const liveSince = run.live ? (run.setAt ? Date.parse(run.setAt) : 0) : Number.POSITIVE_INFINITY
  const warning =
    site.policyWarning && Date.parse(site.policyWarning.at) >= liveSince
      ? site.policyWarning
      : undefined
  if (!site.archived) {
    if (!site.currentVersionId) return null
    const since = activityAt
    const due = since + run.settings.inactiveDays * DAY_MS
    if (warning?.kind === 'archive' && Date.parse(warning.at) >= since) {
      const at = Math.max(due, Date.parse(warning.at) + warnMs)
      return { action: 'archive', at, due: at, since }
    }
    return { action: 'warn_archive', at: due - warnMs, due, since }
  }
  if (site.archivedBy !== 'policy' || !site.archivedAt) return null
  if (run.settings.deleteArchivedDays === 0 || !run.mail) return null
  const since = Date.parse(site.archivedAt)
  const due = since + run.settings.deleteArchivedDays * DAY_MS
  if (warning?.kind === 'delete' && Date.parse(warning.at) >= since) {
    const at = Math.max(due, Date.parse(warning.at) + warnMs)
    return { action: 'delete', at, due: at, since }
  }
  return { action: 'warn_delete', at: due - warnMs, due, since }
}

const warn = (msg: string, fields: Record<string, unknown>) =>
  console.warn(JSON.stringify({ level: 'warn', msg, ...fields }))
const info = (msg: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ level: 'info', msg, ...fields }))

/**
 * Maintenance's step for one site (see the header): do what is due now (live), or only count it
 * (dry run). Returns when the site is next due for the policy (epoch ms), if ever; `gone` when the
 * policy deleted it.
 */
export async function policySite(
  deps: Deps,
  run: PolicyRun,
  site: SiteRecord,
  counts: PolicyCounts
): Promise<number | 'gone' | undefined> {
  if (!run.archiving || site.keep) return undefined
  if (!site.archived && !site.currentVersionId) return undefined
  // Paused until counting has run long enough: look again then, sweep or none.
  if (run.paused) return run.paused.until ? Date.parse(run.paused.until) : undefined
  const activityAt = site.archived ? 0 : await activityOf(deps, site)
  const plan = planSite(run, site, activityAt)
  if (!plan) return undefined
  if (plan.at > run.now) return plan.at
  if (!run.live) {
    counts.wouldAct++
    info('archive policy would act', { site: site.name, action: plan.action })
    return run.now + DRY_RUN_RECHECK_MS
  }
  switch (plan.action) {
    case 'warn_archive':
    case 'warn_delete':
      return warnOwners(deps, run, site, plan, counts)
    case 'archive':
      return archiveAsPolicy(deps, run, site, counts)
    case 'delete':
      return (await deleteAsPolicy(deps, run, site, counts)) ? 'gone' : undefined
  }
}

/**
 * Tell the owners (`site.archive_due` / `site.delete_due`, its id from the site and the activity
 * the warning is about, so a retry records it once), then record the warning on the site, which
 * is what the policy and the site page go by. Without mail nothing is sent and the warning is
 * recorded all the same: the site page says what is coming.
 */
async function warnOwners(
  deps: Deps,
  run: PolicyRun,
  site: SiteRecord,
  plan: SitePlan,
  counts: PolicyCounts
): Promise<number | undefined> {
  const kind = plan.action === 'warn_archive' ? 'archive' : 'delete'
  const dueAt = Math.max(plan.due, run.now + run.settings.warnDays * DAY_MS)
  const since = new Date(plan.since).toISOString()
  await notify(deps, {
    key: kind === 'archive' ? 'site.archive_due' : 'site.delete_due',
    cause: `${site.id}:${since}`,
    actor: ARCHIVE_POLICY_ACTOR,
    siteId: site.id,
    data: { siteName: site.name, dueAt: new Date(dueAt).toISOString(), since },
  })
  const warning = {
    kind,
    at: new Date(run.now).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
  } as const
  const written = await writeSite(
    deps,
    site,
    s => {
      if (s.keep || s.archived !== (kind === 'delete')) return false
      s.policyWarning = warning
      return true
    },
    { touch: false, routes: false }
  )
  if (!written) return undefined
  counts.warned++
  info('archive policy warned', { site: site.name, kind, dueAt: warning.dueAt })
  return dueAt
}

/** Archive the site as the policy, once more sure it is due (its activity read again). */
async function archiveAsPolicy(
  deps: Deps,
  run: PolicyRun,
  site: SiteRecord,
  counts: PolicyCounts
): Promise<number | undefined> {
  const plan = planSite(run, site, await activityOf(deps, site))
  if (plan?.action !== 'archive' || plan.at > run.now) return plan?.at
  await audit(deps, {
    action: 'site.archive',
    actor: ARCHIVE_POLICY_ACTOR,
    target: site.name,
    owner: firstOwner(site),
    siteId: site.id,
  })
  const at = new Date(run.now).toISOString()
  const written = await writeSite(deps, site, s => {
    if (s.keep || s.archived || s.policyWarning?.kind !== 'archive') return false
    archive(s, at, 'policy')
    return true
  })
  if (!written) return undefined
  // As an owner's archive does: its server goes dark with it.
  if (site.server && deps.servers) await deps.servers.setEnabled(serverSite(site), false)
  counts.archived++
  info('archive policy archived', { site: site.name })
  const next = planSite(run, site, 0)
  return next ? next.at : undefined
}

/** Delete the site as the policy (deletion.ts), once more sure it is the one it archived. */
async function deleteAsPolicy(
  deps: Deps,
  run: PolicyRun,
  site: SiteRecord,
  counts: PolicyCounts
): Promise<boolean> {
  const fresh = await deps.store.findSite(site.name)
  if (fresh?.id !== site.id) return false
  const plan = planSite(run, fresh, 0)
  if (plan?.action !== 'delete' || plan.at > run.now) return false
  await removeSite(deps, ARCHIVE_POLICY_ACTOR, fresh)
  counts.deleted++
  info('archive policy deleted', { site: site.name, siteId: site.id })
  return true
}

/** Whether a deleted-site record is the policy's to purge at `at` (epoch ms). */
const purgeable = (run: PolicyRun, r: DeletedSiteRecord, at: number) =>
  !r.keep && !r.restoring && Date.parse(r.deletedAt) + run.settings.purgeDeletedDays * DAY_MS <= at

/**
 * Maintenance's purge (see the header): the deleted-site records older than PURGE_DELETED_DAYS,
 * oldest first, at most PURGE_MAX a run, until the deadline. Live only, paused or not. One it
 * can't purge (live again, a restore under way) is logged and passed over.
 */
export async function purgeDue(
  deps: Deps,
  run: PolicyRun,
  counts: PolicyCounts,
  deadline?: number
): Promise<void> {
  if (!run.purging || !run.live) return
  const cutoff = run.now - run.settings.purgeDeletedDays * DAY_MS
  let after: DeletedSiteRecord | undefined
  for (;;) {
    const page = await deps.store.oldestDeletedSites({
      limit: PURGE_PAGE,
      ...(after ? { after } : {}),
    })
    for (const record of page) {
      if (Date.parse(record.deletedAt) > cutoff) return
      if (counts.purged >= PURGE_MAX) return
      if (deadline !== undefined && Date.now() > deadline) return
      after = record
      if (!purgeable(run, record, run.now)) continue
      try {
        await purgeRecord(deps, ARCHIVE_POLICY_ACTOR, record)
        counts.purged++
        info('archive policy purged', { kind: record.kind, siteId: record.siteId })
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        warn('archive policy purge refused', { siteId: record.siteId, code: err.code })
      }
    }
    if (page.length < PURGE_PAGE) return
  }
}

// --- what clients read -------------------------------------------------------------------------

/**
 * A site's `archiveDue` (GET /api/sites/:name): what the policy will do to it and when, while it
 * is live and not paused; undefined otherwise, or when nothing is coming.
 */
export async function siteArchiveDue(
  deps: Deps,
  site: SiteRecord
): Promise<SiteArchiveDue | undefined> {
  if (!deps.config.archivePolicy.inactiveDays || site.keep) return undefined
  const run = await policyRun(deps)
  if (!run.live || run.paused) return undefined
  const plan = planSite(run, site, site.archived ? 0 : await activityOf(deps, site))
  if (!plan) return undefined
  const warned = plan.action === 'archive' || plan.action === 'delete'
  const action = plan.action === 'archive' || plan.action === 'warn_archive' ? 'archive' : 'delete'
  // Not warned yet: the earliest it can be is a warning's length from now.
  const at = warned
    ? plan.at
    : Math.max(plan.due, Math.max(plan.at, run.now) + run.settings.warnDays * DAY_MS)
  return { action, at: new Date(at).toISOString(), warned }
}

/** The steps of a site's plan that fall from now to `to` (a warning, then what it warns of). */
function previewSteps(run: PolicyRun, site: SiteRecord, plan: SitePlan, to: number) {
  const iso = (t: number) => new Date(t).toISOString()
  const steps: ArchivePreviewSite[] = []
  const base = { name: site.name, owner: firstOwner(site), since: iso(plan.since) }
  const first = Math.max(plan.at, run.now)
  if (first > to) return steps
  steps.push({ ...base, action: plan.action, at: iso(first) })
  if (plan.action === 'warn_archive' || plan.action === 'warn_delete') {
    const then = Math.max(plan.due, first + run.settings.warnDays * DAY_MS)
    // Without mail, a site the policy archives is never deleted.
    const next = plan.action === 'warn_archive' ? 'archive' : 'delete'
    if (then <= to) steps.push({ ...base, action: next, at: iso(then) })
  }
  return steps
}

/** The preview (see the header): what falls due in the next ARCHIVE_PREVIEW_DAYS. */
async function preview(deps: Deps, run: PolicyRun): Promise<ArchivePolicyStatus['preview']> {
  const to = run.now + ARCHIVE_PREVIEW_DAYS * DAY_MS
  const sites: ArchivePreviewSite[] = []
  let more = false
  if (run.archiving && !run.paused) {
    const queued = await deps.store.dueMaintenance(new Date(to).toISOString(), PREVIEW_QUEUE)
    if (queued.length >= PREVIEW_QUEUE) more = true
    const seen = new Set<string>()
    for (const entry of queued) {
      if (seen.has(entry.siteId)) continue
      if (seen.size >= PREVIEW_SITES) {
        more = true
        break
      }
      seen.add(entry.siteId)
      const site = await deps.store.findSite(entry.name)
      if (site?.id !== entry.siteId || site.keep) continue
      if (!site.archived && !site.currentVersionId) continue
      const plan = planSite(run, site, site.archived ? 0 : await activityOf(deps, site))
      if (plan) sites.push(...previewSteps(run, site, plan, to))
    }
    sites.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name))
  }
  const purge: ArchivePreviewPurge[] = []
  if (run.purging) {
    let after: DeletedSiteRecord | undefined
    scan: for (;;) {
      const page = await deps.store.oldestDeletedSites({
        limit: PURGE_PAGE,
        ...(after ? { after } : {}),
      })
      for (const r of page) {
        after = r
        const at = Date.parse(r.deletedAt) + run.settings.purgeDeletedDays * DAY_MS
        if (at > to) break scan
        if (!purgeable(run, r, to)) continue
        if (purge.length >= PREVIEW_PURGE) {
          more = true
          break scan
        }
        purge.push({
          kind: r.kind,
          siteId: r.siteId,
          ...(r.pathId !== undefined ? { pathId: r.pathId } : {}),
          name: r.name,
          ...(r.folder !== undefined ? { folder: r.folder } : {}),
          deletedAt: r.deletedAt,
          at: new Date(Math.max(at, run.now)).toISOString(),
        })
      }
      if (page.length < PURGE_PAGE) break
    }
  }
  return {
    from: new Date(run.now).toISOString(),
    to: new Date(to).toISOString(),
    sites,
    purge,
    more,
  }
}

const POLICY_ACTIONS = new Set<ArchivePolicyAction['action']>([
  'site.archive',
  'site.delete',
  'site.purge',
  'path.purge',
])

/** What the policy did lately, from the audit log (the latest RECENT_READ entries). */
async function recent(deps: Deps): Promise<ArchivePolicyAction[]> {
  const entries = await deps.store.listAuditEntries(RECENT_READ)
  return entries
    .filter(e => e.actor === ARCHIVE_POLICY_ACTOR)
    .flatMap(e =>
      POLICY_ACTIONS.has(e.action as ArchivePolicyAction['action'])
        ? [
            {
              at: e.at,
              action: e.action as ArchivePolicyAction['action'],
              target: e.target,
              ...(e.siteId ? { siteId: e.siteId } : {}),
              ...(e.change ? { change: e.change } : {}),
            },
          ]
        : []
    )
    .slice(0, RECENT_MAX)
}

/** GET /api/admin/archive-policy: the settings, the switch, why it is paused, the preview, recent actions. */
export async function archivePolicyStatus(deps: Deps, p: Principal): Promise<ArchivePolicyStatus> {
  ensure(p, 'admin.archive.read')
  const run = await policyRun(deps)
  return {
    settings: run.settings,
    on: run.archiving || run.purging,
    live: run.live,
    ...(run.setBy ? { setBy: run.setBy } : {}),
    ...(run.setAt ? { setAt: run.setAt } : {}),
    mail: run.mail,
    siteDelete: deps.config.siteDelete,
    paused: run.paused,
    countingSince: run.countingSince,
    preview: await preview(deps, run),
    recent: await recent(deps),
  }
}

/**
 * PUT /api/admin/archive-policy: turn the policy live, or back to dry run (`admin.archive.write`:
 * an admin's browser session), audited. 400 `archive_policy_off` while nothing of it is on.
 */
export async function setArchivePolicyLive(
  deps: Deps,
  p: Principal,
  live: boolean
): Promise<ArchivePolicyStatus> {
  ensure(p, 'admin.archive.write')
  const { inactiveDays, purgeDeletedDays } = deps.config.archivePolicy
  if (!inactiveDays && !purgeDeletedDays) {
    throw new ApiError(
      400,
      'archive_policy_off',
      'This Fling has no archive policy (ARCHIVE_INACTIVE_DAYS and PURGE_DELETED_DAYS are 0)'
    )
  }
  // Switched to where it is already: nothing to record, and `setAt` keeps the warnings it holds.
  if (((await deps.store.getArchivePolicy())?.live === true) === live) {
    return archivePolicyStatus(deps, p)
  }
  await audit(deps, {
    action: 'archive_policy.switch',
    actor: p.email,
    target: live ? 'live' : 'dry_run',
  })
  await deps.store.updateArchivePolicy({
    live,
    setBy: p.email,
    setAt: deps.clock.now().toISOString(),
  })
  return archivePolicyStatus(deps, p)
}
