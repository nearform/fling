/**
 * The archive policy: what the API, the CLI, the MCP servers and the web UI share about archiving
 * the sites nobody uses (apps/api/src/archive-policy.ts has the rules). Browser-safe (zod only).
 *
 * An operator turns it on with `ARCHIVE_INACTIVE_DAYS` (advertised as the `archivePolicy`
 * capability); `DELETE_ARCHIVED_DAYS` adds deleting what it archived, and `PURGE_DELETED_DAYS`
 * purging deleted sites (on its own too: the `purgeDeleted` capability). It starts in dry run: it works out what it would do and does nothing until
 * an admin turns it live on Admin → Archive policy. A site's owners and admins exempt it with the
 * keep flag (`PUT /api/sites/:name/keep`, `fling keep`, `fling_keep`).
 */
import { z } from 'zod'
import type { InstanceMetadata } from './instance.ts'

/** Where an admin sees the policy, and turns it live: Admin → Archive policy. */
export const ADMIN_ARCHIVE_POLICY_PATH = '/admin/archive-policy'

/** Who the audit log names for what the policy does (`site.archive`, `site.delete`, `site.purge`). */
export const ARCHIVE_POLICY_ACTOR = 'archive-policy'

/** How far ahead the admin page's preview looks. */
export const ARCHIVE_PREVIEW_DAYS = 7

/** Whether the instance archives sites nobody uses (the `archivePolicy` capability). */
export const archivePolicyOf = (
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean => instance?.capabilities?.archivePolicy === true

/**
 * Whether the instance has the policy on in any form: archiving, or purging deleted sites only
 * (`purgeDeleted`). What offers fling_admin_archive_policy.
 */
export const archivePolicyOnOf = (
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean => archivePolicyOf(instance) || instance?.capabilities?.purgeDeleted === true

/** The operator's settings, in days; 0 is off. */
export const ArchivePolicySettingsSchema = z.object({
  /** ARCHIVE_INACTIVE_DAYS: no view and no push for this long, and the site is archived */
  inactiveDays: z.number().int().nonnegative(),
  /** ARCHIVE_WARN_DAYS: the owners are told this long before an archive or a delete */
  warnDays: z.number().int().nonnegative(),
  /** DELETE_ARCHIVED_DAYS: a site the policy archived is deleted this long after */
  deleteArchivedDays: z.number().int().nonnegative(),
  /** PURGE_DELETED_DAYS: a deleted site's kept files are deleted for good this long after */
  purgeDeletedDays: z.number().int().nonnegative(),
})
export type ArchivePolicySettings = z.infer<typeof ArchivePolicySettingsSchema>

/**
 * Why the policy warns, archives and deletes nothing just now (purging goes on):
 * - `view_counts_off`: the instance counts no views (`SITE_VIEW_COUNTS=off`);
 * - `counting_off`: an admin turned view counting off (Admin → Usage);
 * - `counting_too_short`: views have been counted for less than ARCHIVE_INACTIVE_DAYS (`until`:
 *   when they will have been), so a site nobody viewed can't be told from one nobody could count.
 */
export const ArchivePolicyPauseSchema = z.object({
  reason: z.enum(['view_counts_off', 'counting_off', 'counting_too_short']),
  until: z.string().optional(),
})
export type ArchivePolicyPause = z.infer<typeof ArchivePolicyPauseSchema>

/** What the policy does to a site next. */
export const ArchiveActionSchema = z.enum(['warn_archive', 'archive', 'warn_delete', 'delete'])
export type ArchiveAction = z.infer<typeof ArchiveActionSchema>

/** A site the preview lists: what the policy does to it, and when (now, or a time to come). */
export const ArchivePreviewSiteSchema = z.object({
  name: z.string(),
  owner: z.string(),
  action: ArchiveActionSchema,
  at: z.string(),
  /** when the site was last viewed or published (an archive), or archived (a delete) */
  since: z.string(),
})
export type ArchivePreviewSite = z.infer<typeof ArchivePreviewSiteSchema>

/** A deleted site (or a Path deleted on its own) the preview lists as purged, and when. */
export const ArchivePreviewPurgeSchema = z.object({
  kind: z.enum(['site', 'path']),
  siteId: z.string(),
  pathId: z.string().optional(),
  name: z.string(),
  folder: z.string().optional(),
  deletedAt: z.string(),
  at: z.string(),
})
export type ArchivePreviewPurge = z.infer<typeof ArchivePreviewPurgeSchema>

/** Something the policy did, from the audit log. */
export const ArchivePolicyActionSchema = z.object({
  at: z.string(),
  action: z.enum(['site.archive', 'site.delete', 'site.purge', 'path.purge']),
  /** the site's name (a Path's: `<site>/<folder>`) */
  target: z.string(),
  siteId: z.string().optional(),
  /** a delete: `soft` or `hard` */
  change: z.string().optional(),
})
export type ArchivePolicyAction = z.infer<typeof ArchivePolicyActionSchema>

/** `GET /api/admin/archive-policy` (and the PUT's answer). */
export const ArchivePolicyStatusSchema = z.object({
  settings: ArchivePolicySettingsSchema,
  /** any of it is on (ARCHIVE_INACTIVE_DAYS or PURGE_DELETED_DAYS above 0) */
  on: z.boolean(),
  /** live: it acts; false: dry run, it only works out what it would do */
  live: z.boolean(),
  /** who last turned it live or back to dry run, and when; absent while it never was */
  setBy: z.string().optional(),
  setAt: z.string().optional(),
  /** the instance sends email: without it the policy archives (the site page says so) but never deletes */
  mail: z.boolean(),
  /** what a delete does here (SITE_DELETE) */
  siteDelete: z.enum(['soft', 'hard']),
  /** why it acts on no site just now; null when it does */
  paused: ArchivePolicyPauseSchema.nullable(),
  /** since when views have been counted without a break; null while they aren't */
  countingSince: z.string().nullable(),
  /**
   * What it would do (dry run) or will do (live) in the next ARCHIVE_PREVIEW_DAYS: the sites
   * maintenance has queued for then, and the deleted sites whose purge falls due, soonest first.
   * Sites maintenance hasn't reached since the policy was turned on appear once its sweep has.
   */
  preview: z.object({
    from: z.string(),
    to: z.string(),
    sites: z.array(ArchivePreviewSiteSchema),
    purge: z.array(ArchivePreviewPurgeSchema),
    /** there is more than these lists hold */
    more: z.boolean(),
  }),
  /** what it did lately, newest first (from the audit log) */
  recent: z.array(ArchivePolicyActionSchema),
})
export type ArchivePolicyStatus = z.infer<typeof ArchivePolicyStatusSchema>

/** `PUT /api/admin/archive-policy`: live, or back to dry run. */
export const ArchivePolicySwitchRequestSchema = z.object({ live: z.boolean() })
export type ArchivePolicySwitchRequest = z.infer<typeof ArchivePolicySwitchRequestSchema>

/** `PUT /api/sites/:name/keep`: exempt the site from the archive policy, or stop exempting it. */
export const SiteKeepRequestSchema = z.object({ keep: z.boolean() })
export type SiteKeepRequest = z.infer<typeof SiteKeepRequestSchema>

/**
 * What the policy will do to one site (`archiveDue` on `GET /api/sites/:name`), while it is live
 * and not paused: archive it (`archive`) or delete it (`delete`, one it archived) at `at`, unless
 * it is viewed or published (or, for a delete, unarchived) first, or an owner keeps it. `warned`:
 * its owners have been told (the date is then firm); before that `at` is the earliest it can be.
 */
export const SiteArchiveDueSchema = z.object({
  action: z.enum(['archive', 'delete']),
  at: z.string(),
  warned: z.boolean(),
})
export type SiteArchiveDue = z.infer<typeof SiteArchiveDueSchema>

/** Admin → Archive policy in the app, at `appOrigin`. */
export const adminArchivePolicyUrl = (appOrigin: string) =>
  `${appOrigin.replace(/\/+$/, '')}${ADMIN_ARCHIVE_POLICY_PATH}`

/** The line the policy's status ends with in the CLI and the MCP servers: where it is switched. */
export const archivePolicySwitchLine = (appOrigin: string) =>
  `Turn it live or back to dry run at Admin → Archive policy: ${adminArchivePolicyUrl(appOrigin)} (an admin's browser session; no command or tool does)`

/** `2026-12-03`: the UTC day of an ISO time, the default for the copy below. */
const isoDay = (iso: string) => iso.slice(0, 10)

/** A date in copy (the CLI passes its local `2026-12-03 07:54`). */
export type DateText = (iso: string) => string

/** The archive policy's fields on a site (`GET /api/sites/:name`). */
export interface SiteArchiveFields {
  archived?: boolean
  keep?: boolean
  archivedAt?: string
  archivedBy?: 'policy'
  archiveDue?: SiteArchiveDue
}

/** A site the policy archived, as a sentence without its full stop; null for any other site. */
export function describePolicyArchived(
  site: Pick<SiteArchiveFields, 'archived' | 'archivedBy' | 'archivedAt'>,
  date: DateText = isoDay
): string | null {
  if (!site.archived || site.archivedBy !== 'policy') return null
  return `${site.archivedAt ? `Archived by the archive policy on ${date(site.archivedAt)}` : 'Archived by the archive policy'}: unarchiving or publishing it brings it back`
}

/** What the policy will do to a site and when (`archiveDue`), as a sentence without its full stop. */
export function describeArchiveDue(due: SiteArchiveDue, date: DateText = isoDay): string {
  const what = due.action === 'archive' ? 'archived' : 'deleted'
  const unless =
    due.action === 'archive'
      ? 'unless someone views or publishes it first, or an owner keeps it'
      : 'unless it is unarchived first, or an owner keeps it'
  return `Will be ${what} on ${date(due.at)}${due.warned ? '' : ' at the earliest'}, ${unless}${due.warned ? ' (its owners have been told)' : ''}`
}

/** A kept site, as a sentence without its full stop. */
export const KEPT_TEXT = 'Kept: the archive policy never warns of, archives or deletes it'

/**
 * What `fling info`, fling_info and the site page say of the archive policy for one site: kept,
 * archived by the policy, and what it will do next and when. Nothing for a site the policy has
 * nothing to say of.
 */
export function describeSiteArchive(site: SiteArchiveFields, date: DateText = isoDay): string[] {
  const lines: string[] = []
  if (site.keep) lines.push(KEPT_TEXT)
  const archived = describePolicyArchived(site, date)
  if (archived) lines.push(archived)
  if (site.archiveDue) lines.push(describeArchiveDue(site.archiveDue, date))
  return lines
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** Why the policy is paused, in a sentence. */
export function describeArchivePause(p: ArchivePolicyPause, date: DateText = isoDay): string {
  const why =
    p.reason === 'view_counts_off'
      ? 'this Fling counts no views (SITE_VIEW_COUNTS is off)'
      : p.reason === 'counting_off'
        ? 'view counting is turned off (Admin → Usage)'
        : `views have been counted for too short a time${p.until ? `, until ${date(p.until)}` : ''}`
  return `Paused: it warns, archives and deletes nothing while ${why}, since a site nobody viewed can't be told from one nobody could count. Purging goes on.`
}

/** What off (nothing configured) means, as the CLI, the MCP servers and the admin page say it. */
export const ARCHIVE_POLICY_OFF_TEXT =
  'Off: this Fling archives no sites for disuse and purges no deleted ones.'

/** What dry run or live means, after its name: "it works out what it would do, …". */
export const archivePolicyStateText = (s: Pick<ArchivePolicyStatus, 'live'>) =>
  s.live
    ? 'it warns owners, archives, deletes and purges as set below.'
    : 'it works out what it would do, and does and sends nothing.'

/** What the settings make it do, a line each: what it archives, deletes and purges. */
export function describeArchivePolicyRules(
  s: Pick<ArchivePolicyStatus, 'settings' | 'mail' | 'siteDelete'>
): string[] {
  const { inactiveDays, warnDays, deleteArchivedDays, purgeDeletedDays } = s.settings
  const lines: string[] = []
  if (inactiveDays) {
    lines.push(
      `Archives a site nobody has viewed or published for ${days(inactiveDays)}, after telling its owners ${days(warnDays)} before. A kept site is left alone.`
    )
    if (!deleteArchivedDays) lines.push('Never deletes the sites it archives.')
    else if (!s.mail) {
      lines.push(
        `Never deletes the sites it archives: this Fling sends no email, so their owners can't be warned (deleting is set for ${days(deleteArchivedDays)} after).`
      )
    } else {
      lines.push(
        `Deletes a site it archived ${days(deleteArchivedDays)} after, warning its owners first; ${s.siteDelete === 'soft' ? 'an admin can recover it' : 'for good'}.`
      )
    }
  } else lines.push('Archives no sites.')
  lines.push(
    purgeDeletedDays
      ? `Deletes a deleted site's kept files for good ${days(purgeDeletedDays)} after it was deleted.`
      : 'Keeps deleted sites until an admin deletes them for good.'
  )
  return lines
}

/** Since when views have been counted, as a sentence. */
export const describeCountingSince = (since: string | null, date: DateText = isoDay) =>
  since ? `Views counted without a break since ${date(since)}.` : 'Views are not being counted.'

/**
 * The state and the settings, a line each: dry run or live (and who switched it), what it
 * archives, deletes and purges, and whether it is paused.
 */
export function describeArchivePolicySettings(
  s: ArchivePolicyStatus,
  date: DateText = isoDay
): string[] {
  if (!s.on) return [ARCHIVE_POLICY_OFF_TEXT]
  const switched = s.setBy ? ` (by ${s.setBy}${s.setAt ? ` on ${date(s.setAt)}` : ''})` : ''
  return [
    `${s.live ? 'Live' : 'Dry run'}${switched}: ${archivePolicyStateText(s)}`,
    ...describeArchivePolicyRules(s),
    ...(s.paused ? [describeArchivePause(s.paused, date)] : []),
    describeCountingSince(s.countingSince, date),
  ]
}

const ACTION_TEXT: Record<ArchiveAction, string> = {
  warn_archive: 'warn its owners it will be archived',
  archive: 'archive',
  warn_delete: 'warn its owners it will be deleted',
  delete: 'delete',
}

/** `archive`, `warn its owners it will be archived`…: what the preview says the policy does. */
export const archiveActionText = (a: ArchiveAction) => ACTION_TEXT[a]

/** `now`, or the date: when a preview entry falls due (`from` is the preview's start). */
export const archiveWhen = (at: string, from: string, date: DateText = isoDay) =>
  at <= from ? 'now' : date(at)

/** One site of the preview on a line. */
export function describePreviewSite(
  p: ArchivePreviewSite,
  from: string,
  date: DateText = isoDay
): string {
  const since = p.action.endsWith('delete') ? 'archived' : 'last viewed or published'
  return `- ${archiveWhen(p.at, from, date)}: ${archiveActionText(p.action)} ${p.name} (owner ${p.owner}; ${since} ${date(p.since)})`
}

/** One purge of the preview on a line. */
export function describePreviewPurge(
  p: ArchivePreviewPurge,
  from: string,
  date: DateText = isoDay
): string {
  const what = p.kind === 'path' ? `${p.folder}/ of ${p.name}` : p.name
  return `- ${archiveWhen(p.at, from, date)}: delete for good ${what} (deleted ${date(p.deletedAt)})`
}

/** What the policy did, as a verb for its target: `archived`, `deleted for good`… */
export function archivePolicyActionText(a: Pick<ArchivePolicyAction, 'action' | 'change'>) {
  return a.action === 'site.archive'
    ? 'archived'
    : a.action === 'site.delete'
      ? a.change === 'hard'
        ? 'deleted for good'
        : 'deleted'
      : 'deleted the kept files for good of'
}

/** One thing the policy did, on a line. */
export function describeArchivePolicyAction(a: ArchivePolicyAction, date: DateText = isoDay) {
  return `- ${date(a.at)}: ${archivePolicyActionText(a)} ${a.target}`
}

/**
 * The policy's status as text, for the MCP servers: the settings, then what it would (dry run) or
 * will (live) do in the next ARCHIVE_PREVIEW_DAYS, what it did lately, and where it is switched.
 */
export function describeArchivePolicy(
  s: ArchivePolicyStatus,
  opts: { fling: string; appOrigin: string; date?: DateText }
): string {
  const date = opts.date ?? isoDay
  const { preview } = s
  const coming = [
    ...preview.sites.map(p => describePreviewSite(p, preview.from, date)),
    ...preview.purge.map(p => describePreviewPurge(p, preview.from, date)),
  ]
  const verb = s.live ? 'will do' : 'would do'
  return [
    `The archive policy on ${opts.fling}:`,
    ...describeArchivePolicySettings(s, date),
    ...(s.on
      ? [
          '',
          `What it ${verb} in the next ${ARCHIVE_PREVIEW_DAYS} days:`,
          ...(coming.length ? coming : ['(nothing)']),
          ...(preview.more ? ['(and more: see Admin → Archive policy)'] : []),
        ]
      : []),
    ...(s.recent.length
      ? ['', 'What it did lately:', ...s.recent.map(a => describeArchivePolicyAction(a, date))]
      : []),
    '',
    archivePolicySwitchLine(opts.appOrigin),
  ].join('\n')
}
