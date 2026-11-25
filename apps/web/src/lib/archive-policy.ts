/**
 * The archive policy, worked out apart from React: who sees Admin → Archive policy, what its
 * settings, state, pause, preview and recent actions say, what turning it live or back to dry run
 * asks, and the site page's "Will be archived on …" and "Archived by the archive policy" notices.
 * The words the CLI and the MCP servers use too (the settings, the pause, the preview's actions,
 * the recent actions, the site's notices) are @fling/shared's archive-policy.ts; this adds what
 * only the page says. The rules are the API's archive-policy.ts.
 */
import {
  ADMIN_ARCHIVE_POLICY_PATH,
  ARCHIVE_POLICY_ACTOR,
  ARCHIVE_POLICY_OFF_TEXT,
  type ArchiveAction,
  type ArchivePolicyAction,
  type ArchivePolicyPause,
  type ArchivePolicyStatus,
  archiveActionText,
  archivePolicyActionText,
  archivePolicyStateText,
  archiveWhen,
  describeArchiveDue,
  describeArchivePause,
  describeArchivePolicyRules,
  describeCountingSince,
  describePolicyArchived,
  KEPT_TEXT,
  type Me,
  type Site,
  type SiteArchiveDue,
} from '@fling/shared'
import { showsAdmin } from './admin'
import { ApiError, errorMessage } from './api'

export { ADMIN_ARCHIVE_POLICY_PATH, ARCHIVE_POLICY_ACTOR }

/**
 * Whether Admin offers Archive policy: admins, in their own session, on every instance. Where the
 * operator has not turned it on, the page says how.
 */
export const showsArchivePolicyAdmin = (me: Me | null | undefined) => showsAdmin(me)

/** A date the policy names, without the time: "2 December 2026" (the reader's own format). */
export function dayDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { dateStyle: 'long' })
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** The four variables an operator sets, in the order the page explains them. */
export const ARCHIVE_POLICY_VARIABLES = [
  {
    name: 'ARCHIVE_INACTIVE_DAYS',
    about: 'Archive a site nobody has viewed or published for this many days. Turns the policy on.',
  },
  {
    name: 'ARCHIVE_WARN_DAYS',
    about:
      'Warn its owners this many days before an archive or a delete, by email and on the site page (the only warning where the Fling sends no email); 7 unless set.',
  },
  {
    name: 'DELETE_ARCHIVED_DAYS',
    about: 'Delete a site the policy archived this many days after it did (0: never).',
  },
  {
    name: 'PURGE_DELETED_DAYS',
    about: 'Delete a deleted site’s kept files for good this many days after (0: never).',
  },
] as const

/** Under the variables, where it is off: what they are unless set. */
export const TURN_ON_DEFAULTS =
  'The day settings are 0 (off) unless set, but for ARCHIVE_WARN_DAYS, which is 7. A site’s owners exempt it with Keep, in its Settings.'

export type ArchivePolicyState = 'off' | 'dry_run' | 'live'

/** Off (nothing of it is configured), Dry run (works out what it would do) or Live (acts). */
export const policyState = (s: Pick<ArchivePolicyStatus, 'on' | 'live'>): ArchivePolicyState =>
  !s.on ? 'off' : s.live ? 'live' : 'dry_run'

export const STATE_LABEL: Record<ArchivePolicyState, string> = {
  off: 'Off',
  dry_run: 'Dry run',
  live: 'Live',
}

/** A shared phrase as the page shows it: capitalised. */
export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A shared sentence as the page shows it: capitalised, ending in a full stop. */
export const sentence = (text: string): string => {
  const s = capitalise(text)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

/** What the state means, under its name (the CLI's and the MCP servers' words). */
export const stateText = (s: ArchivePolicyStatus): string =>
  s.on ? sentence(archivePolicyStateText(s)) : ARCHIVE_POLICY_OFF_TEXT

/** What the settings make it do, a line each (the CLI's and the MCP servers' words). */
export const settingsText = (s: Pick<ArchivePolicyStatus, 'settings' | 'mail' | 'siteDelete'>) =>
  describeArchivePolicyRules(s)

/** The variables behind them, with their values, for the operator to check. */
export function settingVariables(
  s: Pick<ArchivePolicyStatus, 'settings' | 'siteDelete'>
): { name: string; value: string }[] {
  const { inactiveDays, warnDays, deleteArchivedDays, purgeDeletedDays } = s.settings
  return [
    { name: 'ARCHIVE_INACTIVE_DAYS', value: String(inactiveDays) },
    { name: 'ARCHIVE_WARN_DAYS', value: String(warnDays) },
    { name: 'DELETE_ARCHIVED_DAYS', value: String(deleteArchivedDays) },
    { name: 'PURGE_DELETED_DAYS', value: String(purgeDeletedDays) },
    { name: 'SITE_DELETE', value: s.siteDelete },
  ]
}

/** Why the policy acts on no site just now, as the paused banner says it. */
export const pausedText = (pause: ArchivePolicyPause): string =>
  describeArchivePause(pause, dayDate)

/** Since when views have been counted, under the paused banner. */
export const countingText = (since: string | null): string => describeCountingSince(since, dayDate)

/** What the preview says the policy does to a site: "Warn its owners it will be archived". */
export const previewAction = (a: ArchiveAction): string => capitalise(archiveActionText(a))

/** A preview row's date: "Now" for what is due already, else the day. */
export const previewWhen = (at: string, from: string): string => {
  const when = archiveWhen(at, from, dayDate)
  return when === 'now' ? 'Now' : when
}

/** The preview's heading line: what it would do (dry run) or will do (live) in the days ahead. */
export function previewIntro(s: ArchivePolicyStatus): string {
  const what = s.live ? 'will do' : 'would do if it were live'
  return `What it ${what} from now to ${dayDate(s.preview.to)}.`
}

/** A recent action, as a verb for its target: "Deleted for good". */
export const recentLabel = (a: Pick<ArchivePolicyAction, 'action' | 'change'>): string =>
  capitalise(archivePolicyActionText(a))

/** What turning it live asks: who is warned, and how soon anything is archived or deleted. */
export function goLiveConfirm(
  s: Pick<ArchivePolicyStatus, 'settings' | 'mail'>,
  fling: string
): string {
  const { inactiveDays, warnDays, deleteArchivedDays, purgeDeletedDays } = s.settings
  const parts: string[] = []
  if (inactiveDays) {
    // ARCHIVE_WARN_DAYS is at least 1 while archiving is on (config.ts refuses 0).
    parts.push(
      `The owners of the sites due get warned first${s.mail ? ' by email' : ', on the site page only (this Fling sends no email)'}: nothing is archived for at least ${days(warnDays)}.`
    )
    if (deleteArchivedDays && s.mail) {
      parts.push(
        `A site it archives is deleted ${days(deleteArchivedDays)} later, after its owners are warned again.`
      )
    }
  }
  if (purgeDeletedDays) {
    parts.push(
      `Deleted sites older than ${days(purgeDeletedDays)} are deleted for good from the next maintenance run, without notice.`
    )
  }
  parts.push(
    `It runs for every site on ${fling} that isn’t kept. This is recorded, with your email.`
  )
  return parts.join(' ')
}

/** What going back to dry run asks. */
export const dryRunConfirm =
  'Nothing more is warned, archived, deleted or purged until it is turned live again; what it did stays done. Warnings it sent no longer hold: going live again warns first. This is recorded, with your email.'

/** The switch's failure, inline beside it. */
export function switchError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'archive_policy_off') {
    return 'The archive policy is off on this Fling: an operator turns it on with ARCHIVE_INACTIVE_DAYS or PURGE_DELETED_DAYS.'
  }
  if (error instanceof ApiError && error.code === 'session_required') {
    return 'Turning the archive policy live or back to dry run needs your browser session: sign in here rather than with an API key.'
  }
  return errorMessage(error)
}

/** The audit log's name for its actor: the policy, or the person. */
export const auditActorLabel = (actor: string): string =>
  actor === ARCHIVE_POLICY_ACTOR ? 'The archive policy' : actor

/** The audit log's target: the switch's state in words, anything else as it is. */
export const auditTargetLabel = (e: { action: string; target: string }): string =>
  e.action === 'archive_policy.switch'
    ? e.target === 'live'
      ? 'live'
      : e.target === 'dry_run'
        ? 'dry run'
        : e.target
    : e.target

/** The site page's notice from `archiveDue`: when the policy will archive or delete it. */
export const archiveDueText = (due: SiteArchiveDue): string =>
  sentence(describeArchiveDue(due, dayDate))

/** The site page's notice for a site the policy archived; null for one an owner or admin did. */
export function policyArchivedText(
  site: Pick<Site, 'archived' | 'archivedBy' | 'archivedAt'>
): string | null {
  const text = describePolicyArchived(site, dayDate)
  return text ? sentence(text) : null
}

/** The danger zone's line beside the Keep switch. */
export const keepText = (keep: boolean): string =>
  keep
    ? sentence(KEPT_TEXT)
    : 'The archive policy archives sites nobody views or publishes for a while. Keep this one to exempt it.'
