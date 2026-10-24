/**
 * Fling as an OAuth 2.1 authorization server for its own MCP endpoint (we are both AS and RS):
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server        RFC 8414 (+ /openid-configuration alias)
 *   POST /oauth/register                                RFC 7591 DCR, public clients
 *   GET  /oauth/authorize                               → sign-in → SPA consent /authorize
 *   POST /oauth/token                                   authorization_code | refresh_token
 *   POST /oauth/revoke                                  RFC 7009
 * The consent API (/api/oauth/requests/:id…) lives in routes/api.ts (session + Origin check).
 * None of these use cookies except /oauth/authorize (a GET that only reads the session), so the
 * CSRF Origin check doesn't apply; the metadata, register, token and revoke endpoints allow any
 * origin (browser-based MCP clients), without credentials.
 */
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { resolveSession, sessionPrincipal } from '../auth/middleware.ts'
import { ApiError } from '../lib/errors.ts'
import { RegistrationError, registerClient } from '../oauth/clients.ts'
import {
  createAuthRequest,
  exchangeCode,
  OAuthError,
  refresh,
  revoke,
  validateAuthorize,
} from '../oauth/flow.ts'
import { mcpResource, SCOPE } from '../oauth/tokens.ts'
import { canInstance } from '../policy.ts'
import type { AppEnv } from '../types.ts'

export const oauthRoutes = new Hono<AppEnv>()

export const publicCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'authorization',
    'content-type',
    'accept',
    'mcp-protocol-version',
    'mcp-session-id',
    'last-event-id',
  ],
  exposeHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version'],
  maxAge: 86400,
})

for (const path of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke']) {
  oauthRoutes.use(path, publicCors)
}
oauthRoutes.use(
  '/oauth/*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: () => {
      throw new ApiError(413, 'too_large', 'Request body too large')
    },
  })
)

const cacheable = (c: Context<AppEnv>) => c.header('Cache-Control', 'public, max-age=300')

function protectedResource(c: Context<AppEnv>) {
  const { config } = c.get('deps')
  cacheable(c)
  return c.json({
    resource: mcpResource(config),
    authorization_servers: [config.appOrigin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Fling',
    resource_documentation: `${config.appOrigin}/get-started`,
  })
}

oauthRoutes.get('/.well-known/oauth-protected-resource', protectedResource)
oauthRoutes.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

function authorizationServer(c: Context<AppEnv>) {
  const o = c.get('deps').config.appOrigin
  cacheable(c)
  return c.json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/get-started`,
  })
}

oauthRoutes.get('/.well-known/oauth-authorization-server', authorizationServer)
oauthRoutes.get('/.well-known/oauth-authorization-server/mcp', authorizationServer)
oauthRoutes.get('/.well-known/openid-configuration', authorizationServer)

/** Form-encoded (RFC 6749) or, leniently, JSON → string params. */
async function params(c: Context<AppEnv>): Promise<Record<string, string | undefined>> {
  const type = c.req.header('content-type') ?? ''
  let raw: Record<string, unknown> = {}
  try {
    raw = type.includes('application/json')
      ? ((await c.req.json()) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>)
  } catch {
    throw new OAuthError('invalid_request', 'Unreadable request body')
  }
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === 'string') out[k] = v
  return out
}

function oauthError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof OAuthError) {
    c.header('Pragma', 'no-cache')
    return c.json({ error: err.error, error_description: err.description }, err.status)
  }
  throw err
}

oauthRoutes.post('/oauth/register', async c => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400)
  }
  try {
    return c.json(await registerClient(c.get('deps'), body), 201)
  } catch (err) {
    if (err instanceof RegistrationError) {
      return c.json({ error: err.error, error_description: err.message }, 400)
    }
    throw err
  }
})

oauthRoutes.get('/oauth/authorize', async c => {
  const deps = c.get('deps')
  const { config } = deps
  const outcome = await validateAuthorize(deps, c.req.query())
  if (outcome.kind === 'error_page') {
    const q = new URLSearchParams({ error: outcome.error, error_description: outcome.description })
    return c.redirect(`/authorize?${q}`, 302)
  }
  if (outcome.kind === 'redirect') return c.redirect(outcome.url, 302)

  const session = await resolveSession(c)
  if (!session) {
    const self = `${config.appOrigin}/oauth/authorize${new URL(c.req.url).search}`
    return c.redirect(`/auth/login?return=${encodeURIComponent(self)}`, 302)
  }
  // An impersonating admin may not connect apps in the user's name.
  if (!canInstance(sessionPrincipal(config, session), 'account.oauth.approve')) {
    const q = new URLSearchParams({
      error: 'access_denied',
      error_description: `You are impersonating ${session.user.email}. Stop impersonating to connect apps.`,
    })
    return c.redirect(`/authorize?${q}`, 302)
  }
  const req = await createAuthRequest(deps, session.user, outcome.client, outcome.params)
  return c.redirect(`/authorize?request=${encodeURIComponent(req.id)}`, 302)
})

oauthRoutes.post('/oauth/token', async c => {
  const deps = c.get('deps')
  try {
    const p = await params(c)
    let res: Awaited<ReturnType<typeof exchangeCode>>
    if (p.grant_type === 'authorization_code') res = await exchangeCode(deps, p)
    else if (p.grant_type === 'refresh_token') res = await refresh(deps, p)
    else throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token')
    c.header('Pragma', 'no-cache')
    return c.json(res)
  } catch (err) {
    return oauthError(c, err)
  }
})

oauthRoutes.post('/oauth/revoke', async c => {
  try {
    await revoke(c.get('deps'), await params(c))
    return c.body(null, 200)
  } catch (err) {
    return oauthError(c, err)
  }
})
