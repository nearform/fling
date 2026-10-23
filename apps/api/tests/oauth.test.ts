import { beforeEach, describe, expect, it } from 'vitest'
import { clearCimdCache } from '../src/oauth/clients.ts'
import { APP_ORIGIN, createUser, type Env, json, setup } from './helpers.ts'
import {
  authorizeAndApprove,
  authorizeUrl,
  CLAUDE_CALLBACK,
  connect,
  pkce,
  RESOURCE,
  register,
  rpc,
  SESSION,
  token,
} from './oauth-helpers.ts'

let env: Env

beforeEach(() => {
  env = setup()
  clearCimdCache()
})

describe('discovery metadata', () => {
  it('serves protected resource metadata at the root and path-suffixed URLs', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await env.app.request(path, { headers: { origin: 'https://inspector.test' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await json(res)).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [APP_ORIGIN],
        scopes_supported: ['fling'],
        bearer_methods_supported: ['header'],
      })
    }
  })

  it('serves authorization server metadata (RFC 8414 + OIDC alias)', async () => {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      const body = await json(await env.app.request(path))
      expect(body).toMatchObject({
        issuer: APP_ORIGIN,
        authorization_endpoint: `${APP_ORIGIN}/oauth/authorize`,
        token_endpoint: `${APP_ORIGIN}/oauth/token`,
        registration_endpoint: `${APP_ORIGIN}/oauth/register`,
        revocation_endpoint: `${APP_ORIGIN}/oauth/revoke`,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
      })
    }
  })

  it('answers CORS preflight for the token endpoint', async () => {
    const res = await env.app.request('/oauth/token', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:6274',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('dynamic client registration', () => {
  it('accepts Claude callbacks and loopback redirects', async () => {
    const res = await register(env)
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.client_id).toMatch(/^mcp_/)
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.client_secret).toBeUndefined()

    const claudeCom = await register(env, {
      redirect_uris: ['https://claude.com/api/mcp/auth_callback'],
    })
    expect(claudeCom.status).toBe(201)
    const loop = await register(env, {
      redirect_uris: ['http://localhost:6274/oauth/callback', 'http://127.0.0.1:33418/callback'],
    })
    expect(loop.status).toBe(201)
  })

  it('rejects redirect URIs off the allowlist', async () => {
    for (const uri of [
      'https://evil.example/callback',
      'https://claude.ai/api/mcp/auth_callback/x',
      'http://claude.ai/api/mcp/auth_callback',
      'https://localhost/callback',
      'javascript:alert(1)',
    ]) {
      const res = await register(env, { redirect_uris: [uri] })
      expect(res.status).toBe(400)
      expect((await json(res)).error).toBe('invalid_redirect_uri')
    }
    expect((await register(env, { redirect_uris: [] })).status).toBe(400)
  })

  it('honours OAUTH_REDIRECT_ALLOWLIST', async () => {
    env = setup({ oauthRedirectAllowlist: ['https://only.example/cb'] })
    expect((await register(env, { redirect_uris: ['https://only.example/cb'] })).status).toBe(201)
    expect((await register(env)).status).toBe(400)
    expect(
      (await register(env, { redirect_uris: ['http://127.0.0.1:9999/callback'] })).status
    ).toBe(400)
  })
})

describe('authorize', () => {
  it('sends a signed-out user through sign-in and back', async () => {
    const clientId = (await json(await register(env))).client_id
    const url = authorizeUrl({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 'abc',
    })
    const res = await env.app.request(url)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location') ?? '', APP_ORIGIN)
    expect(loc.pathname).toBe('/auth/login')
    expect(loc.searchParams.get('return')).toBe(`${APP_ORIGIN}${url}`)
    // and /auth/login accepts that return URL (same origin)
    const login = await env.app.request(
      `/auth/login?return=${encodeURIComponent(`${APP_ORIGIN}${url}`)}`
    )
    expect(login.headers.get('location')).toContain(encodeURIComponent('/oauth/authorize'))
  })

  it('shows errors for unknown clients and bad redirect URIs on our own page', async () => {
    const { session } = await createUser(env)
    const clientId = (await json(await register(env))).client_id
    const base = {
      response_type: 'code',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    }
    const unknown = await env.app.request(
      authorizeUrl({ ...base, client_id: 'mcp_nope_nope_nope', redirect_uri: CLAUDE_CALLBACK }),
      { headers: { cookie: `${SESSION}=${session}` } }
    )
    expect(unknown.headers.get('location')).toMatch(/^\/authorize\?error=invalid_client/)
    const mismatch = await env.app.request(
      authorizeUrl({
        ...base,
        client_id: clientId,
        redirect_uri: 'https://claude.com/api/mcp/auth_callback',
      })
    )
    expect(mismatch.headers.get('location')).toMatch(/^\/authorize\?error=invalid_redirect_uri/)
  })

  it('redirects protocol errors (PKCE missing, wrong resource) to the client with state', async () => {
    const clientId = (await json(await register(env))).client_id
    const noPkce = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        state: 'xyz',
      })
    )
    const loc = new URL(noPkce.headers.get('location') ?? '')
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CALLBACK)
    expect(loc.searchParams.get('error')).toBe('invalid_request')
    expect(loc.searchParams.get('state')).toBe('xyz')

    const plain = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'plain',
      })
    )
    expect(new URL(plain.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_request'
    )

    const wrongResource = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        resource: 'https://other.example/mcp',
      })
    )
    expect(new URL(wrongResource.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'invalid_target'
    )
  })

  it('consent info and deny', async () => {
    const { session } = await createUser(env)
    const cookie = `${SESSION}=${session}`
    const clientId = (await json(await register(env))).client_id
    const res = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's1',
      }),
      { headers: { cookie } }
    )
    const id = new URL(res.headers.get('location') ?? '', APP_ORIGIN).searchParams.get('request')
    const info = await env.app.request(`/api/oauth/requests/${id}`, { headers: { cookie } })
    expect(await json(info)).toEqual({
      clientName: 'Claude',
      clientUri: null,
      clientIdHost: null,
      redirectHost: 'claude.ai',
      loopback: false,
      scopes: ['fling'],
      email: 'alice@nearform.com',
    })
    // CSRF: approve without Origin is refused
    const csrf = await env.app.request(`/api/oauth/requests/${id}/approve`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(csrf.status).toBe(403)
    // another user can't see it
    const bob = await createUser(env, 'bob@nearform.com')
    const other = await env.app.request(`/api/oauth/requests/${id}`, {
      headers: { cookie: `${SESSION}=${bob.session}` },
    })
    expect(other.status).toBe(404)
    // an API key can't approve
    const viaKey = await env.app.request(`/api/oauth/requests/${id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.key}` },
    })
    expect(viaKey.status).toBe(403)

    const deny = await env.app.request(`/api/oauth/requests/${id}/deny`, {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN },
    })
    const url = new URL((await json(deny)).redirectUrl)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('s1')
    // used up
    expect(
      (await env.app.request(`/api/oauth/requests/${id}`, { headers: { cookie } })).status
    ).toBe(404)
  })

  it('supports Client ID Metadata Documents with port-agnostic loopback redirects', async () => {
    const cimd = 'https://claude.ai/oauth/claude-code-client-metadata'
    env.deps.fetch = async input => {
      expect(String(input)).toBe(cimd)
      return new Response(
        JSON.stringify({
          client_id: cimd,
          client_name: 'Claude Code',
          client_uri: 'https://claude.ai',
          redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    const a = await authorizeAndApprove(env, {
      clientId: cimd,
      redirectUri: 'http://localhost:51234/callback',
    })
    const info = await token(env, {
      grant_type: 'authorization_code',
      code: a.code,
      code_verifier: a.verifier,
      client_id: cimd,
      redirect_uri: a.redirectUri,
    })
    expect(info.status).toBe(200)
    const conns = await json(
      await env.app.request('/api/connections', { headers: { cookie: a.cookie } })
    )
    expect(conns.connections[0]).toMatchObject({
      clientName: 'Claude Code',
      clientHost: 'claude.ai',
    })

    // a path the document doesn't declare is refused
    const bad = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: cimd,
        redirect_uri: 'http://localhost:51234/other',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
      { headers: { cookie: a.cookie } }
    )
    expect(bad.headers.get('location')).toMatch(/error=invalid_redirect_uri/)
  })

  it('rejects a CIMD document whose client_id does not match its URL', async () => {
    const cimd = 'https://client.example/meta.json'
    env.deps.fetch = async () =>
      new Response(
        JSON.stringify({
          client_id: 'https://other.example/meta.json',
          redirect_uris: [CLAUDE_CALLBACK],
        })
      )
    const res = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: cimd,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      })
    )
    expect(res.headers.get('location')).toMatch(/error=invalid_client/)
  })
})

describe('token', () => {
  it('exchanges a code with PKCE, once', async () => {
    const a = await authorizeAndApprove(env)
    const params = {
      grant_type: 'authorization_code',
      code: a.code,
      code_verifier: a.verifier,
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      resource: RESOURCE,
    }
    const res = await token(env, params)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await json(res)
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'fling' })
    expect(body.access_token.split('.')).toHaveLength(3)
    expect(body.refresh_token).toBeTruthy()

    const again = await token(env, params)
    expect(again.status).toBe(400)
    expect((await json(again)).error).toBe('invalid_grant')
  })

  it('rejects a wrong verifier, a redirect mismatch, another client, an expired code', async () => {
    const wrongVerifier = await authorizeAndApprove(env)
    const r1 = await token(env, {
      grant_type: 'authorization_code',
      code: wrongVerifier.code,
      code_verifier: pkce().verifier,
      client_id: wrongVerifier.clientId,
      redirect_uri: wrongVerifier.redirectUri,
    })
    expect((await json(r1)).error).toBe('invalid_grant')

    const mismatch = await authorizeAndApprove(env)
    const r2 = await token(env, {
      grant_type: 'authorization_code',
      code: mismatch.code,
      code_verifier: mismatch.verifier,
      client_id: mismatch.clientId,
      redirect_uri: 'https://claude.com/api/mcp/auth_callback',
    })
    expect((await json(r2)).error).toBe('invalid_grant')

    const other = await authorizeAndApprove(env)
    const r3 = await token(env, {
      grant_type: 'authorization_code',
      code: other.code,
      code_verifier: other.verifier,
      client_id: 'mcp_someone_else_entirely',
      redirect_uri: other.redirectUri,
    })
    expect((await json(r3)).error).toBe('invalid_grant')

    const late = await authorizeAndApprove(env)
    env.advance(61_000)
    const r4 = await token(env, {
      grant_type: 'authorization_code',
      code: late.code,
      code_verifier: late.verifier,
      client_id: late.clientId,
      redirect_uri: late.redirectUri,
    })
    expect((await json(r4)).error).toBe('invalid_grant')

    expect((await json(await token(env, { grant_type: 'password' }))).error).toBe(
      'unsupported_grant_type'
    )
  })

  it('rotates refresh tokens and revokes the grant on reuse', async () => {
    const c = await connect(env)
    const r1 = await token(env, {
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    })
    expect(r1.status).toBe(200)
    const t1 = await json(r1)
    expect(t1.refresh_token).not.toBe(c.refreshToken)
    expect((await rpc(env, t1.access_token, 'tools/list')).status).toBe(200)

    // the old one again → reuse → the whole grant is gone
    const reuse = await token(env, { grant_type: 'refresh_token', refresh_token: c.refreshToken })
    expect(reuse.status).toBe(400)
    expect((await json(reuse)).error).toBe('invalid_grant')
    const next = await token(env, { grant_type: 'refresh_token', refresh_token: t1.refresh_token })
    expect((await json(next)).error).toBe('invalid_grant')
    expect((await rpc(env, t1.access_token, 'tools/list')).status).toBe(401)
  })

  it('expires access tokens after an hour; refresh keeps working', async () => {
    const c = await connect(env)
    env.advance(3601_000)
    expect((await rpc(env, c.accessToken, 'tools/list')).status).toBe(401)
    const r = await token(env, { grant_type: 'refresh_token', refresh_token: c.refreshToken })
    expect((await rpc(env, (await json(r)).access_token, 'tools/list')).status).toBe(200)
  })
})

describe('revocation', () => {
  it('RFC 7009 revoke via refresh token kills access tokens at once', async () => {
    const c = await connect(env)
    expect((await rpc(env, c.accessToken, 'tools/list')).status).toBe(200)
    const res = await env.app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: c.refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
    })
    expect(res.status).toBe(200)
    expect((await rpc(env, c.accessToken, 'tools/list')).status).toBe(401)
    // unknown tokens are fine
    const unknown = await env.app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=nope',
    })
    expect(unknown.status).toBe(200)
  })

  it('lists connections and revokes one from the Connections page', async () => {
    const c = await connect(env)
    const list = await json(
      await env.app.request('/api/connections', { headers: { cookie: c.cookie } })
    )
    expect(list.connections).toHaveLength(1)
    expect(list.connections[0]).toMatchObject({ clientName: 'Claude', clientHost: 'claude.ai' })
    const del = await env.app.request(`/api/connections/${list.connections[0].id}`, {
      method: 'DELETE',
      headers: { cookie: c.cookie, origin: APP_ORIGIN },
    })
    expect(del.status).toBe(204)
    const res = await rpc(env, c.accessToken, 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    const refresh = await token(env, { grant_type: 'refresh_token', refresh_token: c.refreshToken })
    expect((await json(refresh)).error).toBe('invalid_grant')
  })
})
