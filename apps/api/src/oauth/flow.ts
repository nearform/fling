/**
 * The OAuth 2.1 authorization-code flow (with PKCE S256 and RFC 8707 resource indicators):
 * authorize → consent (SPA, /authorize?request=<id>) → code → token, refresh with rotation and
 * reuse detection, revocation. Grants are the user's "connections" (Connections page).
 */
import { standingOf } from '../auth/standing.ts'
import { newId } from '../lib/ids.ts'
import type { GrantRecord, OAuthRequestRecord, RefreshTokenRecord, User } from '../store/types.ts'
import type { Deps } from '../types.ts'
import {
  clientRedirectOk,
  isLoopbackUrl,
  type ResolvedClient,
  resolveClient,
  touchClient,
} from './clients.ts'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  AUTH_REQUEST_TTL_SECONDS,
  hashToken,
  mcpResource,
  REFRESH_TOKEN_TTL_SECONDS,
  randomToken,
  SCOPE,
  signAccessToken,
  verifyAccessToken,
  verifyPkce,
} from './tokens.ts'

/** RFC 6749 §5.2 / RFC 7009 error, rendered by the token route. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 = 400
  ) {
    super(description)
  }
}

/** Resource indicators: ours, compared leniently on scheme/host case and a trailing slash. */
export function isOurResource(deps: Deps, resource: string) {
  const ours = mcpResource(deps.config)
  try {
    const url = new URL(resource)
    if (url.hash) return false
    const normal = `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`
    return normal === ours
  } catch {
    return false
  }
}

// --- authorize ----------------------------------------------------------------------------------

export type AuthorizeOutcome =
  /** can't trust the redirect URI: show the error on our own page */
  | { kind: 'error_page'; error: string; description: string }
  /** report to the client via its redirect URI */
  | { kind: 'redirect'; url: string }
  /** valid: needs sign-in / consent */
  | { kind: 'ok'; client: ResolvedClient; params: ValidAuthorize }

export interface ValidAuthorize {
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  scope: string
}

export function clientRedirect(
  deps: Deps,
  redirectUri: string,
  params: Record<string, string | null | undefined>
) {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
  // RFC 9207: tell the client which AS answered (mix-up defence).
  url.searchParams.set('iss', deps.config.appOrigin)
  return url.toString()
}

export async function validateAuthorize(
  deps: Deps,
  q: Record<string, string | undefined>
): Promise<AuthorizeOutcome> {
  const clientId = q.client_id
  const client = clientId ? await resolveClient(deps, clientId) : null
  if (!client) {
    return {
      kind: 'error_page',
      error: 'invalid_client',
      description: 'Unknown client. Remove the connector and add it again.',
    }
  }
  const redirectUri = q.redirect_uri
  if (!redirectUri || !clientRedirectOk(deps.config, client, redirectUri)) {
    return {
      kind: 'error_page',
      error: 'invalid_redirect_uri',
      description: 'This app asked to send you to an address Fling does not allow.',
    }
  }
  const state = q.state ?? null
  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: 'redirect',
    url: clientRedirect(deps, redirectUri, {
      error,
      error_description: description,
      state: state?.slice(0, 2048),
    }),
  })
  if (state !== null && state.length > 2048) return fail('invalid_request', 'state is too long')
  if (q.response_type !== 'code') {
    return fail('unsupported_response_type', 'Only response_type=code is supported')
  }
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return fail(
      'invalid_request',
      'PKCE is required: code_challenge with code_challenge_method=S256'
    )
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
    return fail('invalid_request', 'code_challenge must be a base64url SHA-256 (43 chars)')
  }
  if (q.resource !== undefined && !isOurResource(deps, q.resource)) {
    return fail('invalid_target', `resource must be ${mcpResource(deps.config)}`)
  }
  return {
    kind: 'ok',
    client,
    params: {
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: q.code_challenge,
      resource: mcpResource(deps.config),
      // One scope covers everything; other requested scopes are not granted.
      scope: SCOPE,
    },
  }
}

export async function createAuthRequest(
  deps: Deps,
  user: User,
  client: ResolvedClient,
  params: ValidAuthorize
) {
  const now = deps.clock.now()
  const req: OAuthRequestRecord = {
    id: randomToken(18),
    email: user.email,
    clientId: client.clientId,
    clientName: client.clientName,
    clientUri: client.clientUri,
    clientIdHost: client.clientIdHost,
    redirectUri: params.redirectUri,
    state: params.state,
    codeChallenge: params.codeChallenge,
    resource: params.resource,
    scope: params.scope,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AUTH_REQUEST_TTL_SECONDS * 1000).toISOString(),
  }
  await deps.store.putOAuthRequest(req)
  return req
}

// --- consent (SPA) ------------------------------------------------------------------------------

async function liveRequest(deps: Deps, user: User, id: string) {
  const req = /^[A-Za-z0-9_-]{10,64}$/.test(id) ? await deps.store.getOAuthRequest(id) : null
  if (!req || req.email !== user.email || Date.parse(req.expiresAt) <= deps.clock.now().getTime()) {
    return null
  }
  return req
}

export async function requestInfo(deps: Deps, user: User, id: string) {
  const req = await liveRequest(deps, user, id)
  if (!req) return null
  const redirect = new URL(req.redirectUri)
  return {
    clientName: req.clientName,
    clientUri: req.clientUri,
    clientIdHost: req.clientIdHost,
    redirectHost: redirect.host,
    loopback: isLoopbackUrl(redirect),
    scopes: req.scope.split(' '),
    email: user.email,
  }
}

const clientHostOf = (req: { clientIdHost: string | null; redirectUri: string }) =>
  req.clientIdHost ?? new URL(req.redirectUri).hostname

/** Approve → a fresh code; deny → access_denied. Either way the request is used up. */
export async function decide(deps: Deps, user: User, id: string, approve: boolean) {
  const req = await liveRequest(deps, user, id)
  if (!req) return null
  await deps.store.deleteOAuthRequest(req.id)
  if (!approve) {
    return clientRedirect(deps, req.redirectUri, {
      error: 'access_denied',
      error_description: 'The user declined',
      state: req.state,
    })
  }
  const code = randomToken(32)
  await deps.store.putAuthCode({
    hash: hashToken(code),
    email: user.email,
    clientId: req.clientId,
    clientName: req.clientName,
    clientHost: clientHostOf(req),
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    scope: req.scope,
    expiresAt: new Date(deps.clock.now().getTime() + AUTH_CODE_TTL_SECONDS * 1000).toISOString(),
  })
  return clientRedirect(deps, req.redirectUri, { code, state: req.state })
}

// --- token --------------------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

function newRefresh(deps: Deps, grantId: string, email: string) {
  const token = randomToken(32)
  const expiresAt = new Date(
    deps.clock.now().getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000
  ).toISOString()
  const record: RefreshTokenRecord = { hash: hashToken(token), grantId, email, expiresAt }
  return { token, record }
}

async function issue(deps: Deps, grant: GrantRecord, refreshToken: string): Promise<TokenResponse> {
  const accessToken = await signAccessToken(
    deps.config,
    { email: grant.email, clientId: grant.clientId, grantId: grant.id, scope: grant.scope },
    deps.clock.now()
  )
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: grant.scope,
  }
}

const expired = (deps: Deps, iso: string) => Date.parse(iso) <= deps.clock.now().getTime()

export async function exchangeCode(
  deps: Deps,
  p: Record<string, string | undefined>
): Promise<TokenResponse> {
  if (!p.code || !p.code_verifier || !p.redirect_uri || !p.client_id) {
    throw new OAuthError(
      'invalid_request',
      'code, code_verifier, redirect_uri and client_id are required'
    )
  }
  const code = await deps.store.takeAuthCode(hashToken(p.code))
  if (!code || expired(deps, code.expiresAt)) {
    throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired or used')
  }
  if (code.clientId !== p.client_id) {
    throw new OAuthError('invalid_grant', 'The code was issued to another client')
  }
  if (code.redirectUri !== p.redirect_uri)
    throw new OAuthError('invalid_grant', 'redirect_uri mismatch')
  if (!verifyPkce(p.code_verifier, code.codeChallenge)) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed')
  }
  if (p.resource !== undefined && !isOurResource(deps, p.resource)) {
    throw new OAuthError('invalid_target', `resource must be ${code.resource}`)
  }
  const user = await deps.store.getUser(code.email)
  if (!user) throw new OAuthError('invalid_grant', 'Unknown user')
  if ((await standingOf(deps, code.email)) === 'none') {
    throw new OAuthError('invalid_grant', 'This account may no longer sign in')
  }

  const now = deps.clock.now().toISOString()
  const grantId = newId()
  const refresh = newRefresh(deps, grantId, code.email)
  const grant: GrantRecord = {
    id: grantId,
    email: code.email,
    clientId: code.clientId,
    clientName: code.clientName,
    clientHost: code.clientHost,
    resource: code.resource,
    scope: code.scope,
    refreshHash: refresh.record.hash,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: refresh.record.expiresAt,
  }
  await deps.store.createGrant(grant, refresh.record)
  const client = await resolveClient(deps, code.clientId)
  if (client) await touchClient(deps, client)
  return issue(deps, grant, refresh.token)
}

export async function refresh(
  deps: Deps,
  p: Record<string, string | undefined>
): Promise<TokenResponse> {
  if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required')
  const hash = hashToken(p.refresh_token)
  const claimed = await deps.store.claimRefreshToken(hash, deps.clock.now().toISOString())
  if (!claimed) throw new OAuthError('invalid_grant', 'Unknown refresh token')
  const { record, reused } = claimed
  if (reused) {
    // A rotated-out token came back: assume it leaked and end the whole grant.
    await deps.store.deleteGrant(record.email, record.grantId)
    throw new OAuthError(
      'invalid_grant',
      'Refresh token reuse detected; the connection was revoked'
    )
  }
  if (expired(deps, record.expiresAt))
    throw new OAuthError('invalid_grant', 'Refresh token expired')
  const grant = await deps.store.getGrant(record.email, record.grantId)
  if (!grant || grant.refreshHash !== hash || expired(deps, grant.expiresAt)) {
    throw new OAuthError('invalid_grant', 'The connection was revoked')
  }
  if (p.client_id !== undefined && p.client_id !== grant.clientId) {
    throw new OAuthError('invalid_grant', 'The refresh token was issued to another client')
  }
  // A user without standing (a domain removed, an invitation revoked) gets no new tokens.
  if ((await standingOf(deps, grant.email)) === 'none') {
    throw new OAuthError('invalid_grant', 'This account may no longer sign in')
  }
  if (p.resource !== undefined && !isOurResource(deps, p.resource)) {
    throw new OAuthError('invalid_target', `resource must be ${grant.resource}`)
  }
  const next = newRefresh(deps, grant.id, grant.email)
  const rotated: GrantRecord = {
    ...grant,
    refreshHash: next.record.hash,
    expiresAt: next.record.expiresAt,
  }
  if (!(await deps.store.rotateGrant(rotated, next.record))) {
    throw new OAuthError('invalid_grant', 'The connection was revoked')
  }
  return issue(deps, rotated, next.token)
}

/** RFC 7009: revoke the grant behind a refresh or access token. Unknown tokens are fine. */
export async function revoke(deps: Deps, p: Record<string, string | undefined>) {
  const token = p.token
  if (!token) throw new OAuthError('invalid_request', 'token is required')
  const rt = await deps.store.getRefreshToken(hashToken(token))
  if (rt) {
    const grant = await deps.store.getGrant(rt.email, rt.grantId)
    if (grant && (p.client_id === undefined || p.client_id === grant.clientId)) {
      await deps.store.deleteGrant(rt.email, rt.grantId)
    }
    return
  }
  const claims = await verifyAccessToken(deps.config, token, deps.clock.now())
  if (claims && (p.client_id === undefined || p.client_id === claims.clientId)) {
    await deps.store.deleteGrant(claims.email, claims.grantId)
  }
}
