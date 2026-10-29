/**
 * Invitations (store: `INVITE#<email>/INVITE` and the `INVITES` directory): how people outside the
 * email policy come in, while the instance has them on (`INVITES`, `config.invites`; off, every
 * route here is a 404 and an outside address in an audience or a group is refused).
 *
 * - By sharing: an audience or a group that adds an address the configuration doesn't admit
 *   (`checkAddresses`, used by sites.ts and groups.ts) invites it as a guest (`inviteGuests`),
 *   when the person sharing may (`account.invite`: not a guest, not an impersonating admin, who
 *   gets a 403 `impersonating`). Only an address newly added counts, so saving an audience again
 *   never invites anybody again. At most `INVITES_PER_DAY` new outside addresses a day per person
 *   (`NINVITE`), else 429 `too_many_invites` before anything changes. The first email they get is
 *   the share's own notification, which carries a sign-in link (notifications/drain.ts).
 * - By an admin (`/api/admin/invitations`): an invitation as a member, upgrading a guest (nothing
 *   ever demotes one), with an email sent at once carrying a 7-day sign-in link. Admins list the
 *   directory and revoke; revoking ends the access it gave on the next request (standing is
 *   rechecked on every one) and keeps the record. A later share may invite them again as a guest.
 *
 * Every invitation made or upgraded, and every revocation, is audited (audit.ts).
 */
import type { AdminInvitation, AdminInviteResult } from '@fling/shared'
import { audit } from './audit.ts'
import { INVITATION_LINK_TTL_SECONDS, mintSignInLink } from './auth/sign-in-link.ts'
import { admittedByConfig } from './auth/standing.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, forbidden, notFound } from './lib/errors.ts'
import { sendDirectMail } from './notifications/direct-mail.ts'
import { describeMailFailure } from './notifications/mail-admin.ts'
import { lifetimeInWords } from './notifications/templates/sign-in-link.ts'
import { canInstance, type Principal } from './policy.ts'
import { revokeSiteCookies } from './revocations.ts'
import { dayOf, type InvitationRecord, isLiveInvitation } from './store/types.ts'
import type { Deps } from './types.ts'

/** Who is naming addresses in an audience or a group, and whether they may invite by it. */
export interface Inviter {
  email: string
  /** `account.invite` */
  may: boolean
  /** an admin acting as `email`: refused with 403 `impersonating` rather than as an address */
  impersonating: boolean
}

/** The caller as an inviter, from the request's real principal (impersonation included). */
export function inviterOf(principal: Principal): Inviter {
  return {
    email: principal.email,
    may: canInstance(principal, 'account.invite'),
    impersonating: principal.impersonator !== undefined,
  }
}

const ADDRESS_RE = /^[^@\s]+@[^@\s]+$/

/**
 * Check the addresses an audience or a group is adding (`added`: only those it didn't name
 * before). Anything that isn't an address, or an outside one when invitations are off or `inviter`
 * is a guest, is a 400 `email_not_allowed` naming them. While impersonating, an outside address
 * without a live invitation is a 403 `impersonating` (an invitation outlives the session; someone
 * invited already may still be named). More new invitations than the inviter has left today is a
 * 429 `too_many_invites`. Returns the outside addresses, to pass to `inviteGuests` once the
 * audience or group is saved.
 */
export async function checkAddresses(
  deps: Deps,
  added: readonly string[],
  inviter: Inviter
): Promise<string[]> {
  const { config } = deps
  const invalid = added.filter(e => !ADDRESS_RE.test(e))
  const outside = added.filter(e => ADDRESS_RE.test(e) && !admittedByConfig(config, e))
  const inviting = config.invites && (inviter.may || inviter.impersonating)
  const refused = inviting ? invalid : [...invalid, ...outside]
  if (refused.length) {
    // The domains are public (the metadata names them); the listed addresses never are.
    const domains = config.allowedEmailDomains.map(d => `@${d}`).join(', ')
    const which = domains ? ` (it admits ${domains} addresses)` : ''
    throw new ApiError(
      400,
      'email_not_allowed',
      `Not an address that can sign in to ${config.instanceName}${which}: ${refused.join(', ')}`,
      { emails: refused }
    )
  }
  if (outside.length === 0) return outside
  const invitations = await Promise.all(outside.map(e => deps.store.getInvitation(e)))
  const fresh = outside.filter((_, i) => !isLiveInvitation(invitations[i] ?? null))
  if (fresh.length === 0) return outside
  if (!inviter.may) {
    throw forbidden(
      `Not while impersonating ${inviter.email}: inviting people from outside ${config.instanceName} (${fresh.join(', ')})`,
      'impersonating'
    )
  }
  const used = await deps.store.invitationsOn(inviter.email, dayOf(deps.clock.now()))
  if (used + fresh.length > config.invitesPerDay) {
    throw new ApiError(
      429,
      'too_many_invites',
      `You can invite ${config.invitesPerDay} people from outside ${config.instanceName} a day. Try again tomorrow, or ask an admin to invite them`,
      { limit: config.invitesPerDay }
    )
  }
  return outside
}

/**
 * Invite `emails` (outside addresses an audience or group just added, through `checkAddresses`)
 * as guests: a new invitation for each without a live one, counted against the inviter's day and
 * audited. A live invitation, guest or member, stays as it is.
 */
export async function inviteGuests(
  deps: Deps,
  inviter: Inviter,
  emails: readonly string[],
  from: { via: 'share'; siteId: string } | { via: 'group'; groupId: string }
) {
  if (!deps.config.invites || !inviter.may) return
  for (const email of emails) {
    const { changed } = await deps.store.putInvitation({
      email,
      role: 'guest',
      invitedBy: inviter.email,
      createdAt: deps.clock.now().toISOString(),
      ...from,
    })
    if (!changed) continue
    await deps.store.countInvitation(inviter.email, dayOf(deps.clock.now()))
    await audit(deps, {
      action: 'invitation.create',
      actor: inviter.email,
      target: email,
      via: from.via,
      role: 'guest',
    })
  }
}

// --- the admins' invitations ---

/** Invitations per page of the directory, by default and at most. */
export const INVITATIONS_PAGE = 50
export const INVITATIONS_PAGE_MAX = 100
/** Users read at once for the directory's "signed in" column. */
const USER_READS = 10

/** 404 unless the instance has invitations on. */
function ensureInvites(deps: Deps) {
  if (!deps.config.invites) throw notFound('Not found')
}

async function rowOf(deps: Deps, i: InvitationRecord): Promise<AdminInvitation> {
  const user = await deps.store.getUser(i.email)
  return {
    email: i.email,
    role: i.role,
    invitedBy: i.invitedBy,
    via: i.via,
    createdAt: i.createdAt,
    revokedAt: i.revokedAt ?? null,
    signedIn: user !== null,
    lastSignInAt: user?.lastSignInAt ?? null,
  }
}

/** The invitation directory, a page by address (optionally under the prefix `q`). */
export async function listInvitations(
  deps: Deps,
  opts: { q?: string; cursor?: string; limit?: number }
): Promise<{ invitations: AdminInvitation[]; cursor: string | null }> {
  ensureInvites(deps)
  const limit = Math.min(
    Math.max(1, Math.floor(opts.limit ?? INVITATIONS_PAGE)),
    INVITATIONS_PAGE_MAX
  )
  const page = await deps.store.listInvitations({
    prefix: opts.q?.trim().toLowerCase() || undefined,
    limit,
    cursor: opts.cursor || undefined,
  })
  const invitations = await mapLimit(page.invitations, USER_READS, i => rowOf(deps, i))
  return { invitations, cursor: page.cursor ?? null }
}

/**
 * Invite `email` as a member, as `admin`, and email them a sign-in link now. An address the
 * configuration admits already needs no invitation (400 `already_admitted`). Inviting someone who
 * holds a live member invitation sends the email again.
 */
export async function inviteMember(
  deps: Deps,
  admin: string,
  email: string
): Promise<AdminInviteResult> {
  ensureInvites(deps)
  if (!ADDRESS_RE.test(email)) throw badRequest('That is not an email address', 'invalid_email')
  if (admittedByConfig(deps.config, email)) {
    throw badRequest(
      `${email} can sign in to ${deps.config.instanceName} already`,
      'already_admitted'
    )
  }
  const { invitation, changed } = await deps.store.putInvitation({
    email,
    role: 'member',
    invitedBy: admin,
    via: 'admin',
    createdAt: deps.clock.now().toISOString(),
  })
  if (changed) {
    await audit(deps, {
      action: 'invitation.create',
      actor: admin,
      target: email,
      via: 'admin',
      role: 'member',
    })
  }
  const link = await mintSignInLink(deps, {
    email,
    return: '/',
    ttlSeconds: INVITATION_LINK_TTL_SECONDS,
  })
  const instance = deps.config.instanceName
  const { result } = await sendDirectMail(deps, {
    to: email,
    tag: 'invitation',
    section: {
      subject: `${admin} invited you to ${instance}`,
      lead: `${admin} invited you to ${instance}, where you can publish sites and review the ones people share with you.`,
      lines: [
        `The button signs you in as ${email}. It works once, within ${lifetimeInWords(INVITATION_LINK_TTL_SECONDS)}; afterwards, ask for a new link on the sign-in page ("Email me a sign-in link").`,
      ],
      action: { label: `Sign in to ${instance}`, url: link.url },
      why: `an admin of ${instance} invited this address`,
    },
  })
  return {
    invitation: await rowOf(deps, invitation),
    sent: result.ok,
    error: result.ok ? null : describeMailFailure(result),
  }
}

/** Revoke `email`'s invitation, as `admin` (404 when there is none). Already revoked: unchanged. */
export async function revokeInvitation(
  deps: Deps,
  admin: string,
  email: string
): Promise<AdminInvitation> {
  ensureInvites(deps)
  const at = deps.clock.now().toISOString()
  const existing = await deps.store.getInvitation(email)
  if (!existing) throw notFound(`No invitation for ${email}`)
  if (isLiveInvitation(existing)) {
    // On the record before the access ends.
    await audit(deps, { action: 'invitation.revoke', actor: admin, target: email })
  }
  const revoked = await deps.store.revokeInvitation(email, at)
  if (!revoked) throw notFound(`No invitation for ${email}`)
  // The API refuses them from now on; the revocation list stops their cookie at the edge too.
  if (isLiveInvitation(existing)) await revokeSiteCookies(deps, email, deps.clock.now())
  return rowOf(deps, revoked)
}

/** Invitations read at once for `guestsAmong`. */
const INVITATION_READS = 10

/**
 * Which of `emails` are guests by invitation (`isInvitedGuest`), for the guest badge where people
 * are listed (an audience, a group's members). Reads only addresses outside the configuration, and
 * nothing while invitations are off.
 */
export async function guestsAmong(deps: Deps, emails: readonly string[]): Promise<Set<string>> {
  if (!deps.config.invites) return new Set()
  const outside = emails.filter(e => !admittedByConfig(deps.config, e))
  const guests = await mapLimit(outside, INVITATION_READS, async e =>
    (await isInvitedGuest(deps, e)) ? e : null
  )
  return new Set(guests.filter((e): e is string => e !== null))
}

/** Whether `email` is a guest by invitation: outside the configuration, on a live guest invitation. */
export async function isInvitedGuest(deps: Deps, email: string): Promise<boolean> {
  if (!deps.config.invites || admittedByConfig(deps.config, email)) return false
  const invitation = await deps.store.getInvitation(email)
  return isLiveInvitation(invitation) && invitation.role === 'guest'
}
