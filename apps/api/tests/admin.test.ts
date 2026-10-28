/**
 * Admins (ADMIN_EMAILS): the users list, every site's listing and the audit log, impersonation (its rules, what it may
 * not do, its expiry, stopping it), and that admins get nothing over other people's sites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as admin from '../src/admin.ts'
import type { SiteRecord } from '../src/store/types.ts'
import { APP_ORIGIN, api, cookiesOf, createUser, type Env, json, setup } from './helpers.ts'
import {
  authorizeUrl,
  CLAUDE_CALLBACK,
  pkce,
  RESOURCE,
  register,
  SESSION,
} from './oauth-helpers.ts'

const BOSS = 'boss@example.test'
const OTHER_ADMIN = 'other-boss@example.test'
const MEMBER = 'member@example.test'

let env: Env
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  env = setup({ adminEmails: [BOSS, OTHER_ADMIN] })
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => info.mockRestore())

/** Cookie-authenticated request, from the app's origin unless told otherwise. */
function browser(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  origin: string | null = APP_ORIGIN
) {
  return env.app.request(path, {
    method,
    headers: {
      cookie,
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
}

const cookieOf = (session: string) => `${SESSION}=${session}`

/** The session cookie a response set, as a Cookie header. */
function setSession(res: Response): string {
  const set = cookiesOf(res)[SESSION]
  if (!set) throw new Error('no session cookie set')
  return cookieOf(set.value)
}

function site(owner: string, name: string): SiteRecord {
  const now = env.deps.clock.now().toISOString()
  return {
    id: `id-${name}`,
    email: owner,
    name,
    visibility: 'private',
    spa: false,
    archived: false,
    currentVersionId: 'v1',
    shareToken: null,
    audience: { emails: [], groups: [] },
    createdAt: now,
    updatedAt: now,
  }
}

async function world() {
  const boss = await createUser(env, BOSS)
  const other = await createUser(env, OTHER_ADMIN)
  const member = await createUser(env, MEMBER)
  await env.store.createSite(site(MEMBER, 'member-site'))
  await env.store.createSite(site(MEMBER, 'member-docs'))
  return { boss, other, member, bossCookie: cookieOf(boss.session) }
}

async function impersonate(cookie: string, email = MEMBER) {
  const res = await browser(cookie, 'POST', '/api/admin/impersonate', { email })
  expect(res.status).toBe(200)
  return { res, cookie: setSession(res) }
}

describe('the users list', () => {
  it('is a 404 to anyone who is not an admin, by session or key', async () => {
    const { member } = await world()
    for (const path of ['/api/admin/users', '/api/admin/sites', '/api/admin/audit']) {
      expect((await browser(cookieOf(member.session), 'GET', path)).status).toBe(404)
      expect((await api(env, member.key, 'GET', path)).status).toBe(404)
    }
  })

  it('lists every user for an admin: last sign-in, site count, admin badge', async () => {
    const { bossCookie, boss } = await world()
    env.advance(60_000)
    await env.store.upsertUser(
      { email: MEMBER, name: 'Member', picture: null, preferredSlug: 'member' },
      env.deps.clock.now().toISOString()
    )
    const res = await browser(bossCookie, 'GET', '/api/admin/users')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.cursor).toBeNull()
    expect(body.users).toEqual([
      expect.objectContaining({ email: BOSS, admin: true, siteCount: 0 }),
      {
        email: MEMBER,
        name: 'Member',
        picture: null,
        userSlug: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSignInAt: '2026-01-01T00:01:00.000Z',
        siteCount: 2,
        admin: false,
      },
      expect.objectContaining({ email: OTHER_ADMIN, admin: true }),
    ])
    // An admin's API key may list (the smoke test does), not impersonate.
    expect((await api(env, boss.key, 'GET', '/api/admin/users')).status).toBe(200)
  })

  it('pages with a cursor and searches by email prefix', async () => {
    const { bossCookie } = await world()
    const first = await json(await browser(bossCookie, 'GET', '/api/admin/users?limit=2'))
    expect(first.users.map((u: { email: string }) => u.email)).toEqual([BOSS, MEMBER])
    expect(first.cursor).toEqual(expect.any(String))
    const next = await json(
      await browser(
        bossCookie,
        'GET',
        `/api/admin/users?limit=2&cursor=${encodeURIComponent(first.cursor)}`
      )
    )
    expect(next.users.map((u: { email: string }) => u.email)).toEqual([OTHER_ADMIN])
    const found = await json(await browser(bossCookie, 'GET', '/api/admin/users?q=Mem'))
    expect(found.users.map((u: { email: string }) => u.email)).toEqual([MEMBER])
  })
})

describe('the sites list', () => {
  it("lists every site's listing for an admin, and opens none of them", async () => {
    const { bossCookie, boss } = await world()
    await env.store.createSite({
      ...site(MEMBER, 'member-secret'),
      restricted: true,
      audience: { emails: ['friend@example.test'], groups: [] },
      currentVersionId: null,
    })
    await env.store.createSite({ ...site(BOSS, 'boss-site'), visibility: 'public', archived: true })
    const res = await browser(bossCookie, 'GET', '/api/admin/sites')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.truncated).toBe(false)
    expect(body.sites.map((s: { name: string }) => s.name)).toEqual([
      'boss-site',
      'member-docs',
      'member-secret',
      'member-site',
    ])
    const secret = body.sites[2]
    expect(secret).toEqual({
      name: 'member-secret',
      url: expect.stringContaining('member-secret'),
      owner: MEMBER,
      access: 'people',
      archived: false,
      live: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(body.sites[0]).toMatchObject({ owner: BOSS, access: 'public', archived: true })
    expect(body.sites[1]).toMatchObject({ access: 'members', live: true })
    // The listing is all: the restricted site itself is still someone else's.
    expect((await browser(bossCookie, 'GET', '/api/sites/member-secret')).status).toBe(404)
    // An admin's API key may list too.
    expect((await api(env, boss.key, 'GET', '/api/admin/sites')).status).toBe(200)
  })

  it('stops at the ceiling and says the list was cut', async () => {
    await world()
    await env.store.createSite(site(BOSS, 'boss-site'))
    const p = { email: BOSS, admin: true, via: 'session' as const }
    const cut = await admin.listSites(env.deps, p, 2)
    expect(cut.sites.map(s => s.name)).toEqual(['boss-site', 'member-docs'])
    expect(cut.truncated).toBe(true)
    const whole = await admin.listSites(env.deps, p, 3)
    expect([whole.sites.length, whole.truncated]).toEqual([3, false])
  })

  it('is not for an admin while impersonating', async () => {
    const { bossCookie } = await world()
    const { cookie } = await impersonate(bossCookie)
    const res = await browser(cookie, 'GET', '/api/admin/sites')
    expect([res.status, (await json(res)).error.code]).toEqual([403, 'impersonating'])
  })
})

describe('impersonation', () => {
  it('acts as the user: /api/me says so, and their sites are listed', async () => {
    const { bossCookie } = await world()
    const { res, cookie } = await impersonate(bossCookie)
    expect(await json(res)).toEqual({
      email: MEMBER,
      name: 'Alice',
      picture: null,
      userSlug: 'member',
      admin: false,
      impersonator: BOSS,
      impersonationEndsAt: '2026-01-01T01:00:00.000Z',
    })
    const me = await json(await browser(cookie, 'GET', '/api/me'))
    expect(me).toMatchObject({ email: MEMBER, admin: false, impersonator: BOSS })
    const sites = await json(await browser(cookie, 'GET', '/api/sites'))
    expect(sites.sites.map((s: { name: string }) => s.name)).toEqual(['member-docs', 'member-site'])
    // The token is still the admin's session (sub, exp), so code that doesn't know `imp` reads
    // it as the admin's own, never as the member's.
    const claims = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    const before = claims(bossCookie.split('=')[1] ?? '')
    const after = claims(cookie.split('=')[1] ?? '')
    expect(after).toEqual({ ...before, imp: MEMBER, impx: before.iat + 3600 })
    // The admin's own session is untouched: the same cookie as before still works as the admin.
    expect((await json(await browser(bossCookie, 'GET', '/api/me'))).email).toBe(BOSS)
  })

  it('refuses yourself, another admin, a user that does not exist, and non-admins', async () => {
    const { bossCookie, member } = await world()
    const start = (cookie: string, email: string) =>
      browser(cookie, 'POST', '/api/admin/impersonate', { email })
    const self = await start(bossCookie, BOSS)
    expect([self.status, (await json(self)).error.code]).toEqual([400, 'impersonate_self'])
    const admin = await start(bossCookie, OTHER_ADMIN.toUpperCase())
    expect([admin.status, (await json(admin)).error.code]).toEqual([403, 'impersonate_admin'])
    const nobody = await start(bossCookie, 'nobody@example.test')
    expect(nobody.status).toBe(404)
    expect((await start(cookieOf(member.session), BOSS)).status).toBe(404)
    for (const res of [self, admin, nobody]) expect(cookiesOf(res)[SESSION]).toBeUndefined()
    expect(await env.store.listAuditEntries(10)).toEqual([])
  })

  it('needs the browser session and its Origin: never an API key, never cross-site', async () => {
    const { boss, bossCookie } = await world()
    const viaKey = await api(env, boss.key, 'POST', '/api/admin/impersonate', { email: MEMBER })
    expect([viaKey.status, (await json(viaKey)).error.code]).toEqual([403, 'session_required'])
    const csrf = await browser(
      bossCookie,
      'POST',
      '/api/admin/impersonate',
      { email: MEMBER },
      null
    )
    expect([csrf.status, (await json(csrf)).error.code]).toEqual([403, 'csrf'])
    const evil = await browser(
      bossCookie,
      'POST',
      '/api/admin/impersonate',
      { email: MEMBER },
      'https://evil.example'
    )
    expect(evil.status).toBe(403)
    expect(await env.store.listAuditEntries(10)).toEqual([])
  })

  it('creates nothing that outlives it: no API keys, app approvals, revocations or new impersonation', async () => {
    const { bossCookie, member } = await world()
    const { cookie } = await impersonate(bossCookie)
    const keysBefore = await env.store.listApiKeys(MEMBER)

    // fling login: the CLI is sent back with an error, and no key is minted.
    const cli = await browser(
      cookie,
      'GET',
      `/auth/cli?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}&hostname=x&state=s`
    )
    expect(cli.status).toBe(302)
    const back = new URL(cli.headers.get('location') ?? '')
    expect(back.searchParams.get('error')).toBe('impersonating')
    expect(back.searchParams.get('key')).toBeNull()
    expect(await env.store.listApiKeys(MEMBER)).toEqual(keysBefore)
    expect(await env.store.listApiKeys(BOSS)).toHaveLength(1)

    // Connecting an app: the authorize step shows an error, the consent API refuses.
    const reg = await json(await register(env))
    const auth = await browser(
      cookie,
      'GET',
      authorizeUrl({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's',
        scope: 'fling',
        resource: RESOURCE,
      })
    )
    expect(auth.status).toBe(302)
    const page = new URL(auth.headers.get('location') ?? '', APP_ORIGIN)
    expect(page.pathname).toBe('/authorize')
    expect(page.searchParams.get('error')).toBe('access_denied')
    for (const path of ['/api/oauth/requests/r1/approve', '/api/oauth/requests/r1/deny']) {
      const res = await browser(cookie, 'POST', path)
      expect([res.status, (await json(res)).error.code]).toEqual([403, 'impersonating'])
    }
    expect((await browser(cookie, 'GET', '/api/oauth/requests/r1')).status).toBe(403)

    // Nor undoing what the user set up.
    const [key] = await env.store.listApiKeys(MEMBER)
    const revoke = await browser(cookie, 'DELETE', `/api/keys/${key?.id}`)
    expect([revoke.status, (await json(revoke)).error.code]).toEqual([403, 'impersonating'])
    expect((await browser(cookie, 'DELETE', '/api/connections/c1')).status).toBe(403)
    expect(await env.store.listApiKeys(MEMBER)).toEqual(keysBefore)

    // No impersonation from an impersonation, and no admin pages either.
    const again = await browser(cookie, 'POST', '/api/admin/impersonate', { email: MEMBER })
    expect([again.status, (await json(again)).error.code]).toEqual([403, 'impersonating'])
    expect((await browser(cookie, 'GET', '/api/admin/users')).status).toBe(403)
    // Listing is reading: allowed.
    expect((await browser(cookie, 'GET', '/api/keys')).status).toBe(200)
    // The user's own sessions and keys are unaffected throughout.
    expect((await api(env, member.key, 'GET', '/api/me')).status).toBe(200)
  })

  it('stops back to the admin, without signing in; both ends are audited and logged', async () => {
    const { bossCookie } = await world()
    const { cookie } = await impersonate(bossCookie)
    env.advance(5 * 60_000)
    const stop = await browser(cookie, 'POST', '/api/admin/impersonate/stop')
    expect(stop.status).toBe(200)
    const back = await json(stop)
    expect(back).toMatchObject({ email: BOSS, admin: true })
    expect(back).not.toHaveProperty('impersonator')
    const own = setSession(stop)
    expect(await json(await browser(own, 'GET', '/api/me'))).toMatchObject({
      email: BOSS,
      admin: true,
    })
    // Stopping again is a 404: nothing to stop.
    expect((await browser(own, 'POST', '/api/admin/impersonate/stop')).status).toBe(404)

    const audit = await json(await browser(own, 'GET', '/api/admin/audit'))
    expect(audit.entries).toEqual([
      {
        id: expect.any(String),
        at: '2026-01-01T00:05:00.000Z',
        action: 'impersonation.stop',
        actor: BOSS,
        target: MEMBER,
      },
      {
        id: expect.any(String),
        at: '2026-01-01T00:00:00.000Z',
        action: 'impersonation.start',
        actor: BOSS,
        target: MEMBER,
        until: '2026-01-01T01:00:00.000Z',
      },
    ])
    const lines = info.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(lines).toEqual([
      {
        level: 'info',
        msg: 'audit',
        action: 'impersonation.start',
        actor: BOSS,
        target: MEMBER,
        until: '2026-01-01T01:00:00.000Z',
      },
      { level: 'info', msg: 'audit', action: 'impersonation.stop', actor: BOSS, target: MEMBER },
    ])
    // Audit records expire after 180 days.
    const [latest] = await env.store.listAuditEntries(1)
    expect(latest?.expiresAt).toBe('2026-06-30T00:05:00.000Z')
  })

  it('lapses after 60 minutes, back to the admin; never extends the session', async () => {
    const { bossCookie } = await world()
    const { cookie } = await impersonate(bossCookie)
    env.advance(59 * 60_000)
    expect((await json(await browser(cookie, 'GET', '/api/me'))).email).toBe(MEMBER)
    env.advance(60_000)
    const me = await json(await browser(cookie, 'GET', '/api/me'))
    expect(me).toMatchObject({ email: BOSS, admin: true })
    expect(me).not.toHaveProperty('impersonator')
    // Stopping clears the leftover claim and records that it had lapsed.
    const stop = await browser(cookie, 'POST', '/api/admin/impersonate/stop')
    expect(stop.status).toBe(200)
    const [entry] = await env.store.listAuditEntries(1)
    expect(entry).toMatchObject({ action: 'impersonation.stop', lapsed: true })
    // The admin's session ends when it always would have: 7 days after signing in.
    const own = setSession(stop)
    env.advance(7 * 24 * 3600_000 - 60 * 60_000 - 1000)
    expect((await browser(own, 'GET', '/api/me')).status).toBe(200)
    env.advance(2000)
    expect((await browser(own, 'GET', '/api/me')).status).toBe(401)
    expect((await browser(cookie, 'GET', '/api/me')).status).toBe(401)
  })

  it('ends at once when the admin is no longer one', async () => {
    const { bossCookie } = await world()
    const { cookie } = await impersonate(bossCookie)
    env.config.adminEmails = [OTHER_ADMIN]
    const me = await json(await browser(cookie, 'GET', '/api/me'))
    expect(me).toMatchObject({ email: BOSS, admin: false })
    expect(me).not.toHaveProperty('impersonator')
  })

  it('sign-out ends both the impersonation and the admin session', async () => {
    const { bossCookie } = await world()
    const { cookie } = await impersonate(bossCookie)
    const out = await browser(cookie, 'POST', '/auth/logout')
    expect(out.status).toBe(200)
    expect(cookiesOf(out)[SESSION]?.raw).toMatch(/Max-Age=0/)
  })

  it('does not happen if it cannot be put on the record', async () => {
    const { bossCookie } = await world()
    vi.spyOn(env.store, 'addAuditEntry').mockRejectedValueOnce(new Error('table down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await browser(bossCookie, 'POST', '/api/admin/impersonate', { email: MEMBER })
    error.mockRestore()
    expect(res.status).toBe(500)
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
  })

  it("gives an admin nothing over other people's sites without impersonating", async () => {
    const { boss } = await world()
    expect((await api(env, boss.key, 'GET', '/api/sites/member-site')).status).toBe(404)
    expect((await api(env, boss.key, 'DELETE', '/api/sites/member-site')).status).toBe(404)
    expect(await env.store.findSite('member-site')).not.toBeNull()
  })
})
