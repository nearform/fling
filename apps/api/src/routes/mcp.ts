/**
 * `/mcp` — the remote MCP endpoint (Streamable HTTP, stateless: no sessions, JSON responses, no
 * SSE — a Lambda can't hold a stream open). Auth: `Authorization: Bearer <token>` where the token
 * is an OAuth access token from /oauth/token (aud = this resource, grant still active) or a CLI
 * API key (`fling_…`, handy for testing). Anything else → 401 with a `WWW-Authenticate` pointing
 * at the protected-resource metadata, which is how MCP clients discover the OAuth server.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { type Context, Hono } from 'hono'
import { API_KEY_PREFIX, validateApiKey } from '../auth/api-keys.ts'
import { createRemoteMcpServer } from '../mcp/server.ts'
import { resourceMetadataUrl, SCOPE, verifyAccessToken } from '../oauth/tokens.ts'
import type { User } from '../store/types.ts'
import type { AppEnv } from '../types.ts'
import { publicCors } from './oauth.ts'

/** Requests carry whole sites inline (base64 of ≤4 MB decoded); Lambda's own cap is 6 MB. */
const MAX_BODY_BYTES = 6 * 1024 * 1024
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

export const mcpRoutes = new Hono<AppEnv>()
mcpRoutes.use('*', publicCors)

function challenge(c: Context<AppEnv>, error?: { code: string; description: string }) {
  const { config } = c.get('deps')
  const parts = [
    `resource_metadata="${resourceMetadataUrl(config)}"`,
    `scope="${SCOPE}"`,
    ...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
  ]
  c.header('WWW-Authenticate', `Bearer ${parts.join(', ')}`)
  return c.json(
    error
      ? { error: error.code, error_description: error.description }
      : { error: 'unauthorized', error_description: 'Sign in to Fling to use this server' },
    401
  )
}

async function authenticate(c: Context<AppEnv>): Promise<User | Response> {
  const { store, config, clock } = c.get('deps')
  const header = c.req.header('authorization')
  const token = header ? /^Bearer\s+(\S+)$/i.exec(header)?.[1] : undefined
  if (!token) return challenge(c)
  const invalid = () =>
    challenge(c, { code: 'invalid_token', description: 'The access token is invalid or expired' })

  if (token.startsWith(API_KEY_PREFIX)) {
    const result = await validateApiKey(store, token, clock.now())
    if (!result) return invalid()
    c.set('via', 'api_key')
    return result.user
  }
  const claims = await verifyAccessToken(config, token, clock.now())
  if (!claims) return invalid()
  // Revocation is immediate: the grant must still exist.
  const grant = await store.getGrant(claims.email, claims.grantId)
  if (!grant || Date.parse(grant.expiresAt) <= clock.now().getTime()) {
    return challenge(c, { code: 'invalid_token', description: 'This connection was revoked' })
  }
  const user = await store.getUser(claims.email)
  if (!user) return invalid()
  const now = clock.now()
  if (!grant.lastUsedAt || now.getTime() - Date.parse(grant.lastUsedAt) > TOUCH_INTERVAL_MS) {
    await store.touchGrant(grant.email, grant.id, now.toISOString())
  }
  c.set('via', 'oauth')
  return user
}

mcpRoutes.all('/', async c => {
  const auth = await authenticate(c)
  if (auth instanceof Response) return auth
  const user = auth

  if (c.req.method !== 'POST') {
    // Stateless: no standalone SSE stream (GET) and no sessions to end (DELETE).
    c.header('Allow', 'POST')
    return c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405
    )
  }

  const length = Number(c.req.header('content-length') ?? 0)
  const raw = length > MAX_BODY_BYTES ? null : await c.req.arrayBuffer()
  if (!raw || raw.byteLength > MAX_BODY_BYTES) {
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Request too large (max ${MAX_BODY_BYTES / 1024 / 1024} MB). Use fling_upload_begin / fling_upload_file / fling_upload_finish for big sites.`,
        },
        id: null,
      },
      413
    )
  }
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      400
    )
  }

  const deps = c.get('deps')
  const server = createRemoteMcpServer(deps, user)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw, { parsedBody: body })
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
})
