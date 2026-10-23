/**
 * Google sign-in (from rocketpod's provider): arctic `Google` with PKCE. Claims come from the ID
 * token returned by Google's token endpoint over TLS (no signature check needed for a token we
 * fetched ourselves), which carries `email_verified` and `hd`.
 */
import { decodeIdToken, Google } from 'arctic'
import type { Config } from '../config.ts'
import type { GoogleClaims, OAuthClient } from '../types.ts'

export const googleRedirectUri = (cfg: Pick<Config, 'appOrigin'>) =>
  `${cfg.appOrigin}/auth/google/callback`

export function googleClient(cfg: Config): OAuthClient {
  const google = new Google(
    cfg.secrets.googleClientId,
    cfg.secrets.googleClientSecret,
    googleRedirectUri(cfg)
  )
  return {
    authorizationUrl(state, verifier) {
      const url = google.createAuthorizationURL(state, verifier, ['openid', 'email', 'profile'])
      // UI hint only — admitGoogleClaims is what enforces the domain.
      const hd = cfg.allowedEmailDomains[0]
      if (hd && cfg.allowedEmailDomains.length === 1) url.searchParams.set('hd', hd)
      url.searchParams.set('prompt', 'select_account')
      return url
    },
    async exchange(code, verifier) {
      const tokens = await google.validateAuthorizationCode(code, verifier)
      return decodeIdToken(tokens.idToken()) as GoogleClaims
    },
  }
}

export type Admission =
  | { ok: true; email: string; name: string; picture: string | null }
  | { ok: false; reason: 'email_unverified' | 'domain_not_allowed' }

/**
 * Who may sign in: a verified email whose domain is in ALLOWED_EMAIL_DOMAINS, and whose `hd`
 * (Workspace domain) claim, when present, is also allowed and matches the email's domain.
 */
export function admitGoogleClaims(claims: GoogleClaims, allowedDomains: string[]): Admission {
  const email = claims.email?.trim().toLowerCase()
  if (!email || claims.email_verified !== true) return { ok: false, reason: 'email_unverified' }
  const at = email.lastIndexOf('@')
  const domain = at > 0 ? email.slice(at + 1) : ''
  const allowed = allowedDomains.map(d => d.toLowerCase())
  if (!domain || !allowed.includes(domain)) return { ok: false, reason: 'domain_not_allowed' }
  if (claims.hd !== undefined && claims.hd.toLowerCase() !== domain) {
    return { ok: false, reason: 'domain_not_allowed' }
  }
  return {
    ok: true,
    email,
    name: claims.name?.trim() || email.slice(0, at),
    picture: claims.picture ?? null,
  }
}
