import { createHash, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { APP_ORIGIN, createUser, type Env, json } from './helpers.ts'

export const SESSION = '__Host-fling_session'
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
export const RESOURCE = `${APP_ORIGIN}/mcp`

export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export async function register(env: Env, body: object = {}) {
  return env.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...body,
    }),
  })
}

export function authorizeUrl(params: Record<string, string | undefined>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  return `/oauth/authorize?${q}`
}

export function token(env: Env, params: Record<string, string>) {
  return env.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
}

/** The whole dance: register → authorize (signed in) → consent approve → code. */
export async function authorizeAndApprove(
  env: Env,
  opts: { email?: string; redirectUri?: string; clientId?: string; state?: string } = {}
) {
  const { session } = await createUser(env, opts.email)
  const cookie = `${SESSION}=${session}`
  let clientId = opts.clientId
  if (!clientId) {
    const reg = await register(env)
    expect(reg.status).toBe(201)
    clientId = (await json(reg)).client_id as string
  }
  const redirectUri = opts.redirectUri ?? CLAUDE_CALLBACK
  const { verifier, challenge } = pkce()
  const state = opts.state ?? 'st4te'
  const auth = await env.app.request(
    authorizeUrl({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'fling',
      resource: RESOURCE,
    }),
    { headers: { cookie } }
  )
  expect(auth.status).toBe(302)
  const location = auth.headers.get('location') ?? ''
  expect(location).toMatch(/^\/authorize\?request=/)
  const requestId = new URL(location, APP_ORIGIN).searchParams.get('request') as string
  const approve = await env.app.request(`/api/oauth/requests/${requestId}/approve`, {
    method: 'POST',
    headers: { cookie, origin: APP_ORIGIN },
  })
  expect(approve.status).toBe(200)
  const redirectUrl = new URL((await json(approve)).redirectUrl)
  expect(redirectUrl.searchParams.get('state')).toBe(state)
  expect(redirectUrl.searchParams.get('iss')).toBe(APP_ORIGIN)
  const code = redirectUrl.searchParams.get('code') as string
  expect(code).toBeTruthy()
  return { code, verifier, clientId, redirectUri, cookie, requestId }
}

export async function connect(env: Env, email?: string) {
  const a = await authorizeAndApprove(env, { email })
  const res = await token(env, {
    grant_type: 'authorization_code',
    code: a.code,
    code_verifier: a.verifier,
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    resource: RESOURCE,
  })
  expect(res.status).toBe(200)
  const body = await json(res)
  return {
    ...a,
    accessToken: body.access_token as string,
    refreshToken: body.refresh_token as string,
  }
}

/** One JSON-RPC call over Streamable HTTP. */
export async function rpc(
  env: Env,
  bearer: string | undefined,
  method: string,
  params: object = {},
  id = 1
) {
  return env.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

export async function callTool(env: Env, bearer: string, name: string, args: object) {
  const res = await rpc(env, bearer, 'tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  const body = await json(res)
  return body.result as {
    isError?: boolean
    content: { type: string; text: string }[]
    structuredContent?: any
  }
}
