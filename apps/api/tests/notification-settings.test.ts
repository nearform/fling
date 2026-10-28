/**
 * The clients' side of notifications: a person's settings and what was sent to them (the API and
 * both MCP tools on the remote server), refused while impersonating; and the admins' mail page
 * (settings, health, the test email and its hourly limit). Without a channel none of it exists.
 */
import { MAIL_TESTS_PER_HOUR } from '@fling/shared'
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
import { callTool, connect, rpc, SESSION } from './oauth-helpers.ts'

const MAIL: MailConfig = {
  driver: 'memory',
  from: 'fling@mail.example.test',
  fromName: 'Acme Fling',
  replyTo: 'help@example.test',
  sesConfigurationSet: 'transactional',
}
const ALICE = 'alice@example.test'
const BOSS = 'boss@example.test'
const BOB = 'bob@example.test'
const page = [file('index.html', '<h1>hi</h1>')]

async function deploy(env: Env, key: string, name: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
  })
  const body = await json(res)
  await upload(env, body.uploads, page)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {})
  }
})
afterEach(() => vi.restoreAllMocks())

function browser(env: Env, session: string, method: string, path: string, body?: unknown) {
  return env.app.request(path, {
    method,
    headers: {
      cookie: `${SESSION}=${session}`,
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function world(overrides = {}) {
  const env = setup({ mail: MAIL, instanceName: 'Acme Fling', adminEmails: [BOSS], ...overrides })
  const alice = await createUser(env, ALICE)
  const boss = await createUser(env, BOSS)
  return { env, alice, boss }
}

describe('my notification settings', () => {
  it('lists the catalogue with effective values, and changes cells and muted', async () => {
    const { env, alice } = await world()
    const got = await json(await api(env, alice.key, 'GET', '/api/me/notifications'))
    expect(got.channels).toEqual(['email'])
    expect(got.muted).toBe(false)
    expect(got.overrides).toEqual({})
    for (const e of got.events) expect(got.cells[e.key]).toEqual({ email: e.defaults.email })

    const put = await api(env, alice.key, 'PUT', '/api/me/notifications', {
      cells: { 'comment.created': { email: 'off' } },
    })
    expect(put.status).toBe(200)
    const after = await json(put)
    expect(after.cells['comment.created']).toEqual({ email: 'off' })
    expect(after.overrides).toEqual({ 'comment.created': { email: 'off' } })

    const muted = await json(
      await api(env, alice.key, 'PUT', '/api/me/notifications', { muted: true })
    )
    expect(muted.muted).toBe(true)
    expect(Object.values(muted.cells).every((c: any) => c.email === 'off')).toBe(true)
    expect(muted.overrides).toEqual({ 'comment.created': { email: 'off' } })

    // null: back to the default.
    const reset = await json(
      await api(env, alice.key, 'PUT', '/api/me/notifications', {
        muted: false,
        cells: { 'comment.created': { email: null } },
      })
    )
    expect(reset.overrides).toEqual({})
    expect(reset.cells['comment.created']).toEqual({ email: 'on' })
  })

  it('refuses events and channels the catalogue does not have', async () => {
    const { env, alice } = await world()
    for (const cells of [
      { 'site.exploded': { email: 'off' } },
      { 'site.shared': { pigeon: 'on' } },
    ]) {
      const res = await api(env, alice.key, 'PUT', '/api/me/notifications', { cells })
      expect(res.status).toBe(400)
    }
  })

  it('lists only the events the instance has: no comment events without comments', async () => {
    const { env, alice } = await world({ comments: false })
    const got = await json(await api(env, alice.key, 'GET', '/api/me/notifications'))
    expect(got.events.some((e: { section: string }) => e.section === 'comments')).toBe(false)
    expect(got.events.length).toBeGreaterThan(0)
  })

  it('lists what was sent to me, newest first: events, subject, provider id and when', async () => {
    const { env, alice } = await world()
    const bob = await createUser(env, BOB)
    for (const name of ['q3-report', 'q4-report']) {
      await deploy(env, bob.key, name)
      const res = await api(env, bob.key, 'PATCH', `/api/sites/${name}`, {
        audience: { emails: [ALICE], groups: [] },
      })
      expect(res.status).toBe(200)
      for (let i = 0; i < 5; i++) {
        env.advance(60_000)
        await drain(env.deps)
      }
    }
    const { sent } = await json(await api(env, alice.key, 'GET', '/api/me/notifications/sent'))
    expect(sent).toEqual([
      expect.objectContaining({
        channel: 'email',
        eventKeys: ['site.shared'],
        subject: expect.stringContaining('q4-report'),
        providerId: 'memory-2',
      }),
      expect.objectContaining({ subject: expect.stringContaining('q3-report') }),
    ])
    expect(Date.parse(sent[0].sentAt)).toBeGreaterThan(Date.parse(sent[1].sentAt))
    // Only mine.
    expect(await json(await api(env, bob.key, 'GET', '/api/me/notifications/sent'))).toEqual({
      sent: [],
    })
  })

  it('cannot be changed while an admin impersonates the user, only read', async () => {
    const { env, boss } = await world()
    const start = await browser(env, boss.session, 'POST', '/api/admin/impersonate', {
      email: ALICE,
    })
    expect(start.status).toBe(200)
    const session = cookiesOf(start)[SESSION]?.value ?? ''
    expect((await browser(env, session, 'GET', '/api/me/notifications')).status).toBe(200)
    const put = await browser(env, session, 'PUT', '/api/me/notifications', { muted: true })
    expect(put.status).toBe(403)
    expect((await json(put)).error.code).toBe('impersonating')
    expect(await env.store.getNotificationPreferences(ALICE)).toBeNull()
  })

  it('does not exist without a channel', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    for (const [method, path, body] of [
      ['GET', '/api/me/notifications'],
      ['PUT', '/api/me/notifications', { muted: true }],
      ['GET', '/api/me/notifications/sent'],
    ] as const) {
      expect((await api(env, alice.key, method, path, body)).status).toBe(404)
    }
  })
})

describe('the notification MCP tools', () => {
  it('read and change the settings, as the API does', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const read = await callTool(env, accessToken, 'fling_notifications', {})
    expect(read.isError).toBeFalsy()
    expect(read.content[0]?.text).toContain('comment.created')
    expect(read.structuredContent.channels).toEqual(['email'])

    const set = await callTool(env, accessToken, 'fling_notifications_set', {
      cells: [{ event: 'comment.reply', channel: 'email', value: 'off' }],
    })
    expect(set.isError).toBeFalsy()
    expect(set.structuredContent.overrides).toEqual({ 'comment.reply': { email: 'off' } })
    expect(set.content[0]?.text).toContain('email off (yours)')

    const back = await callTool(env, accessToken, 'fling_notifications_set', {
      cells: [{ event: 'comment.reply', channel: 'email', value: 'default' }],
      muted: true,
    })
    expect(back.structuredContent).toMatchObject({ muted: true, overrides: {} })
    const none = await callTool(env, accessToken, 'fling_notifications_set', {})
    expect(none.isError).toBe(true)
  })

  it('are not offered without a channel', async () => {
    const env = setup()
    await createUser(env, ALICE)
    const { accessToken } = await connect(env, ALICE)
    const list = await json(await rpc(env, accessToken, 'tools/list'))
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).not.toContain('fling_notifications')
    expect(names).toContain('fling_whoami')
  })
})

describe('the admin mail page', () => {
  it('is a 404 to anyone who is not an admin, and without email', async () => {
    const { env, alice } = await world()
    expect((await browser(env, alice.session, 'GET', '/api/admin/mail')).status).toBe(404)
    const test = await browser(env, alice.session, 'POST', '/api/admin/mail/test', { to: ALICE })
    expect(test.status).toBe(404)

    const off = setup({ adminEmails: [BOSS] })
    const boss = await createUser(off, BOSS)
    expect((await browser(off, boss.session, 'GET', '/api/admin/mail')).status).toBe(404)
  })

  it('shows the settings, the last 24 hours and recent failures: no recipients, no content', async () => {
    const { env, boss } = await world()
    const now = env.deps.clock.now()
    const hour = now.toISOString().slice(0, 13)
    const old = new Date(now.getTime() - 30 * 3_600_000).toISOString().slice(0, 13)
    await env.store.addNotifyStats(hour, { sent: 3, retrying: 1 })
    await env.store.addNotifyStats(old, { sent: 100 })
    await env.store.addNotifyFailure({
      at: now.toISOString(),
      batchId: 'email#b1',
      eventKeys: ['site.shared'],
      reason: 'rejected',
      detail: 'E_SENDER_NOT_VERIFIED',
    })
    const res = await browser(env, boss.session, 'GET', '/api/admin/mail')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.config).toEqual({
      driver: 'memory',
      from: MAIL.from,
      fromName: 'Acme Fling',
      replyTo: 'help@example.test',
      configurationSet: 'transactional',
    })
    expect(body.health.totals).toMatchObject({ sent: 3, retrying: 1, givenUp: 0 })
    expect(body.health.hours).toEqual([expect.objectContaining({ hour, sent: 3 })])
    expect(body.health.failures).toEqual([
      {
        at: now.toISOString(),
        batchId: 'email#b1',
        eventKeys: ['site.shared'],
        reason: 'rejected',
        detail: 'E_SENDER_NOT_VERIFIED',
      },
    ])
    expect(body.tests).toEqual({ remaining: MAIL_TESTS_PER_HOUR, limit: MAIL_TESTS_PER_HOUR })
    // An admin's key may read it.
    expect((await api(env, boss.key, 'GET', '/api/admin/mail')).status).toBe(200)
  })

  it('sends a branded test email to any address, straight to the mailer', async () => {
    const { env, boss } = await world()
    const outside = 'checker@deliverability.example'
    const res = await browser(env, boss.session, 'POST', '/api/admin/mail/test', { to: outside })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ ok: true, providerId: 'memory-1', subject: 'Acme Fling: Test email' })
    const [mail] = env.mailer.sentTo(outside)
    expect(mail?.message).toMatchObject({
      from: { address: MAIL.from, name: 'Acme Fling' },
      replyTo: 'help@example.test',
      tags: ['mail.test'],
    })
    expect(mail?.message.text).toContain(`sent by ${BOSS}`)
    expect(mail?.message.text).not.toContain('Choose what you hear about')
    expect(mail?.message.html).toContain('Acme Fling')
    // Nothing went through the outbox.
    expect(await env.store.listSentNotifications(outside, 10)).toEqual([])
    const after = await json(await browser(env, boss.session, 'GET', '/api/admin/mail'))
    expect(after.tests.remaining).toBe(MAIL_TESTS_PER_HOUR - 1)
  })

  it('says why the provider refused, in words', async () => {
    const { env, boss } = await world()
    env.mailer.failNext({
      ok: false,
      retry: false,
      reason: 'rejected',
      detail: 'E_SENDER_NOT_VERIFIED',
    })
    const body = await json(
      await browser(env, boss.session, 'POST', '/api/admin/mail/test', { to: ALICE })
    )
    expect(body).toEqual({
      ok: false,
      reason: 'rejected',
      detail: 'E_SENDER_NOT_VERIFIED',
      error: 'rejected: sender not verified',
    })
    const bad = await browser(env, boss.session, 'POST', '/api/admin/mail/test', { to: 'nope' })
    expect(bad.status).toBe(400)
  })

  it(`allows ${MAIL_TESTS_PER_HOUR} an hour per admin`, async () => {
    const { env, boss } = await world()
    const send = () => browser(env, boss.session, 'POST', '/api/admin/mail/test', { to: ALICE })
    for (let i = 0; i < MAIL_TESTS_PER_HOUR; i++) expect((await send()).status).toBe(200)
    const over = await send()
    expect(over.status).toBe(429)
    expect((await json(over)).error.code).toBe('too_many_tests')
    expect(env.mailer.sent).toHaveLength(MAIL_TESTS_PER_HOUR)
    env.advance(3_600_000)
    expect((await send()).status).toBe(200)
  })

  it('sends only from the browser session, never with a key or while impersonating', async () => {
    const { env, boss } = await world()
    const byKey = await api(env, boss.key, 'POST', '/api/admin/mail/test', { to: ALICE })
    expect(byKey.status).toBe(403)
    expect((await json(byKey)).error.code).toBe('session_required')
    const start = await browser(env, boss.session, 'POST', '/api/admin/impersonate', {
      email: ALICE,
    })
    const session = cookiesOf(start)[SESSION]?.value ?? ''
    const res = await browser(env, session, 'POST', '/api/admin/mail/test', { to: ALICE })
    expect(res.status).toBe(403)
    expect(env.mailer.sent).toEqual([])
  })
})
