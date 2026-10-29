/**
 * Sign-in links (auth/sign-in-link.ts, `/auth/link`): asking for one never says who is invited,
 * opening one takes nothing (mail scanners open every link), and only the confirm page's form
 * POST signs in, once, while the address still has standing.
 */
import { INSTANCE_METADATA_PATH } from '@fling/shared'
import { SITE_COOKIE_NAME, verifySiteCookie } from '@fling/shared/site-cookie'
import { describe, expect, it } from 'vitest'
import {
  INVITATION_LINK_TTL_SECONDS,
  mintSignInLink,
  SIGN_IN_LINK_TTL_SECONDS,
  SIGN_IN_LINKS_PER_HOUR,
  SIGN_IN_LINKS_PER_MINUTE,
  signInLinkHash,
} from '../src/auth/sign-in-link.ts'
import type { MailConfig } from '../src/config.ts'
import {
  APP_ORIGIN,
  cookiesOf,
  createUser,
  type Env,
  file,
  json,
  setup,
  upload,
} from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const MAIL: MailConfig = {
  driver: 'memory',
  from: 'fling@mail.example.test',
  fromName: 'Acme Fling',
  sesConfigurationSet: 'transactional',
}
const PAT = 'pat@outside.test'
const GUEST = 'guest@outside.test'

const world = (overrides = {}) =>
  setup({ mail: MAIL, invites: true, instanceName: 'Acme Fling', ...overrides })

const invite = (env: Env, email: string, role: 'member' | 'guest' = 'member') =>
  env.store.putInvitation({
    email,
    role,
    invitedBy: 'alice@example.test',
    via: role === 'member' ? 'admin' : 'share',
    createdAt: env.deps.clock.now().toISOString(),
  })

const ask = (env: Env, body: object, origin: string | null = APP_ORIGIN) =>
  env.app.request('/auth/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })

const open = (env: Env, token: string) => env.app.request(`/auth/link?t=${token}`)

const verify = (env: Env, token: string, origin: string | null = APP_ORIGIN) =>
  env.app.request('/auth/link/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams({ t: token }).toString(),
  })

/** The token in the last email to `to`, or null when none came. */
function tokenMailedTo(env: Env, to: string): string | null {
  const mail = env.mailer.sentTo(to).at(-1)
  const match = mail?.message.text.match(/\/auth\/link\?t=([A-Za-z0-9_-]{43})/)
  return match?.[1] ?? null
}

/** Ask for a link as `email` and return the token mailed for it. */
async function linkFor(env: Env, email: string, ret?: string) {
  const res = await ask(env, { email, ...(ret ? { return: ret } : {}) })
  expect(res.status).toBe(202)
  const token = tokenMailedTo(env, email)
  if (!token) throw new Error(`no link mailed to ${email}`)
  return token
}

describe('asking for a link', () => {
  it('is on with INVITES, and advertised as the invites capability', async () => {
    const on = await (await world().app.request(INSTANCE_METADATA_PATH)).json()
    expect(on.capabilities.invites).toBe(true)
    const env = world({ invites: false })
    const off = await (await env.app.request(INSTANCE_METADATA_PATH)).json()
    expect(off.capabilities.invites).toBe(false)
    expect((await ask(env, { email: PAT })).status).toBe(404)
  })

  it('answers 202 whatever the address, and mails only an invited one', async () => {
    const env = world()
    await invite(env, PAT)
    // An unknown address, one the policy admits (it signs in at the issuer), a guest no audience
    // names: 202 and nothing sent.
    await invite(env, GUEST, 'guest')
    for (const email of ['nobody@outside.test', 'alice@example.test', GUEST]) {
      const res = await ask(env, { email })
      expect({ email, status: res.status, body: await res.text() }).toEqual({
        email,
        status: 202,
        body: '',
      })
    }
    expect(env.mailer.sent).toHaveLength(0)
    const res = await ask(env, { email: 'Pat@Outside.test ' })
    expect(res.status).toBe(202)
    const [mail] = env.mailer.sentTo(PAT)
    expect(mail?.message.subject).toBe('Acme Fling: Your sign-in link')
    expect(mail?.message.tags).toEqual(['auth.link'])
    expect(mail?.message.text).toContain(`sign in to Acme Fling as ${PAT}`)
    expect(mail?.message.text).toContain('within 15 minutes')
    // Only the token's hash is kept.
    const token = tokenMailedTo(env, PAT) as string
    expect(await env.store.getSignInLink(signInLinkHash(token))).toMatchObject({ email: PAT })
    expect(JSON.stringify((await env.table.scan()).items)).not.toContain(token)
  })

  it('refuses a cross-origin request and a malformed address', async () => {
    const env = world()
    expect((await ask(env, { email: PAT }, 'https://evil.test')).status).toBe(403)
    expect((await ask(env, { email: PAT }, null)).status).toBe(403)
    expect((await ask(env, { email: 'not an address' })).status).toBe(400)
  })

  it(`sends at most ${SIGN_IN_LINKS_PER_HOUR} an hour to one address, still answering 202`, async () => {
    const env = world()
    await invite(env, PAT)
    for (let i = 0; i < SIGN_IN_LINKS_PER_HOUR + 2; i++) {
      expect((await ask(env, { email: PAT })).status).toBe(202)
    }
    expect(env.mailer.sentTo(PAT)).toHaveLength(SIGN_IN_LINKS_PER_HOUR)
    env.advance(60 * 60 * 1000)
    await ask(env, { email: PAT })
    expect(env.mailer.sentTo(PAT)).toHaveLength(SIGN_IN_LINKS_PER_HOUR + 1)
  })

  it(`sends at most ${SIGN_IN_LINKS_PER_MINUTE} a minute for the instance`, async () => {
    const env = world()
    const people = Array.from(
      { length: SIGN_IN_LINKS_PER_MINUTE + 1 },
      (_, i) => `p${i}@outside.test`
    )
    for (const email of people) await invite(env, email)
    for (const email of people) expect((await ask(env, { email })).status).toBe(202)
    expect(env.mailer.sent).toHaveLength(SIGN_IN_LINKS_PER_MINUTE)
    env.advance(60 * 1000)
    await ask(env, { email: people.at(-1) as string })
    expect(env.mailer.sent).toHaveLength(SIGN_IN_LINKS_PER_MINUTE + 1)
  })
})

describe('opening a link', () => {
  it('takes nothing: every GET lands on the confirm page, the token in the fragment', async () => {
    const env = world()
    await invite(env, PAT)
    const token = await linkFor(env, PAT)
    for (let i = 0; i < 3; i++) {
      const res = await open(env, token)
      expect(res.status).toBe(302)
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      const location = new URL(res.headers.get('location') ?? '', APP_ORIGIN)
      expect(location.pathname).toBe('/sign-in/link')
      expect(location.search).toBe('')
      const hash = new URLSearchParams(location.hash.slice(1))
      expect({ t: hash.get('t'), email: hash.get('email') }).toEqual({ t: token, email: PAT })
      expect(cookiesOf(res)[SESSION]).toBeUndefined()
    }
    expect((await verify(env, token)).headers.get('location')).toBe('/')
  })

  it('sends a broken, used, expired or uninvited link to the login page with what is wrong', async () => {
    const env = world()
    await invite(env, PAT)
    const login = async (res: Response) => res.headers.get('location')
    expect(await login(await open(env, 'short'))).toBe('/login?error=link_expired')
    const used = await linkFor(env, PAT)
    await verify(env, used)
    expect(await login(await open(env, used))).toBe('/login?error=link_used')
    const old = await linkFor(env, PAT)
    env.advance(SIGN_IN_LINK_TTL_SECONDS * 1000 + 1)
    expect(await login(await open(env, old))).toBe('/login?error=link_expired')
    const revoked = await linkFor(env, PAT)
    await env.store.revokeInvitation(PAT, env.deps.clock.now().toISOString())
    expect(await login(await open(env, revoked))).toBe('/login?error=not_invited')
  })
})

describe('signing in with a link', () => {
  it('signs in once, and goes where the link was going', async () => {
    const env = world()
    await invite(env, PAT)
    const token = await linkFor(env, PAT, '/sites/docs')
    const res = await verify(env, token)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/sites/docs`)
    const cookies = cookiesOf(res)
    const me = await env.app.request('/api/me', {
      headers: { cookie: `${SESSION}=${cookies[SESSION]?.value}` },
    })
    expect(await json(me)).toMatchObject({ email: PAT })
    expect(await env.store.getUser(PAT)).not.toBeNull()
    const again = await verify(env, token)
    expect(again.status).toBe(303)
    expect(again.headers.get('location')).toBe('/login?error=link_used')
    expect(cookiesOf(again)[SESSION]).toBeUndefined()
  })

  it('only from the app itself (a form POST carries its Origin)', async () => {
    const env = world()
    await invite(env, PAT)
    const token = await linkFor(env, PAT)
    expect((await verify(env, token, 'https://evil.test')).status).toBe(403)
    expect((await verify(env, token, null)).status).toBe(403)
    // Refused before anything was taken.
    expect((await verify(env, token)).status).toBe(303)
    expect(env.mailer.sentTo(PAT)).toHaveLength(1)
  })

  it('not once it has expired', async () => {
    const env = world()
    await invite(env, PAT)
    const token = await linkFor(env, PAT)
    env.advance(SIGN_IN_LINK_TTL_SECONDS * 1000 + 1)
    expect((await verify(env, token)).headers.get('location')).toBe('/login?error=link_expired')
    expect((await verify(env, 'x'.repeat(43))).headers.get('location')).toBe(
      '/login?error=link_expired'
    )
  })

  it('not once the invitation is revoked, or invitations are turned off', async () => {
    const env = world()
    await invite(env, PAT)
    const revoked = await linkFor(env, PAT)
    await env.store.revokeInvitation(PAT, env.deps.clock.now().toISOString())
    const res = await verify(env, revoked)
    expect(res.headers.get('location')).toBe('/login?error=not_invited')
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
    expect(await env.store.getUser(PAT)).toBeNull()

    await invite(env, PAT)
    const off = await linkFor(env, PAT)
    env.config.invites = false
    expect((await verify(env, off)).headers.get('location')).toBe('/login?error=not_invited')
  })

  it('goes back only to the app or a site: any other return becomes the home page', async () => {
    const env = world()
    await invite(env, PAT)
    const cases: [string, string][] = [
      ['https://evil.test/x', '/'],
      ['//evil.test/x', '/'],
      ['/\\evil.test', '/'],
      ['/groups', `${APP_ORIGIN}/groups`],
      ['https://hello.fling.test/page', 'https://hello.fling.test/page'],
    ]
    for (const [ret, expected] of cases) {
      const token = await linkFor(env, PAT, ret)
      expect({ ret, location: (await verify(env, token)).headers.get('location') }).toEqual({
        ret,
        location: expected,
      })
      env.advance(60 * 60 * 1000) // past the hourly limit
    }
  })

  it("a guest's session carries the guest site cookie", async () => {
    const env = world()
    const owner = await createUser(env)
    await deployPage(env, owner.key, 'docs')
    await invite(env, GUEST, 'guest')
    await shareWith(env, 'docs', [GUEST])
    const token = await linkFor(env, GUEST, 'https://docs.fling.test/')
    const res = await verify(env, token)
    // A restricted site that names them: on through the site pass.
    expect(res.headers.get('location')).toMatch(/^https:\/\/docs\.fling\.test\/_fling-pass\?t=/)
    const site = verifySiteCookie(
      cookiesOf(res)[SITE_COOKIE_NAME]?.value ?? '',
      env.config.secrets.siteHmacKey,
      Math.floor(env.deps.clock.now().getTime() / 1000)
    )
    expect(site).toEqual({ e: GUEST, x: expect.any(Number), g: 1 })
  })

  it('a minted invitation link lasts 7 days and signs in the same way', async () => {
    const env = world()
    await invite(env, PAT)
    const link = await mintSignInLink(env.deps, {
      email: PAT,
      return: '/',
      ttlSeconds: INVITATION_LINK_TTL_SECONDS,
    })
    expect(link.url).toBe(`${APP_ORIGIN}/auth/link?t=${link.token}`)
    expect(link.hash).toBe(signInLinkHash(link.token))
    env.advance((INVITATION_LINK_TTL_SECONDS - 60) * 1000)
    expect((await verify(env, link.token)).headers.get('location')).toBe(`${APP_ORIGIN}/`)
  })
})

const page = [file('index.html', '<h1>hi</h1>')]

async function deployPage(env: Env, key: string, name: string) {
  const res = await env.app.request(`/api/sites/${name}/deploys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { files: page.map(f => f.meta) } }),
  })
  const body = await json(res)
  await upload(env, body.uploads, page)
  await env.app.request(`/api/sites/${name}/deploys/${body.versionId}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
  })
}

/** Name `emails` in the site's audience, straight in the store (outside addresses included). */
async function shareWith(env: Env, name: string, emails: string[]) {
  const site = await env.store.findSite(name)
  if (!site) throw new Error(`no site ${name}`)
  await env.store.putSite({
    ...site,
    restricted: true,
    audience: { emails, groups: [] },
    updatedAt: env.deps.clock.now().toISOString(),
  })
}
