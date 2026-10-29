import { SITE_COOKIE_NAME } from '@fling/shared/site-cookie'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_ORIGIN, cookiesOf, createUser, type Env, json, setup } from './helpers.ts'

let env: Env
beforeEach(() => {
  env = setup()
})

const SESSION = '__Host-fling_session'

describe('API authentication', () => {
  it('401 without credentials, 401 with a bad key', async () => {
    const none = await env.app.request('/api/me')
    expect(none.status).toBe(401)
    expect((await json(none)).error.code).toBe('unauthenticated')
    const bad = await env.app.request('/api/me', {
      headers: { authorization: 'Bearer fling_nope' },
    })
    expect(bad.status).toBe(401)
  })

  it('accepts a bearer key and a session cookie', async () => {
    const { key, session } = await createUser(env)
    const viaKey = await env.app.request('/api/me', { headers: { authorization: `Bearer ${key}` } })
    expect(await json(viaKey)).toEqual({
      email: 'alice@example.test',
      name: 'Alice',
      picture: null,
      userSlug: 'alice',
      admin: false,
      guest: false,
    })
    const viaCookie = await env.app.request('/api/me', {
      headers: { cookie: `${SESSION}=${session}` },
    })
    expect(viaCookie.status).toBe(200)
  })

  it('expired sessions are rejected', async () => {
    const { session } = await createUser(env)
    env.advance(8 * 24 * 3600 * 1000)
    const res = await env.app.request('/api/me', { headers: { cookie: `${SESSION}=${session}` } })
    expect(res.status).toBe(401)
  })

  it('cookie-auth mutations need Origin = APP_ORIGIN; bearer does not', async () => {
    const { session, key } = await createUser(env)
    const cookie = `${SESSION}=${session}`
    const noOrigin = await env.app.request('/api/sites/x/archive', {
      method: 'POST',
      headers: { cookie },
    })
    expect(noOrigin.status).toBe(403)
    expect((await json(noOrigin)).error.code).toBe('csrf')
    const evil = await env.app.request('/api/sites/x/archive', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil--x.fling.test' },
    })
    expect(evil.status).toBe(403)
    const good = await env.app.request('/api/sites/x/archive', {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN },
    })
    expect(good.status).toBe(404) // passed auth; site doesn't exist
    const bearer = await env.app.request('/api/sites/x/archive', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(bearer.status).toBe(404)
  })

  it('lists and revokes API keys', async () => {
    const { key } = await createUser(env)
    const auth = { authorization: `Bearer ${key}` }
    const list = await json(await env.app.request('/api/keys', { headers: auth }))
    expect(list.keys).toHaveLength(1)
    expect(list.keys[0].name).toBe('cli:test')
    const id = list.keys[0].id
    const del = await env.app.request(`/api/keys/${id}`, { method: 'DELETE', headers: auth })
    expect(del.status).toBe(204)
    expect((await env.app.request('/api/me', { headers: auth })).status).toBe(401)
  })

  it('rejects requests without x-origin-verify when a secret is configured', async () => {
    env = setup({ secrets: { ...setup().config.secrets, originVerifySecret: 'shh' } })
    const { key } = await createUser(env)
    const headers = { authorization: `Bearer ${key}` }
    expect((await env.app.request('/api/me', { headers })).status).toBe(403)
    const wrong = { ...headers, 'x-origin-verify': 'nope' }
    expect((await env.app.request('/api/me', { headers: wrong })).status).toBe(403)
    const right = { ...headers, 'x-origin-verify': 'shh' }
    expect((await env.app.request('/api/me', { headers: right })).status).toBe(200)
    expect((await env.app.request('/healthz')).status).toBe(200)
  })
})

describe('/auth/login, logout, cli', () => {
  it('/auth/login without a session goes to the issuer with a validated return', async () => {
    const ret = encodeURIComponent('https://evil.example/x')
    const res = await env.app.request(`/auth/login?return=${ret}`)
    expect(res.headers.get('location')).toMatch(/^https:\/\/idp\.example\.test\/authorize\?/)
    expect(cookiesOf(res).fling_oauth?.raw).toMatch(/Path=\/auth/)
    const flow = JSON.parse(
      Buffer.from(cookiesOf(res).fling_oauth?.value as string, 'base64url').toString()
    )
    expect(flow.ret).toBe('/')
  })

  it('/auth/login with a session refreshes fling_site and redirects back', async () => {
    const { session } = await createUser(env)
    const ret = 'https://hello.fling.test/'
    const res = await env.app.request(`/auth/login?return=${encodeURIComponent(ret)}`, {
      headers: { cookie: `${SESSION}=${session}` },
    })
    expect(res.headers.get('location')).toBe(ret)
    expect(cookiesOf(res)[SITE_COOKIE_NAME]).toBeDefined()
  })

  it('logout clears both cookies (same-origin only)', async () => {
    expect((await env.app.request('/auth/logout', { method: 'POST' })).status).toBe(403)
    const res = await env.app.request('/auth/logout', {
      method: 'POST',
      headers: { origin: APP_ORIGIN },
    })
    expect(res.status).toBe(200)
    const cookies = cookiesOf(res)
    expect(cookies[SESSION]?.raw).toMatch(/Max-Age=0/)
    expect(cookies[SITE_COOKIE_NAME]?.raw).toMatch(/Max-Age=0/)
  })

  it('/auth/cli validates redirect_uri, sends to login, then mints a cli key', async () => {
    const bad = await env.app.request(
      `/auth/cli?redirect_uri=${encodeURIComponent('https://evil.example/callback')}`
    )
    expect(bad.status).toBe(400)

    const redirect = 'http://127.0.0.1:53123/callback'
    const path = `/auth/cli?redirect_uri=${encodeURIComponent(redirect)}&hostname=My-Laptop&state=st4te`
    const anon = await env.app.request(path)
    expect(anon.headers.get('location')).toMatch(/^https:\/\/idp\.example\.test\/authorize\?/)
    const flow = cookiesOf(anon).fling_oauth?.value as string
    const ret = JSON.parse(Buffer.from(flow, 'base64url').toString()).ret as string
    expect(ret.startsWith(`${APP_ORIGIN}/auth/cli?`)).toBe(true)
    expect(new URL(ret).searchParams.get('state')).toBe('st4te')

    const { session } = await createUser(env)
    const res = await env.app.request(path, { headers: { cookie: `${SESSION}=${session}` } })
    const target = new URL(res.headers.get('location') as string)
    expect(`${target.origin}${target.pathname}`).toBe(redirect)
    const key = target.searchParams.get('key') as string
    expect(key).toMatch(/^fling_/)
    expect(target.searchParams.get('state')).toBe('st4te')
    const me = await env.app.request('/api/me', { headers: { authorization: `Bearer ${key}` } })
    expect(me.status).toBe(200)
    const keys = await json(
      await env.app.request('/api/keys', { headers: { authorization: `Bearer ${key}` } })
    )
    expect(keys.keys.map((k: any) => k.name)).toContain('cli:my-laptop')
  })

  it('without an issuer, sign-in is the dev form in dev and 404 otherwise', async () => {
    const dev = setup({ devLogin: true, secureCookies: false })
    dev.deps.identity = null
    const res = await dev.app.request('/auth/login?return=/sites')
    expect(res.headers.get('location')).toBe(
      `/auth/dev-login?return=${encodeURIComponent(`${APP_ORIGIN}/sites`)}`
    )
    env.deps.identity = null
    expect((await env.app.request('/auth/login')).status).toBe(404)
    expect((await env.app.request('/auth/callback?code=x&state=y')).status).toBe(404)
  })

  it('dev-login is 404 unless enabled', async () => {
    expect((await env.app.request('/auth/dev-login?email=a@b.c')).status).toBe(404)
    const dev = setup({ devLogin: true, secureCookies: false })
    const res = await dev.app.request('/auth/dev-login?email=Dev@Example.test&return=/sites')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/sites`)
    const cookies = cookiesOf(res)
    expect(cookies.fling_session?.raw).not.toMatch(/Secure/)
    expect(await dev.store.getUser('dev@example.test')).not.toBeNull()
  })
})
