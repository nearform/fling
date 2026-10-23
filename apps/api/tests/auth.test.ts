import { SITE_COOKIE_NAME, verifySiteCookie } from '@fling/shared/site-cookie'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_ORIGIN, createUser, type Env, json, setup } from './helpers.ts'

let env: Env
beforeEach(() => {
  env = setup()
})

const SESSION = '__Host-fling_session'

function cookiesOf(res: Response): Record<string, { value: string; raw: string }> {
  const out: Record<string, { value: string; raw: string }> = {}
  for (const raw of res.headers.getSetCookie()) {
    const [pair = ''] = raw.split(';')
    const i = pair.indexOf('=')
    out[pair.slice(0, i)] = { value: pair.slice(i + 1), raw }
  }
  return out
}

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
      email: 'alice@nearform.com',
      name: 'Alice',
      picture: null,
      userSlug: 'alice',
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

describe('Google OAuth', () => {
  async function start(ret = 'https://hello.fling.test/page') {
    const res = await env.app.request(`/auth/google?return=${encodeURIComponent(ret)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('accounts.google.test')
    const flow = cookiesOf(res).fling_oauth?.value as string
    return { flow, state: env.google.lastState as string }
  }

  it('signs in a verified nearform user: session + site cookie, redirect to return', async () => {
    const { flow, state } = await start()
    const res = await env.app.request(`/auth/google/callback?code=good-code&state=${state}`, {
      headers: { cookie: `fling_oauth=${flow}` },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    const cookies = cookiesOf(res)
    expect(cookies[SESSION]?.raw).toMatch(/HttpOnly/)
    expect(cookies[SESSION]?.raw).toMatch(/Secure/)
    expect(cookies[SESSION]?.raw).not.toMatch(/Domain/)
    const site = cookies[SITE_COOKIE_NAME]
    expect(site?.raw).toMatch(/Domain=\.fling\.test/)
    expect(site?.raw).toMatch(/HttpOnly/)
    expect(site?.raw).toMatch(/SameSite=Lax/)
    const payload = verifySiteCookie(
      site?.value as string,
      env.config.secrets.siteHmacKey,
      Math.floor(env.deps.clock.now().getTime() / 1000)
    )
    expect(payload?.e).toBe('alice@nearform.com')

    const me = await env.app.request('/api/me', {
      headers: { cookie: `${SESSION}=${cookies[SESSION]?.value}` },
    })
    expect((await json(me)).userSlug).toBe('alice')
  })

  it('rejects a state mismatch and a non-nearform account', async () => {
    const { flow } = await start()
    const mismatch = await env.app.request('/auth/google/callback?code=good-code&state=other', {
      headers: { cookie: `fling_oauth=${flow}` },
    })
    expect(mismatch.headers.get('location')).toBe('/login?error=oauth_state_mismatch')

    env.google.claims = { email: 'eve@gmail.com', email_verified: true }
    const s = await start()
    const res = await env.app.request(`/auth/google/callback?code=good-code&state=${s.state}`, {
      headers: { cookie: `fling_oauth=${s.flow}` },
    })
    expect(res.headers.get('location')).toBe('/login?error=domain_not_allowed')
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
  })
})

describe('/auth/login, logout, cli', () => {
  it('/auth/login without a session goes to Google with a validated return', async () => {
    const ret = encodeURIComponent('https://evil.example/x')
    const res = await env.app.request(`/auth/login?return=${ret}`)
    expect(res.headers.get('location')).toBe('/auth/google?return=%2F')
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
    const loc = anon.headers.get('location') as string
    expect(loc.startsWith('/auth/google?return=')).toBe(true)
    const ret = new URL(loc, APP_ORIGIN).searchParams.get('return') as string
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

  it('dev-login is 404 unless enabled', async () => {
    expect((await env.app.request('/auth/dev-login?email=a@b.c')).status).toBe(404)
    const dev = setup({ devLogin: true, secureCookies: false })
    const res = await dev.app.request('/auth/dev-login?email=Dev@Nearform.com&return=/sites')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/sites`)
    const cookies = cookiesOf(res)
    expect(cookies.fling_session?.raw).not.toMatch(/Secure/)
    expect(await dev.store.getUser('dev@nearform.com')).not.toBeNull()
  })
})
