/**
 * Invitations (invitations.ts): sharing with someone outside the email policy invites them as a
 * guest (only an address newly added, at most INVITES_PER_DAY a day per person), admins invite
 * members, list and revoke; every invitation and revocation is audited. The share's email carries
 * an invited newcomer's sign-in link, minted at send time, and the drain mails only people with
 * standing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailConfig } from '../src/config.ts'
import { drain } from '../src/notifications/drain.ts'
import {
  APP_ORIGIN,
  api,
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
}
const BOSS = 'boss@example.test'
const ALICE = 'alice@example.test'
const PAT = 'pat@outside.test'
const SAM = 'sam@outside.test'

let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => info.mockRestore())

const page = [file('index.html', '<h1>hi</h1>')]

async function deploy(env: Env, key: string, name: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
    access: 'members',
  })
  const body = await json(res)
  await upload(env, body.uploads, page)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

/** Alice (a member) owns q3-report and q4-report; Boss is an admin. Invitations on, with mail. */
async function world(overrides = {}) {
  const env = setup({
    mail: MAIL,
    invites: true,
    invitesPerDay: 20,
    instanceName: 'Acme Fling',
    adminEmails: [BOSS],
    ...overrides,
  })
  const alice = await createUser(env, ALICE)
  const boss = await createUser(env, BOSS)
  await deploy(env, alice.key, 'q3-report')
  await deploy(env, alice.key, 'q4-report')
  return { env, alice, boss, bossCookie: `${SESSION}=${boss.session}` }
}

const share = (env: Env, key: string, name: string, emails: string[]) =>
  api(env, key, 'PATCH', `/api/sites/${name}`, { audience: { emails, groups: [] } })

/** Cookie-authenticated request from the app's origin (an admin's browser). */
function browser(env: Env, cookie: string, method: string, path: string, body?: unknown) {
  return env.app.request(path, {
    method,
    headers: {
      cookie,
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function auditOf(env: Env, cookie: string) {
  return (await json(await browser(env, cookie, 'GET', '/api/admin/audit'))).entries as {
    action: string
    actor: string
    target: string
    via?: string
    role?: string
  }[]
}

/** Long enough for every event so far to fan out and its batch to go out. */
async function settle(env: Env) {
  for (let i = 0; i < 5; i++) {
    env.advance(60_000)
    await drain(env.deps)
  }
}

const tokenIn = (text: string | undefined) =>
  text?.match(/\/auth\/link\?t=([A-Za-z0-9_-]{43})/)?.[1] ?? null

const verify = (env: Env, token: string) =>
  env.app.request('/auth/link/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APP_ORIGIN },
    body: new URLSearchParams({ t: token }).toString(),
  })

describe('inviting by sharing', () => {
  it('an outsider named in an audience gets a guest invitation, audited, and standing', async () => {
    const { env, alice, bossCookie } = await world()
    const res = await share(env, alice.key, 'q3-report', [PAT])
    expect(res.status).toBe(200)
    expect(await env.store.getInvitation(PAT)).toMatchObject({
      email: PAT,
      role: 'guest',
      invitedBy: ALICE,
      via: 'share',
    })
    expect(await auditOf(env, bossCookie)).toContainEqual(
      expect.objectContaining({
        action: 'invitation.create',
        actor: ALICE,
        target: PAT,
        via: 'share',
        role: 'guest',
      })
    )
    const pat = await createUser(env, PAT)
    const me = await json(await api(env, pat.key, 'GET', '/api/me'))
    expect(me.email).toBe(PAT)
  })

  it('adding an outsider to a group invites them as a guest, at creation and later', async () => {
    const { env, alice } = await world()
    const made = await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'reviewers',
      name: 'Reviewers',
      members: [PAT],
    })
    expect(made.status).toBe(201)
    expect(await env.store.getInvitation(PAT)).toMatchObject({ role: 'guest', via: 'group' })
    const added = await api(env, alice.key, 'POST', '/api/groups/reviewers/members', {
      add: [SAM],
    })
    expect(added.status).toBe(200)
    expect(await env.store.getInvitation(SAM)).toMatchObject({
      role: 'guest',
      via: 'group',
      invitedBy: ALICE,
    })
  })

  it('marks guests where people are listed: a site audience and a group', async () => {
    const { env, alice, bossCookie } = await world()
    const res = await share(env, alice.key, 'q3-report', [PAT, 'bob@example.test'])
    const emails = (await json(res)).audience.emails as { email: string; guest?: boolean }[]
    expect(emails.find(e => e.email === PAT)?.guest).toBe(true)
    expect(emails.find(e => e.email === 'bob@example.test')?.guest).toBeUndefined()
    await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'reviewers',
      name: 'Reviewers',
      members: [PAT, 'bob@example.test'],
    })
    const detail = await json(await api(env, alice.key, 'GET', '/api/groups/reviewers'))
    expect(detail.members).toContainEqual({ email: PAT, known: false, guest: true })
    expect(detail.members).toContainEqual({ email: 'bob@example.test', known: false })
    // An admin's invitation makes them a member, who is not marked.
    await browser(env, bossCookie, 'POST', '/api/admin/invitations', { email: PAT })
    const site = await json(await api(env, alice.key, 'GET', '/api/sites/q3-report'))
    expect(site.audience.emails).toContainEqual({ email: PAT, known: false })
  })

  it('saving an audience again re-invites nobody; adding the address anew does', async () => {
    const { env, alice, bossCookie } = await world()
    expect((await share(env, alice.key, 'q3-report', [PAT])).status).toBe(200)
    expect((await browser(env, bossCookie, 'DELETE', `/api/admin/invitations/${PAT}`)).status).toBe(
      200
    )
    // The same audience again, and with someone else added: PAT stays revoked.
    expect((await share(env, alice.key, 'q3-report', [PAT])).status).toBe(200)
    expect((await share(env, alice.key, 'q3-report', [PAT, 'bob@example.test'])).status).toBe(200)
    expect((await env.store.getInvitation(PAT))?.revokedAt).toBeDefined()
    expect(
      await env.store.invitationsOn(ALICE, env.deps.clock.now().toISOString().slice(0, 10))
    ).toBe(1)
    // Named anew on another site: invited again.
    expect((await share(env, alice.key, 'q4-report', [PAT])).status).toBe(200)
    const again = await env.store.getInvitation(PAT)
    expect(again?.revokedAt).toBeUndefined()
    expect(again?.role).toBe('guest')
  })

  it(`past INVITES_PER_DAY new outside addresses a day: 429 too_many_invites, nothing changed`, async () => {
    const { env, alice } = await world({ invitesPerDay: 2 })
    expect((await share(env, alice.key, 'q3-report', [PAT, SAM])).status).toBe(200)
    const res = await share(env, alice.key, 'q4-report', ['kim@outside.test'])
    expect(res.status).toBe(429)
    expect((await json(res)).error.code).toBe('too_many_invites')
    expect(await env.store.getInvitation('kim@outside.test')).toBeNull()
    expect((await env.store.findSite('q4-report'))?.audience.emails).toEqual([])
    // Addresses already invited cost nothing, and members never count.
    expect((await share(env, alice.key, 'q4-report', [PAT, 'bob@example.test'])).status).toBe(200)
    // The next day, the count starts again.
    env.advance(24 * 3_600_000)
    expect((await share(env, alice.key, 'q4-report', ['kim@outside.test'])).status).toBe(200)
  })

  it('with invitations off, an outside address is a 400 email_not_allowed, as for groups', async () => {
    const { env, alice } = await world({ invites: false })
    const res = await share(env, alice.key, 'q3-report', [PAT])
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('email_not_allowed')
    const group = await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'outsiders',
      name: 'Outsiders',
      members: [PAT],
    })
    expect(group.status).toBe(400)
    expect(await env.store.getInvitation(PAT)).toBeNull()
  })

  it('an admin impersonating someone invites nobody: 403 impersonating, nothing saved', async () => {
    const { env, bossCookie } = await world()
    const started = await browser(env, bossCookie, 'POST', '/api/admin/impersonate', {
      email: ALICE,
    })
    expect(started.status).toBe(200)
    const as = `${SESSION}=${cookiesOf(started)[SESSION]?.value}`
    const res = await browser(env, as, 'PATCH', '/api/sites/q3-report', {
      audience: { emails: [PAT], groups: [] },
    })
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe('impersonating')
    const group = await browser(env, as, 'POST', '/api/groups', {
      slug: 'outsiders',
      name: 'Outsiders',
      members: [PAT],
    })
    expect(group.status).toBe(403)
    expect((await json(group)).error.code).toBe('impersonating')
    expect(await env.store.getInvitation(PAT)).toBeNull()
    expect((await env.store.findSite('q3-report'))?.audience.emails).toEqual([])
  })

  it('an admin impersonating someone may name a guest invited already, inviting nobody new', async () => {
    const { env, alice, bossCookie } = await world()
    expect((await share(env, alice.key, 'q4-report', [PAT])).status).toBe(200)
    const invited = await env.store.getInvitation(PAT)
    const started = await browser(env, bossCookie, 'POST', '/api/admin/impersonate', {
      email: ALICE,
    })
    const as = `${SESSION}=${cookiesOf(started)[SESSION]?.value}`
    const res = await browser(env, as, 'PATCH', '/api/sites/q3-report', {
      audience: { emails: [PAT], groups: [] },
    })
    expect(res.status).toBe(200)
    expect(await env.store.getInvitation(PAT)).toEqual(invited)
  })
})

describe('admin invitations', () => {
  it('an admin invites a member: the email at once, with a 7-day sign-in link that works', async () => {
    const { env, bossCookie } = await world()
    const res = await browser(env, bossCookie, 'POST', '/api/admin/invitations', { email: SAM })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body).toMatchObject({
      sent: true,
      error: null,
      invitation: { email: SAM, role: 'member', invitedBy: BOSS, via: 'admin', signedIn: false },
    })
    const [mail] = env.mailer.sentTo(SAM)
    expect(mail?.message.subject).toBe(`Acme Fling: ${BOSS} invited you to Acme Fling`)
    expect(mail?.message.text).toContain('within 7 days')
    const token = tokenIn(mail?.message.text)
    expect(token).toBeTruthy()
    const signedIn = await verify(env, token as string)
    expect(signedIn.status).toBe(303)
    expect(cookiesOf(signedIn)[SESSION]).toBeDefined()
    const list = await json(await browser(env, bossCookie, 'GET', '/api/admin/invitations'))
    expect(list.invitations).toEqual([
      expect.objectContaining({ email: SAM, role: 'member', signedIn: true, revokedAt: null }),
    ])
  })

  it('upgrades a guest to a member, and nothing demotes them', async () => {
    const { env, alice, bossCookie } = await world()
    await share(env, alice.key, 'q3-report', [PAT])
    expect((await env.store.getInvitation(PAT))?.role).toBe('guest')
    await browser(env, bossCookie, 'POST', '/api/admin/invitations', { email: PAT })
    expect((await env.store.getInvitation(PAT))?.role).toBe('member')
    await share(env, alice.key, 'q4-report', [PAT])
    await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'later',
      name: 'Later',
      members: [PAT],
    })
    expect((await env.store.getInvitation(PAT))?.role).toBe('member')
    const audit = await auditOf(env, bossCookie)
    expect(audit.filter(e => e.action === 'invitation.create' && e.target === PAT)).toHaveLength(2)
  })

  it('revoking cuts access on the next request, and is audited', async () => {
    const { env, alice, bossCookie } = await world()
    await share(env, alice.key, 'q3-report', [PAT])
    const pat = await createUser(env, PAT)
    expect((await api(env, pat.key, 'GET', '/api/me')).status).toBe(200)
    const res = await browser(env, bossCookie, 'DELETE', `/api/admin/invitations/${PAT}`)
    expect(res.status).toBe(200)
    expect((await json(res)).revokedAt).toEqual(expect.any(String))
    expect((await api(env, pat.key, 'GET', '/api/me')).status).toBe(401)
    expect(await auditOf(env, bossCookie)).toContainEqual(
      expect.objectContaining({ action: 'invitation.revoke', actor: BOSS, target: PAT })
    )
    expect(
      (await browser(env, bossCookie, 'DELETE', '/api/admin/invitations/nobody@outside.test'))
        .status
    ).toBe(404)
  })

  it('the Users list marks guests', async () => {
    const { env, alice, bossCookie } = await world()
    await share(env, alice.key, 'q3-report', [PAT])
    await createUser(env, PAT)
    const users = (await json(await browser(env, bossCookie, 'GET', '/api/admin/users'))).users as {
      email: string
      guest: boolean
    }[]
    expect(users.find(u => u.email === PAT)?.guest).toBe(true)
    expect(users.find(u => u.email === ALICE)?.guest).toBe(false)
  })

  it('who may: admins list (tokens too); inviting and revoking need the browser session', async () => {
    const { env, alice, boss, bossCookie } = await world()
    expect((await api(env, boss.key, 'GET', '/api/admin/invitations')).status).toBe(200)
    const byKey = await api(env, boss.key, 'POST', '/api/admin/invitations', { email: SAM })
    expect(byKey.status).toBe(403)
    expect((await json(byKey)).error.code).toBe('session_required')
    expect((await api(env, boss.key, 'DELETE', `/api/admin/invitations/${SAM}`)).status).toBe(403)
    for (const [method, path] of [
      ['GET', '/api/admin/invitations'],
      ['POST', '/api/admin/invitations'],
      ['DELETE', `/api/admin/invitations/${SAM}`],
    ] as const) {
      const res = await browser(
        env,
        `${SESSION}=${alice.session}`,
        method,
        path,
        method === 'POST' ? { email: SAM } : undefined
      )
      expect(res.status).toBe(404)
    }
    const inside = await browser(env, bossCookie, 'POST', '/api/admin/invitations', {
      email: ALICE,
    })
    expect(inside.status).toBe(400)
    expect((await json(inside)).error.code).toBe('already_admitted')
  })

  it('answer 404 with invitations off', async () => {
    const { env, bossCookie } = await world({ invites: false })
    expect((await browser(env, bossCookie, 'GET', '/api/admin/invitations')).status).toBe(404)
    const res = await browser(env, bossCookie, 'POST', '/api/admin/invitations', { email: SAM })
    expect(res.status).toBe(404)
  })
})

describe("the share's email to someone invited", () => {
  it('carries a sign-in link that works, back to the review page; members get none', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, 'q3-report', [PAT, 'bob@example.test'])
    await settle(env)
    const [mail] = env.mailer.sentTo(PAT)
    expect(mail?.message.subject).toBe('Acme Fling: Alice shared q3-report with you')
    expect(mail?.message.text).toContain("You've been invited to Acme Fling as a reviewer")
    const token = tokenIn(mail?.message.text)
    expect(token).toBeTruthy()
    // The token itself is stored nowhere: only its hash.
    const items = (env.table as unknown as { items: Map<string, Map<string, unknown>> }).items
    const stored = JSON.stringify([...items.values()].flatMap(part => [...part.values()]))
    expect(stored).not.toContain(token)
    const res = await verify(env, token as string)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/review/q3-report`)
    // A member inside the policy signs in at the issuer: no link.
    const [bob] = env.mailer.sentTo('bob@example.test')
    expect(tokenIn(bob?.message.text)).toBeNull()
  })

  it('someone invited who has signed in before gets the usual email', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, 'q3-report', [PAT])
    await settle(env)
    await createUser(env, PAT)
    await share(env, alice.key, 'q4-report', [PAT])
    await settle(env)
    const second = env.mailer.sentTo(PAT).at(-1)
    expect(second?.message.subject).toContain('q4-report')
    expect(tokenIn(second?.message.text)).toBeNull()
  })

  it('is dropped once the invitation is revoked', async () => {
    const { env, alice, bossCookie } = await world()
    await share(env, alice.key, 'q3-report', [PAT])
    await browser(env, bossCookie, 'DELETE', `/api/admin/invitations/${PAT}`)
    await settle(env)
    expect(env.mailer.sentTo(PAT)).toEqual([])
  })
})
