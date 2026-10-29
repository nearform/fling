/**
 * The instance's admins (ADMIN_EMAILS): the users list, every site's listing (the site
 * directory; policy still decides what an admin may open), the audit log, the mail page
 * (notifications/mail-admin.ts), the settings (configuration, secrets by name only), and
 * impersonation. Policy
 * (`canInstance`, `impersonationRefusal` in policy.ts) decides; this does it and keeps the record.
 * To anyone who isn't an admin, none of it exists (404).
 *
 * Impersonation is a browser session of the admin's that acts as someone else (auth/session.ts
 * for the claims, auth/middleware.ts for when they are honoured). It starts and stops here, and
 * every start and stop is audited twice: a structured log line and an AUDIT record (kept
 * AUDIT_TTL_DAYS). The record is written before the session changes, so an impersonation that
 * isn't on the record never happens.
 */
import {
  type AdminSettings,
  type AdminSite,
  type AdminUser,
  type AuditEntry,
  type MailAdmin,
  type MailTestResult,
  type Me,
  siteLabel,
  siteUrl,
} from '@fling/shared'
import { isAdminEmail, secretSettings } from './config.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, forbidden, notFound } from './lib/errors.ts'
import { newSortableId } from './lib/ids.ts'
import { mailOverview, sendTestMail } from './notifications/mail-admin.ts'
import {
  canInstance,
  type ImpersonationRefusal,
  type InstanceAction,
  impersonationRefusal,
  type Principal,
} from './policy.ts'
import type { AuditRecord, User } from './store/types.ts'
import type { Deps } from './types.ts'

export const AUDIT_TTL_DAYS = 180
/** Users per page of the list, by default and at most. */
export const USERS_PAGE = 50
export const USERS_PAGE_MAX = 100
/**
 * The most sites the admins' list returns, so the response stays well under Lambda's 6 MB: a
 * typical row is about 270 bytes of JSON (370 with a 63-character name), so 10,000 rows are about
 * 2.7 MB (3.7 MB at worst).
 */
export const ADMIN_SITES_MAX = 10_000
/** Audit entries the admin page shows. */
export const AUDIT_PAGE = 50
/** Site counts looked up at once (one query each). */
const COUNT_CONCURRENCY = 10

/** What /api/me says about the caller. */
export function meOf(
  deps: Pick<Deps, 'config'>,
  user: User,
  impersonation?: { by: string; until: Date }
): Me {
  return {
    email: user.email,
    name: user.name,
    picture: user.picture,
    userSlug: user.userSlug,
    admin: isAdminEmail(deps.config, user.email),
    ...(impersonation && {
      impersonator: impersonation.by,
      impersonationEndsAt: impersonation.until.toISOString(),
    }),
  }
}

/** What an admin may do only from their browser session, as a refusal names it. */
const SESSION_ONLY: Partial<Record<InstanceAction, string>> = {
  'admin.impersonate': 'Impersonation',
  'admin.mail.test': 'Sending a test email',
}

/** Non-admins see nothing here: the admin routes are 404s to them (an impersonator is told). */
export function ensure(p: Principal, action: InstanceAction) {
  if (canInstance(p, action)) return
  if (p.impersonator) {
    throw forbidden(`Stop impersonating ${p.email} first`, 'impersonating')
  }
  if (p.admin && action in SESSION_ONLY) {
    throw forbidden(`${SESSION_ONLY[action]} needs your browser session`, 'session_required')
  }
  throw notFound('Not found')
}

export async function listUsers(
  deps: Deps,
  p: Principal,
  opts: { q?: string; cursor?: string; limit?: number }
): Promise<{ users: AdminUser[]; cursor: string | null }> {
  ensure(p, 'admin.users.list')
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? USERS_PAGE)), USERS_PAGE_MAX)
  const page = await deps.store.listUsers({
    prefix: opts.q?.trim().toLowerCase() || undefined,
    limit,
    cursor: opts.cursor || undefined,
  })
  // Site counts: one key query per user on the page (a user's index items), never a scan.
  const users = await mapLimit(page.users, COUNT_CONCURRENCY, async u => ({
    ...u,
    siteCount: (await deps.store.listSites(u.email)).length,
    admin: isAdminEmail(deps.config, u.email),
  }))
  return { users, cursor: page.cursor ?? null }
}

/**
 * Every site's listing, by name, in one response (clients search and sort it): nothing that would
 * let an admin open it. At most `max` sites; `truncated` when there were more.
 */
export async function listSites(
  deps: Deps,
  p: Principal,
  max = ADMIN_SITES_MAX
): Promise<{ sites: AdminSite[]; truncated: boolean }> {
  ensure(p, 'admin.sites.list')
  const { sites, truncated } = await deps.store.listAllSites({ max })
  const { sitesDomain, siteScheme } = deps.config
  return {
    sites: sites.map(s => ({
      name: s.name,
      url: siteUrl(siteLabel(s.name), sitesDomain, `${siteScheme}:`),
      owner: s.owner,
      access: s.access,
      archived: s.archived,
      live: s.live,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    truncated,
  }
}

export async function auditLog(deps: Deps, p: Principal): Promise<AuditEntry[]> {
  ensure(p, 'admin.audit.read')
  const entries = await deps.store.listAuditEntries(AUDIT_PAGE)
  return entries.map(({ expiresAt: _expiresAt, ...entry }) => entry)
}

/** The mail settings and the last 24 hours of sending (404 without email). */
export function mail(deps: Deps, p: Principal): Promise<MailAdmin> {
  ensure(p, 'admin.mail.read')
  return mailOverview(deps, p.email)
}

/**
 * The instance's configuration as it runs: every env key's effective value, set or defaulted,
 * and the secrets by name, set or not. Never a secret's value.
 */
export function settings(deps: Deps, p: Principal): AdminSettings {
  ensure(p, 'admin.settings.read')
  return {
    settings: deps.config.settings,
    secrets: secretSettings(deps.config.secrets),
  }
}

/** Send a test email to `to`, any address (at most MAIL_TESTS_PER_HOUR an hour per admin). */
export function mailTest(deps: Deps, p: Principal, to: string): Promise<MailTestResult> {
  ensure(p, 'admin.mail.test')
  return sendTestMail(deps, p.email, to)
}

/** Write the record and the log line; throws (and nothing else happens) if the record fails. */
async function audit(deps: Deps, entry: Omit<AuditRecord, 'id' | 'at' | 'expiresAt'>) {
  const now = deps.clock.now()
  const record: AuditRecord = {
    id: newSortableId(now),
    at: now.toISOString(),
    ...entry,
    expiresAt: new Date(now.getTime() + AUDIT_TTL_DAYS * 86_400_000).toISOString(),
  }
  await deps.store.addAuditEntry(record)
  console.info(
    JSON.stringify({
      level: 'info',
      msg: 'audit',
      action: record.action,
      actor: record.actor,
      target: record.target,
      ...(record.until && { until: record.until }),
      ...(record.lapsed && { lapsed: true }),
    })
  )
}

const REFUSALS: Record<ImpersonationRefusal, () => ApiError> = {
  no_such_user: () => notFound('No such user'),
  self: () => new ApiError(400, 'impersonate_self', 'You cannot impersonate yourself'),
  admin: () => forbidden('Admins cannot be impersonated', 'impersonate_admin'),
}

/**
 * An admin starts acting as `email` until `until`; returns the target. The caller re-issues the
 * session (routes/admin.ts).
 */
export async function startImpersonation(
  deps: Deps,
  p: Principal,
  email: string,
  until: Date
): Promise<User> {
  ensure(p, 'admin.impersonate')
  const target = await deps.store.getUser(email)
  const refusal = impersonationRefusal(
    p,
    target && { email: target.email, admin: isAdminEmail(deps.config, target.email) }
  )
  if (refusal || !target) throw REFUSALS[refusal ?? 'no_such_user']()
  await audit(deps, {
    action: 'impersonation.start',
    actor: p.email,
    target: target.email,
    until: until.toISOString(),
  })
  return target
}

/** The end of an impersonation (asked for, or found lapsed when stopping). */
export async function stopImpersonation(
  deps: Deps,
  admin: string,
  target: string,
  lapsed: boolean
) {
  await audit(deps, {
    action: 'impersonation.stop',
    actor: admin,
    target,
    ...(lapsed && { lapsed: true }),
  })
}
