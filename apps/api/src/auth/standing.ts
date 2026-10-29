/**
 * Standing: whether someone may be signed in at all, and as what. The one admission answer for
 * every sign-in (OIDC, dev login) and every request (session, API key, OAuth and MCP tokens), so
 * removing a domain or revoking an invitation cuts access on the next request.
 *
 * - `member`: the email policy admits the address (`emailAllowed`, identity.ts), it is in
 *   ADMIN_EMAILS, or it holds a live member invitation.
 * - `guest`: it holds a live guest invitation and some audience still names it (a direct grant or
 *   a group membership). A guest no audience names lapses, and the next share brings them back;
 *   the invitation stays as the record.
 * - `none`: anything else. Signing in is refused and a credential gets a 401.
 *
 * An address the policy admits costs no store read; anyone else one (the invitation), and a guest
 * two more (one item each).
 */
import { type Config, isAdminEmail } from '../config.ts'
import { type InvitationRecord, isLiveInvitation, type Store } from '../store/types.ts'
import { emailAllowed } from './identity.ts'

export type Standing = 'member' | 'guest' | 'none'

/** Whether the instance's configuration alone admits the (lowercase) address: policy or admin. */
export function admittedByConfig(
  config: Pick<Config, 'allowedEmailDomains' | 'allowedEmails' | 'adminEmails'>,
  email: string
): boolean {
  return (
    isAdminEmail(config, email) ||
    emailAllowed(email, {
      allowedDomains: config.allowedEmailDomains,
      allowedEmails: config.allowedEmails,
    })
  )
}

/**
 * The standing an invitation gives, when the configuration doesn't admit the address: pure, so
 * the whole table is testable. `named`: whether any audience names the address (asked only for a
 * live guest invitation).
 */
export function standingFrom(invitation: InvitationRecord | null, named: boolean): Standing {
  if (!isLiveInvitation(invitation)) return 'none'
  if (invitation.role === 'member') return 'member'
  return named ? 'guest' : 'none'
}

/** The standing of a (lowercase) address now. */
export async function standingOf(
  deps: {
    config: Pick<Config, 'allowedEmailDomains' | 'allowedEmails' | 'adminEmails'>
    store: Pick<Store, 'getInvitation' | 'isNamedAnywhere'>
  },
  email: string
): Promise<Standing> {
  if (admittedByConfig(deps.config, email)) return 'member'
  const invitation = await deps.store.getInvitation(email)
  const guest = isLiveInvitation(invitation) && invitation.role === 'guest'
  return standingFrom(invitation, guest && (await deps.store.isNamedAnywhere(email)))
}

/**
 * The request's user as policy sees them: a guest carries `guest: true`. null when they have no
 * standing (the caller answers 401).
 */
export async function withStanding<U extends { email: string }>(
  deps: Parameters<typeof standingOf>[0],
  user: U
): Promise<(U & { guest?: true }) | null> {
  const standing = await standingOf(deps, user.email)
  if (standing === 'none') return null
  if (standing === 'guest') return { ...user, guest: true as const }
  const { guest: _guest, ...rest } = user as U & { guest?: true }
  return rest as U
}
