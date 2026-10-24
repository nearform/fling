/**
 * Generic OpenID Connect sign-in, one issuer per instance (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
 * `OIDC_CLIENT_SECRET`): the authorization code flow with PKCE, `state` and `nonce`.
 *
 * - oauth4webapi does the protocol: discovery (`<issuer>/.well-known/openid-configuration`, cached
 *   for an hour), the authorization response, the token request and the ID token's claims (`iss`,
 *   `aud`, `azp`, `exp`/`iat` with CLOCK_TOLERANCE_S of skew, `nonce`).
 * - jose checks the ID token's signature (and that `iat` is not in the future) against the issuer's JWKS (cached; an unknown `kid`
 *   refetches it, so key rotation just works). The token came straight from the token endpoint
 *   over TLS, which OIDC deems enough, but a misrouted or spoofed endpoint shouldn't mint users.
 *
 * Both are Web Crypto + fetch only, so this runs unchanged on Node and on Workers.
 *
 * An instance still configured the pre-OIDC way (Google client id/secret, no OIDC_ISSUER) maps to
 * the issuer https://accounts.google.com with its old callback path (see `oidcSettings`).
 */
import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'
import type { Config } from '../config.ts'
import type { Identity, IdentityProvider, SignInRequest } from './identity.ts'

export const GOOGLE_ISSUER = 'https://accounts.google.com'
/** The callback the IdP redirects to: `<appOrigin>/auth/callback`. */
export const CALLBACK_PATH = '/auth/callback'
/** The pre-OIDC Google callback, still registered on existing Google clients. */
export const LEGACY_GOOGLE_CALLBACK_PATH = '/auth/google/callback'
export const DEFAULT_SCOPES = ['openid', 'email', 'profile']
/** Seconds of clock skew allowed on `exp` / `iat` / `nbf`. */
export const CLOCK_TOLERANCE_S = 60
const MAX_ID_TOKEN_AGE_S = 60 * 60
const DISCOVERY_TTL_MS = 60 * 60 * 1000

/** Everything the provider needs, resolved from config and secrets. */
export interface OidcSettings {
  issuer: string
  clientId: string
  clientSecret: string
  displayName: string
  scopes: string[]
  redirectUri: string
  /** Extra authorization request parameters (e.g. Google's `prompt=select_account`). */
  authParams: Record<string, string>
  /** Configured the pre-OIDC way (Google secrets, no OIDC_ISSUER). */
  legacy: boolean
}

/** What a few well-known issuers are called, and what their sign-in page wants. */
function issuerDefaults(issuer: string, allowedDomains: string[]) {
  const host = new URL(issuer).hostname
  if (issuer === GOOGLE_ISSUER) {
    const authParams: Record<string, string> = { prompt: 'select_account' }
    // A UI hint only: admitIdentity is what enforces the domain.
    if (allowedDomains.length === 1) authParams.hd = allowedDomains[0] as string
    return { displayName: 'Google', authParams }
  }
  if (host === 'login.microsoftonline.com') {
    return { displayName: 'Microsoft', authParams: { prompt: 'select_account' } }
  }
  if (/\.okta(preview)?\.com$/.test(host)) return { displayName: 'Okta', authParams: {} }
  if (/\.auth0\.com$/.test(host)) return { displayName: 'Auth0', authParams: {} }
  return { displayName: host, authParams: {} }
}

/**
 * The instance's identity provider settings, or null when none is configured (dev uses
 * dev-login; production refuses to start). OIDC_* wins; otherwise the deprecated Google secrets
 * map to https://accounts.google.com on the callback their OAuth client already allows.
 */
export function oidcSettings(config: Config): OidcSettings | null {
  const { oidc, secrets, appOrigin, allowedEmailDomains } = config
  let base: Pick<OidcSettings, 'issuer' | 'clientId' | 'clientSecret' | 'redirectUri' | 'legacy'>
  if (oidc.issuer && oidc.clientId) {
    if (!secrets.oidcClientSecret) {
      throw new Error('OIDC_ISSUER is set but OIDC_CLIENT_SECRET (oidc-client-secret) is missing')
    }
    base = {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: secrets.oidcClientSecret,
      redirectUri: `${appOrigin}${CALLBACK_PATH}`,
      legacy: false,
    }
  } else if (secrets.googleClientId && secrets.googleClientSecret) {
    base = {
      issuer: GOOGLE_ISSUER,
      clientId: secrets.googleClientId,
      clientSecret: secrets.googleClientSecret,
      redirectUri: `${appOrigin}${LEGACY_GOOGLE_CALLBACK_PATH}`,
      legacy: true,
    }
  } else {
    if (config.appEnv === 'production') {
      throw new Error('Sign-in is not configured: set OIDC_ISSUER, OIDC_CLIENT_ID and the secret')
    }
    return null
  }
  const defaults = issuerDefaults(base.issuer, allowedEmailDomains)
  return {
    ...base,
    displayName: oidc.displayName ?? defaults.displayName,
    scopes: oidc.scopes?.length ? oidc.scopes : DEFAULT_SCOPES,
    authParams: defaults.authParams,
  }
}

export interface OidcOptions {
  /** Outbound fetch (tests point it at an in-process IdP). */
  fetch?: typeof fetch
  /** Minimum time between JWKS refetches for an unknown `kid` (jose's default: 30 s). */
  jwksCooldownMs?: number
}

interface Discovered {
  as: oauth.AuthorizationServer
  jwks: ReturnType<typeof createRemoteJWKSet>
}

export function oidcProvider(settings: OidcSettings, opts: OidcOptions = {}): IdentityProvider {
  const doFetch = opts.fetch ?? fetch
  const issuer = new URL(settings.issuer)
  const http = {
    [oauth.customFetch]: (url: string, init: RequestInit) => doFetch(url, init),
    // Only a dev/test issuer can be http (config requires https in production).
    [oauth.allowInsecureRequests]: issuer.protocol === 'http:',
  }
  const client: oauth.Client = {
    client_id: settings.clientId,
    [oauth.clockTolerance]: CLOCK_TOLERANCE_S,
  }
  let cached: { at: number; value: Promise<Discovered> } | undefined

  async function discover(): Promise<Discovered> {
    const res = await oauth.discoveryRequest(issuer, { algorithm: 'oidc', ...http })
    const as = await oauth.processDiscoveryResponse(issuer, res)
    if (!as.authorization_endpoint || !as.token_endpoint || !as.jwks_uri) {
      throw new Error(`${settings.issuer} discovery lacks an authorization, token or JWKS endpoint`)
    }
    const jwks = createRemoteJWKSet(new URL(as.jwks_uri), {
      [customFetch]: (url, init) => doFetch(url, init as RequestInit),
      ...(opts.jwksCooldownMs !== undefined && { cooldownDuration: opts.jwksCooldownMs }),
    })
    return { as, jwks }
  }

  /** Discovery, cached for DISCOVERY_TTL_MS; a failure is retried on the next sign-in. */
  function server(): Promise<Discovered> {
    if (!cached || Date.now() - cached.at > DISCOVERY_TTL_MS) {
      const value = discover()
      cached = { at: Date.now(), value }
      value.catch(() => {
        if (cached?.value === value) cached = undefined
      })
    }
    return cached.value
  }

  /**
   * client_secret_post whenever the issuer offers it, else client_secret_basic (the spec's default
   * when discovery lists none). Basic credentials are form-encoded first (RFC 6749 §2.3.1), so
   * `-` and `.` travel as `%2D`/`%2E`, and Google doesn't decode them: it answers invalid_client,
   * "The OAuth client was not found", for every `….apps.googleusercontent.com` client id.
   */
  function clientAuth(as: oauth.AuthorizationServer): oauth.ClientAuth {
    return as.token_endpoint_auth_methods_supported?.includes('client_secret_post')
      ? oauth.ClientSecretPost(settings.clientSecret)
      : oauth.ClientSecretBasic(settings.clientSecret)
  }

  return {
    issuer: settings.issuer,
    displayName: settings.displayName,

    async authorizationUrl(request: SignInRequest) {
      const { as } = await server()
      const url = new URL(as.authorization_endpoint as string)
      const params = {
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri,
        response_type: 'code',
        scope: settings.scopes.join(' '),
        state: request.state,
        nonce: request.nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(request.codeVerifier),
        code_challenge_method: 'S256',
        ...settings.authParams,
      }
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      return url
    },

    async exchange(callback: URLSearchParams, request: SignInRequest) {
      const { as, jwks } = await server()
      const params = oauth.validateAuthResponse(as, client, callback, request.state)
      const res = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        clientAuth(as),
        params,
        settings.redirectUri,
        request.codeVerifier,
        http
      )
      const tokens = await oauth.processAuthorizationCodeResponse(as, client, res, {
        expectedNonce: request.nonce,
        requireIdToken: true,
      })
      const { payload } = await jwtVerify(tokens.id_token as string, jwks, {
        issuer: as.issuer,
        audience: settings.clientId,
        clockTolerance: CLOCK_TOLERANCE_S,
        // ID tokens are minted for this exchange; this also refuses an `iat` in the future.
        maxTokenAge: MAX_ID_TOKEN_AGE_S,
      })
      return identityOf(payload)
    },
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** Some issuers send `email_verified` as a string. */
function verifiedOf(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}

function identityOf(claims: JWTPayload): Identity {
  if (!claims.sub) throw new Error('ID token has no sub')
  return {
    subject: claims.sub,
    email: str(claims.email),
    emailVerified: verifiedOf(claims.email_verified),
    name: str(claims.name),
    picture: str(claims.picture),
    hd: str(claims.hd),
  }
}

/** The configured provider (null: none, dev-login only); warns once about legacy config. */
export function identityProviderFor(config: Config, opts?: OidcOptions): IdentityProvider | null {
  const settings = oidcSettings(config)
  if (!settings) return null
  if (settings.legacy) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg:
          'deprecated sign-in config: google-client-id/secret without OIDC_ISSUER is read as ' +
          `OIDC_ISSUER=${GOOGLE_ISSUER} on ${LEGACY_GOOGLE_CALLBACK_PATH}; see platforms/aws/DEPLOY.md`,
      })
    )
  }
  return oidcProvider(settings, opts)
}
