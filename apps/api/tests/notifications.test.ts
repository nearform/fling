/**
 * The notification hub, end to end on memory adapters with a fake clock and MemoryMailer: who
 * hears about each event (never the actor, only what changed, one email per cause), preferences,
 * folding and the cool-down, retries, the daily quota, the per-recipient limit, suppression, the
 * send-time policy check, guest comments, the emails themselves, unsubscribing with Undo, and the
 * dev routes. Every drain here is a tick: the clock moves a minute, then `drain` runs.
 */
import { UNSUBSCRIBE_PATH } from '@fling/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailConfig } from '../src/config.ts'
import { drain } from '../src/notifications/drain.ts'
import { notifyComment } from '../src/notifications/notify.ts'
import {
  applyUnsubscribe,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/notifications/unsubscribe.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const MAIL: MailConfig = {
  driver: 'memory',
  from: 'fling@mail.example.test',
  fromName: 'Acme Fling',
  replyTo: 'help@example.test',
}

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const DAN = 'dan@example.test'

let logs: string[]
beforeEach(() => {
  logs = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
  }
})
afterEach(() => vi.restoreAllMocks())

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

async function person(env: Env, email: string, name: string) {
  const made = await createUser(env, email)
  await env.store.upsertUser(
    { email, name, picture: null, preferredSlug: email.split('@')[0] as string },
    env.deps.clock.now().toISOString()
  )
  return made
}

/** Alice owns `q3-report`; Bob, Carol and Dan are members. */
async function world(overrides = {}) {
  const env = setup({ mail: MAIL, instanceName: 'Acme Fling', ...overrides })
  const alice = await person(env, ALICE, 'Alice')
  const bob = await person(env, BOB, 'Bob')
  const carol = await person(env, CAROL, 'Carol')
  const dan = await person(env, DAN, 'Dan')
  await deploy(env, alice.key, 'q3-report')
  return { env, alice, bob, carol, dan }
}

/** `n` one-minute ticks: the clock moves on, then the drainer runs. */
async function tick(env: Env, n = 1) {
  for (let i = 0; i < n; i++) {
    env.advance(60_000)
    await drain(env.deps)
  }
}

/** Long enough for any event so far to fan out and its batch to go out. */
const settle = (env: Env) => tick(env, 5)

const subjects = (env: Env, to: string) => env.mailer.sentTo(to).map(m => m.message.subject)

const share = (env: Env, key: string, audience: { emails?: string[]; groups?: string[] }) =>
  api(env, key, 'PATCH', '/api/sites/q3-report', {
    audience: { emails: [], groups: [], ...audience },
  })

const comment = async (env: Env, key: string, body: object) => {
  const res = await api(env, key, 'POST', '/api/sites/q3-report/comments', body)
  expect(res.status).toBe(201)
  return json(res)
}

describe('sharing a site', () => {
  it('emails each address added, never the owner, and only what changed', async () => {
    const { env, alice } = await world()
    expect((await share(env, alice.key, { emails: [BOB, CAROL, ALICE] })).status).toBe(200)
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: Alice shared q3-report with you'])
    expect(subjects(env, CAROL)).toHaveLength(1)
    expect(subjects(env, ALICE)).toEqual([])

    // The same audience again, then someone removed: nobody hears.
    env.advance(1000)
    await share(env, alice.key, { emails: [BOB, CAROL, ALICE] })
    env.advance(1000)
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(env.mailer.sent).toHaveLength(2)

    // Adding Dan tells Dan alone.
    env.advance(1000)
    await share(env, alice.key, { emails: [BOB, DAN] })
    await settle(env)
    expect(subjects(env, DAN)).toHaveLength(1)
    expect(subjects(env, BOB)).toHaveLength(1)
  })

  it('emails a group added to the audience; someone also added directly hears once', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design team',
      members: [CAROL, DAN, ALICE],
    })
    await settle(env)
    env.mailer.clear()
    env.advance(1000)
    await share(env, alice.key, { emails: [DAN], groups: ['design'] })
    await settle(env)
    expect(subjects(env, CAROL)).toEqual(['Acme Fling: q3-report was shared with Design team'])
    expect(subjects(env, DAN)).toEqual(['Acme Fling: Alice shared q3-report with you'])
    expect(subjects(env, ALICE)).toEqual([])
    const text = env.mailer.sentTo(CAROL)[0]?.message.text ?? ''
    expect(text).toContain('Alice (alice@example.test) shared q3-report with Design team')
  })

  it('only you → an audience tells those added; only you again drops what is in flight; members tells nobody', async () => {
    const { env, alice } = await world()
    const access = (body: object) => api(env, alice.key, 'PATCH', '/api/sites/q3-report', body)
    expect((await access({ access: 'only_me' })).status).toBe(200)
    env.advance(1000)
    await access({ access: 'people', audience: { emails: [BOB] } })
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: Alice shared q3-report with you'])

    env.advance(1000)
    await access({ access: 'people', audience: { emails: [BOB, CAROL] } })
    env.advance(1000)
    await access({ access: 'only_me' })
    await settle(env)
    // Carol was added, but by the drain the site was no one's but Alice's: the item was dropped.
    expect(subjects(env, CAROL)).toEqual([])

    // Opening the site to every member, or to anyone, tells nobody.
    env.advance(1000)
    await access({ access: 'members' })
    env.advance(1000)
    await access({ access: 'public' })
    await settle(env)
    expect(env.mailer.sent).toHaveLength(1)
  })

  it('a new site published with an audience tells it once the site is live', async () => {
    const { env, alice } = await world()
    const res = await api(env, alice.key, 'POST', '/api/sites/launch/deploys', {
      manifest: { files: page.map(f => f.meta) },
      access: 'people',
      audience: { emails: [DAN] },
    })
    const body = await json(res)
    await settle(env)
    expect(subjects(env, DAN)).toEqual([])
    await upload(env, body.uploads, page)
    await api(env, alice.key, 'POST', `/api/sites/launch/deploys/${body.versionId}/finalize`)
    await settle(env)
    expect(subjects(env, DAN)).toEqual(['Acme Fling: Alice shared launch with you'])
  })

  it('drops a share the owner took back before the drain (the policy check at send time)', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, { emails: [BOB, CAROL] })
    env.advance(1000)
    await share(env, alice.key, { emails: [CAROL] })
    await settle(env)
    expect(subjects(env, BOB)).toEqual([])
    expect(subjects(env, CAROL)).toHaveLength(1)
    const [stats] = await env.store.listNotifyStats('2026-01-01T00')
    expect(stats).toMatchObject({ sent: 1, dropped: 1 })
  })

  it('drops a group share for a member who left the group before the drain', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design team',
      members: [CAROL, DAN],
    })
    await settle(env)
    env.mailer.clear()
    await share(env, alice.key, { groups: ['design'] })
    await api(env, bob.key, 'POST', '/api/groups/design/members', { remove: [DAN] })
    await settle(env)
    expect(subjects(env, CAROL)).toHaveLength(1)
    expect(subjects(env, DAN)).toEqual([])
  })

  it('notifies through the remote MCP tools as through the API', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const result = await callTool(env, accessToken, 'fling_set_audience', {
      name: 'q3-report',
      add: [BOB],
    })
    expect(result.isError).toBeFalsy()
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: Alice shared q3-report with you'])
  })
})

describe('owners and publishers', () => {
  const roles = (env: Env, key: string, body: object) =>
    api(env, key, 'PATCH', '/api/sites/q3-report', body)

  it('emails each person and group member given a role, once, and only what changed', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design team',
      members: [CAROL, DAN, ALICE],
    })
    await settle(env)
    env.mailer.clear()
    env.advance(1000)
    const res = await roles(env, alice.key, {
      owners: { emails: [ALICE, BOB] },
      publishers: { emails: [DAN], groups: ['design'] },
    })
    expect(res.status).toBe(200)
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: You are now an owner of q3-report'])
    expect(subjects(env, DAN)).toEqual(['Acme Fling: You are now a publisher of q3-report'])
    expect(subjects(env, CAROL)).toEqual(['Acme Fling: You are now a publisher of q3-report'])
    expect(subjects(env, ALICE)).toEqual([])
    const text = env.mailer.sentTo(CAROL)[0]?.message.text ?? ''
    expect(text).toContain(
      'Alice (alice@example.test) made you a publisher of q3-report through Design team'
    )
    expect(text).toContain(`${APP_ORIGIN}/sites/q3-report`)

    // The same lists again: nobody hears.
    env.mailer.clear()
    env.advance(1000)
    await roles(env, alice.key, {
      owners: { emails: [ALICE, BOB] },
      publishers: { emails: [DAN], groups: ['design'] },
    })
    await settle(env)
    expect(env.mailer.sent).toHaveLength(0)
  })

  it('drops a role taken back before the drain', async () => {
    const { env, alice } = await world()
    await roles(env, alice.key, { publishers: { emails: [BOB, CAROL] } })
    env.advance(1000)
    await roles(env, alice.key, { publishers: { emails: [CAROL] } })
    await settle(env)
    expect(subjects(env, BOB)).toEqual([])
    expect(subjects(env, CAROL)).toHaveLength(1)
  })

  it('notifies through the remote MCP tools as through the API', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const result = await callTool(env, accessToken, 'fling_set_owners', {
      name: 'q3-report',
      add: [BOB],
    })
    expect(result.isError).toBeFalsy()
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: You are now an owner of q3-report'])
  })
})

describe('groups', () => {
  it('emails the people added, on creation and later, with the sites it opens to them', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design team',
      members: [CAROL, BOB],
    })
    await settle(env)
    expect(subjects(env, CAROL)).toEqual(['Acme Fling: You were added to Design team'])
    expect(subjects(env, BOB)).toEqual([])

    await share(env, alice.key, { groups: ['design'] })
    await settle(env)
    env.mailer.clear()
    env.advance(1000)
    await api(env, bob.key, 'POST', '/api/groups/design/members', { add: [CAROL, DAN] })
    await settle(env)
    expect(subjects(env, CAROL)).toEqual([])
    const [mail] = env.mailer.sentTo(DAN)
    expect(mail?.message.subject).toBe('Acme Fling: You were added to Design team')
    expect(mail?.message.text).toContain('It opens these sites to you:')
    expect(mail?.message.text).toContain(`- q3-report: ${APP_ORIGIN}/review/q3-report`)
    expect(mail?.message.text).toContain(`${APP_ORIGIN}/groups/design`)
  })
})

describe('comments', () => {
  it('tells the owner of a new thread, and the thread of a reply, never the writer', async () => {
    const { env, alice, bob, carol, dan } = await world()
    const thread = await comment(env, bob.key, { body: 'The heading is too big', path: '/docs/' })
    await settle(env)
    expect(subjects(env, ALICE)).toEqual(['Acme Fling: Bob commented on q3-report'])
    const created = env.mailer.sentTo(ALICE)[0]?.message
    expect(created?.text).toContain('Bob (bob@example.test) commented on q3-report, on /docs/:')
    expect(created?.text).toContain('"The heading is too big"')
    expect(created?.text).toContain(
      `${APP_ORIGIN}/review/q3-report?path=%2Fdocs%2F&thread=${thread.id}`
    )
    expect(created?.text).toContain('replies to this email are not posted')

    // Carol replies: Bob (the thread's author) hears; Alice (owner, not in the thread) doesn't.
    env.mailer.clear()
    await comment(env, carol.key, { body: 'Agreed', parentId: thread.id })
    await settle(env)
    expect(subjects(env, BOB)).toEqual(['Acme Fling: Carol replied in a thread on q3-report'])
    expect(subjects(env, ALICE)).toEqual([])
    expect(subjects(env, CAROL)).toEqual([])

    // Alice replies: Bob and Carol hear, once each, as a reply (Bob after his cool-down).
    env.mailer.clear()
    await comment(env, alice.key, { body: 'Fixed', parentId: thread.id })
    await tick(env, 20)
    expect(subjects(env, BOB)).toHaveLength(1)
    expect(subjects(env, CAROL)).toHaveLength(1)
    expect(subjects(env, ALICE)).toEqual([])
    expect(subjects(env, DAN)).toEqual([])

    // The owner's own thread tells nobody.
    env.mailer.clear()
    await comment(env, alice.key, { body: 'Note to self' })
    await settle(env)
    expect(env.mailer.sent).toEqual([])
    expect(dan).toBeDefined()
  })

  it('tells every owner of a new thread, owner groups included, never the writer or a publisher', async () => {
    const { env, alice, bob, carol } = await world()
    await api(env, alice.key, 'POST', '/api/groups', { slug: 'ops', name: 'Ops', members: [CAROL] })
    const roles = await api(env, alice.key, 'PATCH', '/api/sites/q3-report', {
      owners: { emails: [ALICE, BOB], groups: ['ops'] },
      publishers: { emails: [DAN] },
    })
    expect(roles.status).toBe(200)
    await settle(env)
    env.mailer.clear()
    await comment(env, bob.key, { body: 'Ready to go' })
    await settle(env)
    expect(subjects(env, ALICE)).toEqual(['Acme Fling: Bob commented on q3-report'])
    expect(subjects(env, CAROL)).toEqual(['Acme Fling: Bob commented on q3-report'])
    expect(subjects(env, BOB)).toEqual([])
    expect(subjects(env, DAN)).toEqual([])
    expect(carol).toBeDefined()
  })

  it('folds a burst into one email, then waits out the cool-down', async () => {
    const { env, bob, carol } = await world()
    await comment(env, bob.key, { body: 'One' })
    env.advance(20_000)
    await comment(env, carol.key, { body: 'Two' })
    env.advance(20_000)
    await comment(env, bob.key, { body: 'Three' })
    await settle(env)
    expect(subjects(env, ALICE)).toEqual(['Acme Fling: Bob and Carol left 3 comments on q3-report'])
    const sentAt = env.deps.clock.now().getTime()

    await comment(env, carol.key, { body: 'Four' })
    await settle(env)
    expect(subjects(env, ALICE)).toHaveLength(1)
    // Not before 15 minutes after the first email.
    while (subjects(env, ALICE).length < 2) await tick(env)
    const [, second] = env.mailer.sentTo(ALICE)
    expect((second?.sentAt.getTime() ?? 0) - sentAt).toBeGreaterThanOrEqual(15 * 60_000)
    expect(second?.message.subject).toBe('Acme Fling: Carol commented on q3-report')
  })

  it("a guest's comment carries neither name nor excerpt", async () => {
    const { env } = await world()
    const site = await env.store.findSite('q3-report')
    if (!site) throw new Error('no site')
    const now = env.deps.clock.now().toISOString()
    const record = {
      siteId: site.id,
      id: 'guest-comment-1',
      parentId: null,
      path: '/',
      versionId: site.currentVersionId,
      anchor: null,
      body: 'Visit https://evil.example and log in',
      author: { kind: 'guest' as const, name: 'Totally Alice' },
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    }
    await env.store.createComment(record)
    await notifyComment(env.deps, site, record)
    await settle(env)
    const [mail] = env.mailer.sentTo(ALICE)
    expect(mail?.message.subject).toBe('Acme Fling: A guest commented on q3-report')
    for (const part of [mail?.message.text, mail?.message.html]) {
      expect(part).not.toContain('evil.example')
      expect(part).not.toContain('Totally Alice')
    }
  })

  it('drops a comment deleted before the drain', async () => {
    const { env, bob } = await world()
    const thread = await comment(env, bob.key, { body: 'Oops' })
    await api(env, bob.key, 'DELETE', `/api/sites/q3-report/comments/${thread.id}`)
    await settle(env)
    expect(env.mailer.sent).toEqual([])
  })

  it('drops comment emails once the site is restricted to others', async () => {
    const { env, alice, bob } = await world()
    await comment(env, bob.key, { body: 'Hello' })
    const thread = await comment(env, alice.key, { body: 'Mine' })
    await comment(env, bob.key, { body: 'Reply', parentId: thread.id })
    await settle(env)
    env.mailer.clear()
    await comment(env, alice.key, { body: 'Again', parentId: thread.id })
    await share(env, alice.key, { emails: [CAROL] })
    await settle(env)
    // Bob may no longer read the comments: his reply notification is dropped.
    expect(subjects(env, BOB)).toEqual([])
  })
})

describe('the recipient decides', () => {
  it('a cell turned off or muted stops that email; defaults apply otherwise', async () => {
    const { env, alice, bob } = await world()
    await env.store.putNotificationPreferences(
      BOB,
      { muted: false, cells: { 'site.shared': { email: 'off' } } },
      env.deps.clock.now().toISOString(),
      null
    )
    await env.store.putNotificationPreferences(
      CAROL,
      { muted: true, cells: {} },
      env.deps.clock.now().toISOString(),
      null
    )
    await share(env, alice.key, { emails: [BOB, CAROL, DAN] })
    await settle(env)
    expect(subjects(env, BOB)).toEqual([])
    expect(subjects(env, CAROL)).toEqual([])
    expect(subjects(env, DAN)).toHaveLength(1)
    // Bob still hears of comments on his own threads.
    const thread = await comment(env, bob.key, { body: 'Hi' })
    await comment(env, alice.key, { body: 'Hello', parentId: thread.id })
    await settle(env)
    expect(subjects(env, BOB)).toHaveLength(1)
  })

  it('an address the instance no longer admits is dropped', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, { emails: [BOB] })
    env.deps.config.allowedEmailDomains = ['elsewhere.test']
    await settle(env)
    expect(env.mailer.sent).toEqual([])
  })

  it('a suppressed address gets nothing', async () => {
    const { env, alice } = await world()
    await env.store.putSuppression({ email: BOB, kind: 'bounce', at: '2026-01-01T00:00:00.000Z' })
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(env.mailer.sent).toEqual([])
    const [stats] = await env.store.listNotifyStats('2026-01-01T00')
    expect(stats?.suppressed).toBe(1)
  })
})

describe('delivery', () => {
  it('retries a transient failure with backoff, then sends', async () => {
    const { env, alice } = await world()
    env.mailer.failNext(
      { ok: false, retry: true, reason: 'transient' },
      { ok: false, retry: true, reason: 'throttled' }
    )
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(subjects(env, BOB)).toEqual([])
    // 1 minute after the first failure, then 5 after the second.
    await tick(env, 12)
    expect(subjects(env, BOB)).toHaveLength(1)
    const failures = await env.store.listNotifyFailures(10)
    expect(failures.map(f => f.reason).sort()).toEqual(['throttled', 'transient'])
  })

  it('gives up after six attempts', async () => {
    const { env, alice } = await world()
    const fail = { ok: false as const, retry: true, reason: 'transient' as const }
    env.mailer.failNext(fail, fail, fail, fail, fail, fail, fail)
    await share(env, alice.key, { emails: [BOB] })
    // Backoff of 1, 5, 15, 60 and 60 minutes, each a tick or two behind.
    await tick(env, 5 + 1 + 5 + 15 + 60 + 60 + 15)
    expect(env.mailer.sent).toEqual([])
    const stats = await env.store.listNotifyStats('2026-01-01T00')
    expect(stats.reduce((n, s) => n + s.givenUp, 0)).toBe(1)
    expect(logs.some(l => l.includes('notification given up'))).toBe(true)
    // Nothing is left to send.
    await tick(env, 70)
    expect(env.mailer.sent).toEqual([])
  })

  it('the daily quota moves the batch to the next UTC day without using an attempt', async () => {
    const { env, alice } = await world()
    env.mailer.failNext({ ok: false, retry: true, reason: 'throttled', quota: true })
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(env.mailer.sent).toEqual([])
    const due = await env.store.listDueNotifications('2026-01-02T00:00')
    expect(due.batches).toEqual([expect.objectContaining({ email: BOB, attempts: 0 })])
    expect(logs.some(l => l.includes('daily sending quota'))).toBe(true)
  })

  it('a provider rejection drops the batch and logs an error; suppression is remembered', async () => {
    const { env, alice } = await world()
    env.mailer.failNext(
      { ok: false, retry: false, reason: 'rejected', detail: 'E_SENDER_NOT_VERIFIED' },
      { ok: false, retry: false, reason: 'suppressed' }
    )
    await share(env, alice.key, { emails: [BOB, CAROL] })
    await settle(env)
    expect(env.mailer.sent).toEqual([])
    expect(logs.some(l => l.includes('check the mail setup'))).toBe(true)
    const suppressed = await Promise.all([BOB, CAROL].map(e => env.store.getSuppression(e)))
    expect(suppressed.filter(Boolean)).toHaveLength(1)
  })

  it('holds a recipient to 10 emails an hour: the batch moves to the next hour', async () => {
    const { env, alice } = await world()
    for (let i = 0; i < 10; i++) await env.store.countRecipientSend(BOB, '2026-01-01T00')
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(env.mailer.sent).toEqual([])
    while (env.deps.clock.now() < new Date('2026-01-01T01:05:00Z')) await tick(env)
    expect(subjects(env, BOB)).toHaveLength(1)
  })

  it('stops at the instance limit and goes on at the next tick', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, { emails: [BOB, CAROL, DAN] })
    await tick(env, 3)
    env.advance(60_000)
    const first = await drain(env.deps, { perMinute: 1 })
    expect(first).toMatchObject({ sent: 1, complete: false })
    for (let i = 0; i < 6; i++) {
      env.advance(60_000)
      await drain(env.deps, { perMinute: 1 })
    }
    expect(env.mailer.sent).toHaveLength(3)
  })

  it('logs batches and hashed recipients, never an address or a comment body', async () => {
    const { env, alice, bob } = await world()
    await share(env, alice.key, { emails: [BOB] })
    await comment(env, bob.key, { body: 'Secret plans' })
    env.mailer.failNext({ ok: false, retry: true, reason: 'transient' })
    await settle(env)
    await tick(env, 3)
    const notifyLogs = logs.filter(l => l.includes('"msg"'))
    expect(notifyLogs.some(l => l.includes('notification sent'))).toBe(true)
    for (const line of notifyLogs) {
      expect(line).not.toMatch(/@example\.test/)
      expect(line).not.toContain('Secret plans')
    }
  })

  it('the email: sender, Reply-To from config, unsubscribe headers, escaped values', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', {
      slug: 'odd',
      name: '<b>Odd</b> & "co"',
      members: [CAROL],
    })
    await settle(env)
    const [mail] = env.mailer.sentTo(CAROL)
    const m = mail?.message
    expect(m?.from).toEqual({ address: MAIL.from, name: 'Acme Fling' })
    expect(m?.replyTo).toBe('help@example.test')
    expect(m?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    const unsubscribe = /^<(.+)>$/.exec(m?.headers['List-Unsubscribe'] ?? '')?.[1] ?? ''
    expect(unsubscribe.startsWith(`${APP_ORIGIN}${UNSUBSCRIBE_PATH}?t=`)).toBe(true)
    expect(m?.html).toContain('&lt;b&gt;Odd&lt;/b&gt; &amp; &quot;co&quot;')
    expect(m?.html).not.toContain('<b>Odd</b>')
    expect(m?.tags).toEqual(['group.member_added'])
    // The NSENT record names what went out.
    const [sent] = await env.store.listSentNotifications(CAROL, 5)
    expect(sent).toMatchObject({ eventKeys: ['group.member_added'], subject: m?.subject })
    expect(alice).toBeDefined()
  })
})

describe('the drainer under failure', () => {
  it('never sends again when the bookkeeping after a send fails', async () => {
    const { env, alice } = await world()
    const count = vi
      .spyOn(env.store, 'countRecipientSend')
      .mockRejectedValueOnce(new Error('table unavailable'))
    const finishBatch = vi
      .spyOn(env.store, 'finishNotificationBatch')
      .mockRejectedValueOnce(new Error('table unavailable'))
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(count).toHaveBeenCalled()
    expect(subjects(env, BOB)).toHaveLength(1)
    // The batch is still leased, marked sent: once the lease runs out, a drain finishes it.
    await tick(env, 10)
    expect(finishBatch.mock.calls.length).toBeGreaterThan(1)
    expect(subjects(env, BOB)).toHaveLength(1)
    expect(await env.store.listSentNotifications(BOB, 10)).toHaveLength(1)
    expect(await env.store.listPendingNotifications(BOB, 'email', null)).toEqual([])
    expect(await env.store.listNotifyFailures(10)).toEqual([])
    expect(logs.some(l => l.includes('finishing a sent batch failed'))).toBe(true)
    // Nothing is left to send, and the cursor went on.
    await tick(env, 10)
    expect(subjects(env, BOB)).toHaveLength(1)
    expect(await env.store.getNotifyCursor()).toBe('2026-01-01T00:23')
  })

  it('a give-up deletes only what it loaded, never what was queued since', async () => {
    const { env, alice } = await world()
    const fail = { ok: false as const, retry: true, reason: 'transient' as const }
    env.mailer.failNext(fail, fail, fail, fail, fail, fail)
    const send = env.mailer.send.bind(env.mailer)
    let calls = 0
    vi.spyOn(env.mailer, 'send').mockImplementation(async message => {
      if (++calls === 6) {
        // Queued while the last attempt is in flight (the batch is leased, so a new one opens).
        const [item] = await env.store.listPendingNotifications(BOB, 'email', null)
        if (!item) throw new Error('nothing pending')
        const { expiresAt: _, ...rest } = item
        await env.store.queueNotification(
          {
            ...rest,
            eventId: `${item.eventId}-later`,
            createdAt: env.deps.clock.now().toISOString(),
          },
          '2026-01-01T03:00'
        )
      }
      return send(message)
    })
    await share(env, alice.key, { emails: [BOB] })
    await tick(env, 5 + 1 + 5 + 15 + 60 + 60 + 15)
    expect(logs.some(l => l.includes('notification given up'))).toBe(true)
    const left = await env.store.listPendingNotifications(BOB, 'email', null)
    expect(left.map(p => p.eventId)).toEqual([expect.stringMatching(/-later$/)])
    while (env.deps.clock.now() < new Date('2026-01-01T03:05:00Z')) await tick(env)
    expect(subjects(env, BOB)).toHaveLength(1)
  })

  it('a provider-reported suppression lapses after 30 days', async () => {
    const { env, alice } = await world()
    env.mailer.failNext({ ok: false, retry: false, reason: 'suppressed' })
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    const suppression = await env.store.getSuppression(BOB)
    expect(suppression?.expiresAt).toBe(
      new Date(Date.parse(suppression?.at ?? '') + 30 * 86_400_000).toISOString()
    )
    env.advance(30 * 86_400_000)
    expect(await env.store.getSuppression(BOB)).toBeNull()
  })
})

describe('fan-outs', () => {
  const members = Array.from(
    { length: 30 },
    (_, i) => `m${String(i).padStart(2, '0')}@example.test`
  )

  /** A drain where every queued notification takes a second of (fake) wall time. */
  async function slowDrain(env: Env, budgetMs: number) {
    let wall = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const queue = env.store.queueNotification.bind(env.store)
    const spy = vi.spyOn(env.store, 'queueNotification').mockImplementation(async (...args) => {
      wall += 1000
      return queue(...args)
    })
    try {
      return await drain(env.deps, { deadline: wall + budgetMs })
    } finally {
      vi.mocked(Date.now).mockRestore()
      spy.mockRestore()
    }
  }

  it('one out of time moves on with its progress; nobody is skipped or told twice', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', { slug: 'big', name: 'Big', members })
    await settle(env)
    env.mailer.clear()
    const sharedAt = env.deps.clock.now().toISOString().slice(0, 16)
    await share(env, alice.key, { groups: ['big'], emails: [CAROL] })
    env.advance(2 * 60_000)
    // 20 s of budget: fan-outs get 10 s, so about ten recipients per drain.
    const first = await slowDrain(env, 20_000)
    expect(first.queued).toBeGreaterThan(0)
    expect(first.queued).toBeLessThan(members.length)
    // The event's minute is done: the cursor passed it.
    expect(first.cursor).toBe(sharedAt)
    // Someone early in address order leaves the group: nobody after them is skipped.
    await api(env, bob.key, 'POST', '/api/groups/big/members', { remove: ['m00@example.test'] })
    for (let i = 0; i < 6; i++) {
      env.advance(60_000)
      await slowDrain(env, 20_000)
    }
    await settle(env)
    for (const m of members.slice(1)) expect(subjects(env, m)).toHaveLength(1)
    // The direct share went out meanwhile, not held up by the fan-out.
    expect(subjects(env, CAROL)).toHaveLength(1)
  })

  it('one that keeps failing is given up after five attempts, and holds nothing up', async () => {
    const { env, alice, bob } = await world()
    await api(env, bob.key, 'POST', '/api/groups', { slug: 'big', name: 'Big', members })
    await settle(env)
    env.mailer.clear()
    vi.spyOn(env.store, 'listGroupMembers').mockRejectedValue(new Error('table unavailable'))
    await share(env, alice.key, { groups: ['big'], emails: [CAROL] })
    await settle(env)
    expect(subjects(env, CAROL)).toHaveLength(1)
    await tick(env, 1 + 5 + 15 + 60 + 60 + 10)
    const failed = logs.filter(l => l.includes('"fan-out failed"'))
    expect(failed).toHaveLength(4)
    expect(logs.filter(l => l.includes('"fan-out given up"'))).toHaveLength(1)
    for (const line of logs.filter(l => l.includes('fan-out'))) {
      expect(line).not.toMatch(/@example\.test/)
    }
    // The marker is gone: nothing more is tried.
    await tick(env, 120)
    expect(logs.filter(l => l.includes('fan-out'))).toHaveLength(5)
  })
})

describe('when notify records nothing', () => {
  it('without a mail channel', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    await deploy(env, alice.key, 'q3-report')
    await share(env, alice.key, { emails: [BOB] })
    expect(await env.store.listDueNotifications('2026-01-01T00:00')).toEqual({
      fanOuts: [],
      batches: [],
    })
    expect(await drain(env.deps)).toMatchObject({ sent: 0, minutes: 0 })
  })

  it('while an admin impersonates the actor', async () => {
    const { env } = await world({ adminEmails: ['boss@example.test'] })
    const boss = await createUser(env, 'boss@example.test')
    const cookie = `__Host-fling_session=${boss.session}`
    const start = await env.app.request('/api/admin/impersonate', {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: ALICE }),
    })
    expect(start.status).toBe(200)
    const session = /__Host-fling_session=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1]
    const res = await env.app.request('/api/sites/q3-report', {
      method: 'PATCH',
      headers: {
        cookie: `__Host-fling_session=${session}`,
        origin: APP_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ audience: { emails: [BOB], groups: [] } }),
    })
    expect(res.status).toBe(200)
    await settle(env)
    expect(env.mailer.sent).toEqual([])
  })
})

describe('unsubscribing', () => {
  const secret = 's'.repeat(40)

  it('tokens name the address, event and channel, and only verify with our secret', () => {
    const target = { email: BOB, event: 'comment.created' as const, channel: 'email' as const }
    const token = signUnsubscribeToken(secret, target)
    expect(verifyUnsubscribeToken(secret, token)).toEqual(target)
    expect(verifyUnsubscribeToken('x'.repeat(40), token)).toBeNull()
    const [body, mac] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ e: CAROL, k: 'comment.created', c: 'email' }))
    expect(verifyUnsubscribeToken(secret, `${forged.toString('base64url')}.${mac}`)).toBeNull()
    expect(verifyUnsubscribeToken(secret, `${body}.`)).toBeNull()
    expect(verifyUnsubscribeToken(secret, 'nonsense')).toBeNull()
  })

  it('GET shows the page and changes nothing; POST unsubscribes; Undo reverts', async () => {
    const { env, alice } = await world()
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    const link = /^<(.+)>$/.exec(
      env.mailer.sentTo(BOB)[0]?.message.headers['List-Unsubscribe'] ?? ''
    )?.[1]
    const path = (link ?? '').slice(APP_ORIGIN.length)

    const shown = await env.app.request(path)
    expect(shown.status).toBe(200)
    const html = await shown.text()
    expect(html).toContain('someone shares a site with you')
    expect(shown.headers.get('content-security-policy')).toContain("style-src 'unsafe-inline'")
    expect(await env.store.getNotificationPreferences(BOB)).toBeNull()

    // The mail client's one-click POST.
    const oneClick = await env.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    })
    expect(oneClick.status).toBe(200)
    expect(await oneClick.text()).toContain('Undo')
    expect((await env.store.getNotificationPreferences(BOB))?.cells).toEqual({
      'site.shared': { email: 'off' },
    })
    env.advance(1000)
    await share(env, alice.key, { emails: [] })
    env.advance(1000)
    await share(env, alice.key, { emails: [BOB] })
    await settle(env)
    expect(subjects(env, BOB)).toHaveLength(1)

    const undo = await env.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=event&undo=1',
    })
    expect(undo.status).toBe(200)
    expect((await env.store.getNotificationPreferences(BOB))?.cells).toEqual({})

    // Stop all, and undo that.
    await env.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=all',
    })
    expect((await env.store.getNotificationPreferences(BOB))?.muted).toBe(true)
    await env.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=all&undo=1',
    })
    expect((await env.store.getNotificationPreferences(BOB))?.muted).toBe(false)
  })

  it('Undo puts back what the stop replaced, muted or a cell already off', async () => {
    const { env } = await world()
    const token = signUnsubscribeToken(env.config.secrets.sessionSecret, {
      email: BOB,
      event: 'site.shared',
      channel: 'email',
    })
    const post = async (body: string) => {
      const res = await env.app.request(`${UNSUBSCRIBE_PATH}?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
      return res.text()
    }
    /** The Undo form's fields, as the page renders them. */
    const undoOf = (html: string) =>
      [...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)]
        .map(([, k, v]) => `${k}=${v}`)
        .join('&')
    await env.store.putNotificationPreferences(
      BOB,
      { muted: true, cells: { 'site.shared': { email: 'off' } } },
      env.deps.clock.now().toISOString(),
      null
    )
    await post(undoOf(await post('scope=all')))
    expect(await env.store.getNotificationPreferences(BOB)).toMatchObject({ muted: true })
    await post(undoOf(await post('scope=event')))
    expect((await env.store.getNotificationPreferences(BOB))?.cells).toEqual({
      'site.shared': { email: 'off' },
    })
  })

  it('a one-click unsubscribe and a settings save made at once both hold', async () => {
    const { env, bob } = await world()
    const read = env.store.getNotificationPreferences.bind(env.store)
    vi.spyOn(env.store, 'getNotificationPreferences').mockImplementationOnce(async email => {
      const before = await read(email)
      // The unsubscribe lands between the save's read and its write.
      await applyUnsubscribe(
        env.deps,
        { email: BOB, event: 'site.shared', channel: 'email' },
        { scope: 'event', undo: false }
      )
      return before
    })
    const res = await api(env, bob.key, 'PUT', '/api/me/notifications', {
      cells: { 'comment.created': { email: 'off' } },
    })
    expect(res.status).toBe(200)
    expect((await env.store.getNotificationPreferences(BOB))?.cells).toEqual({
      'site.shared': { email: 'off' },
      'comment.created': { email: 'off' },
    })
  })

  it('answers every invalid token with the same neutral page, changing nothing', async () => {
    const { env } = await world()
    const forged = signUnsubscribeToken('x'.repeat(40), {
      email: BOB,
      event: 'site.shared',
      channel: 'email',
    })
    const pages = await Promise.all(
      [forged, 'nonsense', ''].map(async t => {
        const get = await env.app.request(`${UNSUBSCRIBE_PATH}?t=${t}`)
        const post = await env.app.request(`${UNSUBSCRIBE_PATH}?t=${t}`, { method: 'POST' })
        return [get.status, await get.text(), post.status, await post.text()]
      })
    )
    expect(new Set(pages.map(p => JSON.stringify(p))).size).toBe(1)
    expect(await env.store.getNotificationPreferences(BOB)).toBeNull()
  })
})

describe('dev routes', () => {
  it('exist only with the dev login on', async () => {
    const { env } = await world()
    expect((await env.app.request('/dev/notify/drain', { method: 'POST' })).status).toBe(404)
    expect((await env.app.request('/dev/mail')).status).toBe(404)
  })

  it('drain now, including what is due within the hour, and list what was sent', async () => {
    const { env, alice, bob } = await world({ devLogin: true })
    await share(env, alice.key, { emails: [BOB] })
    const res = await env.app.request('/dev/notify/drain', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ sent: 1 })
    const listed = await json(
      await env.app.request('/dev/mail', { headers: { accept: 'application/json' } })
    )
    expect(listed.messages).toEqual([
      expect.objectContaining({ to: BOB, subject: 'Acme Fling: Alice shared q3-report with you' }),
    ])
    const one = await env.app.request(`/dev/mail/${listed.messages[0].id}`)
    expect(await one.text()).toContain('q3-report')
    const page = await (await env.app.request('/dev/mail')).text()
    expect(page).toContain('action="/dev/notify/drain"')
    const posted = await env.app.request('/dev/notify/drain', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(posted.status).toBe(303)
    expect(posted.headers.get('location')).toBe('/dev/mail')
    // The cursor stays behind the clock, so what happens next is still drained.
    await comment(env, bob.key, { body: 'Later' })
    await settle(env)
    expect(subjects(env, ALICE)).toHaveLength(1)
  })
})
