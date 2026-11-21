/**
 * Who may call the Node host's tick and migrate endpoints on Google Cloud: a caller with a
 * Google-signed ID token (OIDC) for this instance, issued to one of the instance's service
 * accounts. Cloud Scheduler sends one with every tick (its job's `oidc_token`, as the scheduler's
 * service account), and the deploy workflow mints one as the deploy service account to run the
 * data migrations. Nothing else gets past: a token for another audience, from another account,
 * with an unverified email, expired or not signed by Google is refused, and the endpoint then
 * answers 404 as if it were not there.
 *
 * The check is google-auth-library's `verifyIdToken` (Google's published keys, the issuer, the
 * expiry and the audience), plus the token's `email`.
 */
import type { TickAuthorizer } from '@fling/platform-node/host'
import { OAuth2Client } from 'google-auth-library'

export interface GoogleIdTokenTicksOptions {
  /** the audience the callers ask their token for: the app origin */
  audience: string
  /** the service accounts that may call (the scheduler's and the deploy's) */
  serviceAccounts: string[]
  /** the client that fetches Google's keys and verifies (tests pass one with their own keys) */
  client?: OAuth2Client
}

export function googleIdTokenTicks(opts: GoogleIdTokenTicksOptions): TickAuthorizer {
  const client = opts.client ?? new OAuth2Client()
  const allowed = new Set(opts.serviceAccounts.map(e => e.trim().toLowerCase()).filter(Boolean))
  if (allowed.size === 0) throw new Error('googleIdTokenTicks needs at least one service account')
  return async request => {
    const header = request.headers.get('authorization') ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match) return false
    try {
      const ticket = await client.verifyIdToken({
        idToken: match[1] as string,
        audience: opts.audience,
      })
      const payload = ticket.getPayload()
      return (
        payload?.email_verified === true &&
        typeof payload.email === 'string' &&
        allowed.has(payload.email.toLowerCase())
      )
    } catch {
      return false
    }
  }
}
