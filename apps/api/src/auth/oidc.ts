/**
 * Generic OpenID Connect sign-in: the authorization code flow with PKCE, `state` and `nonce`. An
 * instance has up to two providers, each a client of one issuer, and offers every one configured:
 *
 * - `google`: a Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), the issuer
 *   https://accounts.google.com, on `/auth/google/callback`;
 * - `oidc`: any issuer (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, labelled
 *   `OIDC_DISPLAY_NAME`), on `/auth/callback`.
 *
 * Each has its own callback, so a response can only be taken by the provider it was sent to.
 * `OIDC_ISSUER=https://accounts.google.com` makes Google the `oidc` provider, and then the Google
 * client is not offered as well.
 *
 * - oauth4webapi does the protocol: discovery (`<issuer>/.well-known/openid-configuration`, cached
 *   for an hour), the authorization response, the token request and the ID token's claims (`iss`,
 *   `aud`, `azp`, `exp`/`iat` with CLOCK_TOLERANCE_S of skew, `nonce`).
 * - jose checks the ID token's signature (and that `iat` is not in the future) against the issuer's JWKS (cached; an unknown `kid`
 *   refetches it, so key rotation just works). The token came straight from the token endpoint
 *   over TLS, which OIDC deems enough, but a misrouted or spoofed endpoint shouldn't mint users.
 *
 * Both are Web Crypto + fetch only, so this runs unchanged on Node and on Workers.
 */
import { createRemoteJWKSet, customFetch, type JWTPayload, jwtVerify } from 'jose'
import * as oauth from 'oauth4webapi'
import type { Config } from '../config.ts'
import {
  type Identity,
  type IdentityProvider,
  SignInRefused,
  type SignInRequest,
} from './identity.ts'

export const GOOGLE_ISSUER = 'https://accounts.google.com'
/** The `oidc` provider's callback: `<appOrigin>/auth/callback`. */
export const CALLBACK_PATH = '/auth/callback'
/** The `google` provider's callback, the one Google OAuth clients for Fling allow. */
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback'
export const DEFAULT_SCOPES = ['openid', 'email', 'profile']
/** What the `oidc` button says when OIDC_DISPLAY_NAME is unset and the issuer is not a known one. */
export const DEFAULT_OIDC_DISPLAY_NAME = 'Single sign-on'
/** Seconds of clock skew allowed on `exp` / `iat` / `nbf`. */
export const CLOCK_TOLERANCE_S = 60
const MAX_ID_TOKEN_AGE_S = 60 * 60
const DISCOVERY_TTL_MS = 60 * 60 * 1000

export type SignInProviderId = 'google' | 'oidc'

/** Everything a provider needs, resolved from config and secrets. */
export interface OidcSettings {
  id: SignInProviderId
  issuer: string
  clientId: string
  clientSecret: string
  displayName: string
  scopes: string[]
  /** The path the issuer redirects back to; `redirectUri` is it on the app origin. */
  callbackPath: string
  redirectUri: string
  /** Extra authorization request parameters (e.g. Google's `prompt=select_account`). */
  authParams: Record<string, string>
  assumeEmailVerified: boolean
}

/** What a few well-known issuers are called, and what their sign-in page wants. */
function issuerDefaults(
  issuer: string,
  allowed: Pick<Config, 'allowedEmailDomains' | 'allowedEmails'>
) {
  const host = new URL(issuer).hostname
  if (issuer === GOOGLE_ISSUER) {
    const authParams: Record<string, string> = { prompt: 'select_account' }
    // A UI hint only: admitIdentity is what enforces the domain. Not with ALLOWED_EMAILS: Google
    // would then refuse a listed address on another domain (e.g. @gmail.com).
    const domains = allowed.allowedEmailDomains
    if (domains.length === 1 && allowed.allowedEmails.length === 0) {
      authParams.hd = domains[0] as string
    }
    return { displayName: 'Google', authParams }
  }
  if (host === 'login.microsoftonline.com') {
    return { displayName: 'Microsoft', authParams: { prompt: 'select_account' } }
  }
  if (/\.okta(preview)?\.com$/.test(host)) return { displayName: 'Okta', authParams: {} }
  if (/\.auth0\.com$/.test(host)) return { displayName: 'Auth0', authParams: {} }
  return { displayName: DEFAULT_OIDC_DISPLAY_NAME, authParams: {} }
}

/**
 * The instance's sign-in providers, `google` before `oidc`; none in dev without either (dev uses
 * dev-login), and production refuses to start with none. OIDC_DISPLAY_NAME, OIDC_SCOPES and
 * OIDC_ASSUME_EMAIL_VERIFIED belong to the `oidc` provider; the Google client always asks for
 * `openid email profile`, and Google always says whether an email is verified.
 */
export function signInProviders(config: Config): OidcSettings[] {
  const { oidc, secrets, appOrigin } = config
  const providers: OidcSettings[] = []
  const oidcIsGoogle = oidc.issuer === GOOGLE_ISSUER
  if (secrets.googleClientId && secrets.googleClientSecret && !oidcIsGoogle) {
    providers.push({
      id: 'google',
      issuer: GOOGLE_ISSUER,
      clientId: secrets.googleClientId,
      clientSecret: secrets.googleClientSecret,
      callbackPath: GOOGLE_CALLBACK_PATH,
      redirectUri: `${appOrigin}${GOOGLE_CALLBACK_PATH}`,
      scopes: DEFAULT_SCOPES,
      assumeEmailVerified: false,
      ...issuerDefaults(GOOGLE_ISSUER, config),
    })
  }
  if (oidc.issuer && oidc.clientId) {
    if (!secrets.oidcClientSecret) {
      throw new Error('OIDC_ISSUER is set but OIDC_CLIENT_SECRET (oidc-client-secret) is missing')
    }
    const defaults = issuerDefaults(oidc.issuer, config)
    providers.push({
      id: 'oidc',
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: secrets.oidcClientSecret,
      callbackPath: CALLBACK_PATH,
      redirectUri: `${appOrigin}${CALLBACK_PATH}`,
      displayName: oidc.displayName ?? defaults.displayName,
      scopes: oidc.scopes?.length ? oidc.scopes : DEFAULT_SCOPES,
      authParams: defaults.authParams,
      assumeEmailVerified: oidc.assumeEmailVerified,
    })
  }
  if (providers.length === 0 && config.appEnv === 'production') {
    throw new Error(
      'Sign-in is not configured: set OIDC_ISSUER, OIDC_CLIENT_ID and the secret, or the Google client'
    )
  }
  return providers
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
    id: settings.id,
    issuer: settings.issuer,
    displayName: settings.displayName,
    callbackPath: settings.callbackPath,
    assumeEmailVerified: settings.assumeEmailVerified,

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
      if (await refusedByIssuer(res))
        throw new SignInRefused(`${settings.issuer} refused the sign-in`)
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

/**
 * Whether the token endpoint turned the person away rather than the request: an issuer that runs
 * its own access check when it mints tokens fails the exchange. Cognito does so with a 400 naming
 * `UserLambdaValidationException` (its pre token generation trigger said no).
 */
async function refusedByIssuer(res: Response): Promise<boolean> {
  if (res.status !== 400) return false
  const body = await res
    .clone()
    .text()
    .catch(() => '')
  return body.includes('UserLambdaValidationException')
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

/** The instance's providers, ready to sign in with (none: dev-login only). */
export function identityProvidersFor(config: Config, opts?: OidcOptions): IdentityProvider[] {
  return signInProviders(config).map(settings => oidcProvider(settings, opts))
}
