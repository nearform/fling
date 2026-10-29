/**
 * Who someone is (the `IdentityProvider` seam: one per instance, generic OIDC in oidc.ts) and who
 * may sign in (`admitIdentity`, the email policy). The provider proves an identity; the policy,
 * kept apart from it, decides whether that identity gets in.
 */

import type { Standing } from './standing.ts'

/** What one sign-in needs remembered between the redirect out and the callback. */
export interface SignInRequest {
  state: string
  nonce: string
  /** PKCE */
  codeVerifier: string
}

/** A verified identity: claims of an ID token whose signature, issuer, audience and nonce held. */
export interface Identity {
  /** The issuer's stable id for the account (`sub`). */
  subject: string
  email?: string
  /** `email_verified`; undefined when the issuer didn't say. */
  emailVerified?: boolean
  name?: string
  picture?: string
  /** Google's Workspace domain claim, when present. */
  hd?: string
}

export interface IdentityProvider {
  readonly issuer: string
  /** "Sign in with <displayName>". */
  readonly displayName: string
  /** Where to send the browser to sign in. */
  authorizationUrl(request: SignInRequest): Promise<URL>
  /** The callback's query (code, state, …) → the verified identity; throws on any failure. */
  exchange(callback: URLSearchParams, request: SignInRequest): Promise<Identity>
}

export type Admission =
  | { ok: true; email: string; name: string; picture: string | null }
  | { ok: false; reason: 'email_unverified' | 'domain_not_allowed' }

export interface EmailPolicy {
  /** ALLOWED_EMAIL_DOMAINS */
  allowedDomains: string[]
  /** ALLOWED_EMAILS: individual addresses, admitted whatever their domain. */
  allowedEmails?: string[]
  /** OIDC_ASSUME_EMAIL_VERIFIED: a missing `email_verified` counts as verified. */
  assumeEmailVerified?: boolean
}

/**
 * Who may sign in: a verified email that is listed in ALLOWED_EMAILS or whose domain is in
 * ALLOWED_EMAIL_DOMAINS, and whose `hd` (Google Workspace domain) claim, when present, matches the
 * email's domain. An issuer that says nothing about verification is refused unless the instance
 * opts in to trusting it. With `standing` (auth/standing.ts, which starts from the same lists and
 * adds admins and invitations), it decides in place of the lists: anything but `none` gets in.
 */
export function admitIdentity(
  identity: Identity,
  policy: EmailPolicy,
  standing?: Standing
): Admission {
  const email = identity.email?.trim().toLowerCase()
  const verified =
    identity.emailVerified ?? (policy.assumeEmailVerified === true ? true : undefined)
  if (!email || verified !== true) return { ok: false, reason: 'email_unverified' }
  const at = email.lastIndexOf('@')
  const domain = at > 0 ? email.slice(at + 1) : ''
  const allowed = standing === undefined ? emailAllowed(email, policy) : standing !== 'none'
  if (!allowed) return { ok: false, reason: 'domain_not_allowed' }
  if (identity.hd !== undefined && identity.hd.toLowerCase() !== domain) {
    return { ok: false, reason: 'domain_not_allowed' }
  }
  return {
    ok: true,
    email,
    name: identity.name?.trim() || email.slice(0, at),
    picture: identity.picture ?? null,
  }
}

/** Whether the allowlists name this (lowercase) address or its domain; verification aside. */
export function emailAllowed(
  email: string,
  policy: Pick<EmailPolicy, 'allowedDomains' | 'allowedEmails'>
): boolean {
  const at = email.lastIndexOf('@')
  const domain = at > 0 ? email.slice(at + 1) : ''
  if (!domain) return false
  const listed = (policy.allowedEmails ?? []).some(e => e.toLowerCase() === email)
  return listed || policy.allowedDomains.map(d => d.toLowerCase()).includes(domain)
}
