/**
 * The archive policy (archive-policy.ts), on memory adapters with a fake clock: off unless an
 * operator sets it, paused while views aren't counted (and until they have been for long enough),
 * warn first always (going live with overdue sites included), archive → delete → purge, only what
 * the policy archived is deleted, an instance without mail archives but never deletes, the keep
 * flag, activity resetting it all, dry run doing nothing but the preview, notifications recorded
 * once, the switch (a browser session's), purging never touching what is live, and the dev clock.
 */
import { ARCHIVE_POLICY_ACTOR, siteKvsKey } from '@fling/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { policyRun } from '../src/archive-policy.ts'
import { signSession } from '../src/auth/session.ts'
import { deletedKey } from '../src/blobs/types.ts'
import { type Config, loadBaseConfig, type MailConfig } from '../src/config.ts'
import { buildDeps } from '../src/deps.ts'
import { DevClock, devClock } from '../src/lib/dev-clock.ts'
import { maintain } from '../src/maintenance.ts'
import { drain } from '../src/notifications/drain.ts'
import type { DeletedSiteRecord, SiteRecord } from '../src/store/types.ts'
import { bucketExpiry } from '../src/views.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect, rpc, SESSION } from './oauth-helpers.ts'

const DAY = 86_400_000
const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const BOSS = 'boss@example.test'
const MAIL: MailConfig = { driver: 'memory', from: 'fling@mail.example.test', fromName: 'Acme' }
const POLICY = { inactiveDays: 30, warnDays: 7, deleteArchivedDays: 20, purgeDeletedDays: 10 }

beforeEach(() => {
  for (const level of ['log', 'warn', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {})
  }
})
afterEach(() => vi.restoreAllMocks())

let env: Env
let alice: Awaited<ReturnType<typeof createUser>>
let boss: Awaited<ReturnType<typeof createUser>>

async function start(overrides: Partial<Config> = {}) {
  env = setup({ adminEmails: [BOSS], mail: MAIL, archivePolicy: POLICY, ...overrides })
  alice = await createUser(env, ALICE)
  boss = await createUser(env, BOSS)
}

const page = (text = 'hi') => [file('index.html', `<h1>${text}</h1>`)]

async function deploy(key: string, name: string, text = 'hi') {
  const files = page(text)
  const staged = await json(
    await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
      manifest: { files: files.map(f => f.meta) },
    })
  )
  if (staged.status === 'upload') {
    await upload(env, staged.uploads, files)
    const done = await api(
      env,
      key,
      'POST',
      `/api/sites/${name}/deploys/${staged.versionId}/finalize`
    )
    expect(done.status).toBe(200)
  }
}

/** A browser session of `email`, signed now (the clock moves on by weeks here). */
async function browser(email: string, method: string, path: string, body?: unknown) {
  const session = await signSession(email, env.config.secrets.sessionSecret, env.deps.clock.now())
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

const goLive = async (live = true) =>
  expect((await browser(BOSS, 'PUT', '/api/admin/archive-policy', { live })).status).toBe(200)
const status = async () => json(await api(env, boss.key, 'GET', '/api/admin/archive-policy'))
const days = (n: number) => env.advance(n * DAY)
const run = () => maintain(env.deps)
const site = async (name: string) => (await env.store.findSite(name)) as SiteRecord
const detail = async (name: string) => json(await api(env, alice.key, 'GET', `/api/sites/${name}`))

/** Every notification due so far fanned out and sent. */
async function sendMail() {
  // The drain walks a few hours a call: enough calls to catch up on the days skipped.
  for (let i = 0; i < 40; i++) {
    env.advance(60_000)
    await drain(env.deps)
  }
}
const subjects = (to = ALICE) => env.mailer.sentTo(to).map(m => m.message.subject)

const view = async (name: string) => {
  const now = env.deps.clock.now()
  await env.store.addSiteCounts((await site(name)).id, now, { views: 1 }, bucketExpiry(now))
}

const policyAudit = async () =>
  (await env.store.listAuditEntries(100)).filter(e => e.actor === ARCHIVE_POLICY_ACTOR)

/** `old`, published now, then 40 days without a view: overdue (30 days), counting long enough. */
async function overdue(name = 'old') {
  await deploy(alice.key, name)
  await run()
  days(40)
}

describe('off by default', () => {
  it('does nothing, advertises nothing, and has no keep flag or switch', async () => {
    await start({
      archivePolicy: { ...POLICY, inactiveDays: 0, deleteArchivedDays: 0, purgeDeletedDays: 0 },
    })
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.archivePolicy).toBe(false)
    await deploy(alice.key, 'old')
    await run()
    days(400)
    await run()
    expect((await site('old')).archived).toBe(false)
    expect((await detail('old')).archiveDue).toBeUndefined()
    expect((await api(env, alice.key, 'PUT', '/api/sites/old/keep', { keep: true })).status).toBe(
      404
    )
    const sw = await browser(BOSS, 'PUT', '/api/admin/archive-policy', { live: true })
    expect([sw.status, (await json(sw)).error.code]).toEqual([400, 'archive_policy_off'])
    expect((await status()).on).toBe(false)
  })

  it('is off in a fresh config: every day setting 0, warnings 7 days', () => {
    const cfg = loadBaseConfig({ APP_ORIGIN, SITES_DOMAIN: 'fling.test' })
    expect(cfg.archivePolicy).toEqual({
      inactiveDays: 0,
      warnDays: 7,
      deleteArchivedDays: 0,
      purgeDeletedDays: 0,
    })
  })

  it('refuses to start on settings that contradict each other, naming the variable', () => {
    const load = (env: Record<string, string>) => () =>
      loadBaseConfig({ APP_ORIGIN, SITES_DOMAIN: 'fling.test', ...env })
    expect(load({ ARCHIVE_INACTIVE_DAYS: '7' })).toThrow(
      /ARCHIVE_WARN_DAYS \(7\) must be less than ARCHIVE_INACTIVE_DAYS/
    )
    expect(load({ ARCHIVE_INACTIVE_DAYS: '30', ARCHIVE_WARN_DAYS: '0' })).toThrow(
      /ARCHIVE_WARN_DAYS must be at least 1/
    )
    expect(load({ DELETE_ARCHIVED_DAYS: '30' })).toThrow(
      /DELETE_ARCHIVED_DAYS needs ARCHIVE_INACTIVE_DAYS/
    )
    expect(load({ ARCHIVE_INACTIVE_DAYS: '30', DELETE_ARCHIVED_DAYS: '5' })).toThrow(
      /must be less than DELETE_ARCHIVED_DAYS/
    )
    expect(load({ ARCHIVE_INACTIVE_DAYS: '-1' })).toThrow(/ARCHIVE_INACTIVE_DAYS/)
    expect(load({ PURGE_DELETED_DAYS: 'soon' })).toThrow(/PURGE_DELETED_DAYS/)
    expect(load({ PURGE_DELETED_DAYS: '30' })().archivePolicy.purgeDeletedDays).toBe(30)
  })
})

describe('paused while views are not counted', () => {
  it('without view counts on the instance: nothing is warned or archived, ever', async () => {
    await start({ viewCounts: false })
    await overdue()
    await goLive()
    await run()
    days(100)
    await run()
    expect((await status()).paused).toEqual({ reason: 'view_counts_off' })
    expect((await site('old')).archived).toBe(false)
    expect((await site('old')).policyWarning).toBeUndefined()
  })

  it('while an admin has counting off, and until it has been back on for the inactive days', async () => {
    await start()
    await deploy(alice.key, 'old')
    await goLive()
    await run()
    expect(
      (await browser(BOSS, 'PUT', '/api/admin/usage/view-counting', { on: false })).status
    ).toBe(200)
    days(40)
    await run()
    expect((await status()).paused).toEqual({ reason: 'counting_off' })
    expect((await site('old')).policyWarning).toBeUndefined()
    expect(
      (await browser(BOSS, 'PUT', '/api/admin/usage/view-counting', { on: true })).status
    ).toBe(200)
    await run()
    const until = new Date(env.deps.clock.now().getTime() + 30 * DAY).toISOString()
    expect((await status()).paused).toEqual({ reason: 'counting_too_short', until })
    expect((await site('old')).policyWarning).toBeUndefined()
    days(30)
    await run()
    expect((await status()).paused).toBeNull()
    expect((await site('old')).policyWarning?.kind).toBe('archive')
  })

  it('reads the view-counting switch once a run', async () => {
    await start()
    const reads = vi.spyOn(env.store, 'getViewCounting')
    await policyRun(env.deps, { observe: true })
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('counting the inactive days from when it first saw views counted, on a new instance too', async () => {
    await start()
    await deploy(alice.key, 'old')
    await goLive()
    await run()
    days(29)
    await run()
    expect((await status()).paused?.reason).toBe('counting_too_short')
    days(1)
    await run()
    expect((await status()).paused).toBeNull()
  })
})

describe('warn first, then archive', () => {
  it('dry run warns and changes nothing; going live warns the overdue first, and archives a warning later', async () => {
    await start()
    await overdue()
    const before = await site('old')
    const dry = await run()
    expect(dry.policy.wouldAct).toBe(1)
    expect(await site('old')).toEqual(before)
    await sendMail()
    expect(subjects()).toEqual([])
    expect(await policyAudit()).toEqual([])
    const preview = await status()
    expect(preview.live).toBe(false)
    const now = env.deps.clock.now().getTime()
    expect(preview.preview.sites).toEqual([
      expect.objectContaining({
        name: 'old',
        action: 'warn_archive',
        at: new Date(now).toISOString(),
      }),
      expect.objectContaining({
        name: 'old',
        action: 'archive',
        at: new Date(now + 7 * DAY).toISOString(),
      }),
    ])
    // A dry run looks again a day later, so the preview keeps it.
    days(1)
    expect((await run()).policy.wouldAct).toBe(1)
    expect((await site('old')).archived).toBe(false)

    await goLive()
    const live = await run()
    expect(live.policy).toMatchObject({ warned: 1, archived: 0 })
    const dueAt = new Date(env.deps.clock.now().getTime() + 7 * DAY).toISOString()
    expect((await site('old')).policyWarning).toMatchObject({ kind: 'archive', dueAt })
    expect((await detail('old')).archiveDue).toEqual({ action: 'archive', at: dueAt, warned: true })
    await sendMail()
    expect(subjects()).toEqual([expect.stringMatching(/old will be archived on 18 February 2026$/)])
    expect(env.mailer.sentTo(ALICE)[0]?.message.text).toContain('Keep')

    days(6)
    await run()
    expect((await site('old')).archived).toBe(false)
    days(1)
    const archived = await run()
    expect(archived.policy.archived).toBe(1)
    const after = await site('old')
    expect(after).toMatchObject({ archived: true, archivedBy: 'policy' })
    expect(after.policyWarning).toBeUndefined()
    expect(await env.routeTable.get(siteKvsKey('old'))).toBeFalsy()
    expect((await policyAudit()).map(e => [e.action, e.target])).toEqual([['site.archive', 'old']])
    const listed = await json(await api(env, alice.key, 'GET', '/api/sites/old'))
    expect(listed).toMatchObject({
      archived: true,
      archivedBy: 'policy',
      archivedAt: after.archivedAt,
    })
    expect((await status()).recent).toEqual([
      expect.objectContaining({ action: 'site.archive', target: 'old' }),
    ])
  })

  it('a warning given before a spell of dry run holds nothing: going live again warns first', async () => {
    await start()
    await overdue()
    await goLive()
    expect((await run()).policy.warned).toBe(1)
    await goLive(false)
    days(10)
    await run()
    // In dry run, the preview warns first too.
    expect((await status()).preview.sites[0]).toMatchObject({ name: 'old', action: 'warn_archive' })
    await goLive()
    const again = await run()
    expect(again.policy).toMatchObject({ warned: 1, archived: 0 })
    expect((await site('old')).archived).toBe(false)
    expect((await detail('old')).archiveDue).toMatchObject({ action: 'archive', warned: true })
    days(7)
    expect((await run()).policy.archived).toBe(1)
  })

  it('turning it live while it is live changes nothing: its warnings hold', async () => {
    await start()
    await overdue()
    await goLive()
    await run()
    const { setAt } = await status()
    days(7)
    await goLive()
    expect((await status()).setAt).toBe(setAt)
    expect((await run()).policy.archived).toBe(1)
  })

  it('a site not yet due is warned its warning-length before, and its page says when', async () => {
    await start()
    await deploy(alice.key, 'old')
    await goLive()
    await run()
    days(30)
    await view('old')
    const viewedAt = env.deps.clock.now().getTime()
    await run()
    const due = await detail('old')
    expect(due.archiveDue).toEqual({
      action: 'archive',
      at: new Date(viewedAt + 30 * DAY).toISOString(),
      warned: false,
    })
    days(23)
    await run()
    expect((await site('old')).policyWarning).toMatchObject({
      dueAt: new Date(viewedAt + 30 * DAY).toISOString(),
    })
  })

  it('records the warning once: a second look at the same inactivity sends nothing new', async () => {
    await start()
    await overdue()
    await goLive()
    await run()
    await sendMail()
    expect(subjects()).toHaveLength(1)
    const warned = await site('old')
    // As if recording the warning had failed after the event was: the next look warns again.
    const { policyWarning: _, ...unwarned } = warned
    await env.store.putSite(unwarned as SiteRecord)
    await run()
    await sendMail()
    expect(subjects()).toHaveLength(1)
  })

  it('a view or a publish since the warning makes it active again', async () => {
    await start()
    await deploy(alice.key, 'viewed')
    await deploy(alice.key, 'published')
    await run()
    days(40)
    await goLive()
    await run()
    expect((await site('viewed')).policyWarning?.kind).toBe('archive')
    expect((await site('published')).policyWarning?.kind).toBe('archive')
    days(3)
    await view('viewed')
    await deploy(alice.key, 'published', 'again')
    days(4)
    await run()
    expect((await site('viewed')).archived).toBe(false)
    expect((await site('published')).archived).toBe(false)
    expect((await site('published')).policyWarning).toBeUndefined()
    expect((await detail('viewed')).archiveDue).toMatchObject({ action: 'archive', warned: false })
  })
})

describe('archive, then delete, then purge', () => {
  it('deletes only what the policy archived, warned, softly; and purges it later', async () => {
    await start()
    await overdue()
    await deploy(alice.key, 'mine')
    expect((await api(env, alice.key, 'POST', '/api/sites/mine/archive')).status).toBe(200)
    await goLive()
    await run()
    days(7)
    await run()
    const archived = await site('old')
    expect(archived.archivedBy).toBe('policy')
    expect((await detail('old')).archiveDue).toEqual({
      action: 'delete',
      at: new Date(Date.parse(archived.archivedAt as string) + 20 * DAY).toISOString(),
      warned: false,
    })
    days(13)
    await run()
    expect((await site('old')).policyWarning?.kind).toBe('delete')
    await sendMail()
    expect(subjects().at(-1)).toMatch(/old will be deleted on/)
    days(7)
    const deleted = await run()
    expect(deleted.policy.deleted).toBe(1)
    expect(await env.store.findSite('old')).toBeNull()
    const record = await env.store.getDeletedSite('site', archived.id)
    expect(record).toMatchObject({ name: 'old', deletedBy: ARCHIVE_POLICY_ACTOR })
    expect(await env.blobs.head(deletedKey(archived.id))).not.toBeNull()
    // The one its owner archived is never the policy's to delete.
    expect((await site('mine')).archived).toBe(true)

    days(9)
    await run()
    expect(await env.store.getDeletedSite('site', archived.id)).not.toBeNull()
    expect((await status()).preview.purge).toEqual([
      expect.objectContaining({ siteId: archived.id, name: 'old' }),
    ])
    days(1)
    const purged = await run()
    expect(purged.policy.purged).toBe(1)
    expect(await env.store.getDeletedSite('site', archived.id)).toBeNull()
    expect(await env.blobs.head(deletedKey(archived.id))).toBeNull()
    expect((await policyAudit()).map(e => e.action)).toEqual([
      'site.purge',
      'site.delete',
      'site.archive',
    ])
    days(400)
    await run()
    expect((await site('mine')).archived).toBe(true)
  })

  it('a site an admin restores after the policy deleted it is never deleted by it again', async () => {
    await start()
    await overdue()
    const { id } = await site('old')
    await goLive()
    await run()
    days(7)
    await run()
    days(13)
    await run()
    days(7)
    await run()
    expect(await env.store.getDeletedSite('site', id)).toMatchObject({
      deletedBy: ARCHIVE_POLICY_ACTOR,
    })
    const restored = await browser(BOSS, 'POST', `/api/admin/deleted/${id}/restore`, {})
    expect(restored.status).toBe(200)
    const back = await site('old')
    expect(back).toMatchObject({ id, archived: true })
    expect(back.archivedBy).toBeUndefined()
    expect(back.policyWarning).toBeUndefined()
    expect((await detail('old')).archiveDue).toBeUndefined()
    await run()
    days(POLICY.deleteArchivedDays + POLICY.warnDays + 1)
    await run()
    days(POLICY.deleteArchivedDays + POLICY.warnDays + 1)
    await run()
    expect(await site('old')).toMatchObject({ id, archived: true })
  })

  it('an unarchive starts it over: nothing is deleted', async () => {
    await start()
    await overdue()
    await goLive()
    await run()
    days(7)
    await run()
    expect((await site('old')).archivedBy).toBe('policy')
    days(3)
    expect((await api(env, alice.key, 'POST', '/api/sites/old/unarchive')).status).toBe(200)
    const back = await site('old')
    expect(back.archivedBy).toBeUndefined()
    expect(back.unarchivedAt).toBe(env.deps.clock.now().toISOString())
    days(20)
    await run()
    expect(await site('old')).toMatchObject({ archived: false })
    expect((await site('old')).policyWarning).toBeUndefined()
  })

  it('without mail: archives with no email (the site page says so), and never deletes', async () => {
    await start({ mail: undefined })
    await overdue()
    await goLive()
    await run()
    expect((await detail('old')).archiveDue).toMatchObject({ action: 'archive', warned: true })
    expect(env.mailer.sent).toHaveLength(0)
    days(7)
    await run()
    expect((await site('old')).archivedBy).toBe('policy')
    expect((await detail('old')).archiveDue).toBeUndefined()
    days(400)
    await run()
    expect((await site('old')).archived).toBe(true)
    expect((await status()).mail).toBe(false)
  })

  it('purges every deleted site in time, but never one being restored or one live again', async () => {
    await start()
    await deploy(alice.key, 'gone')
    await deploy(alice.key, 'live')
    const gone = await site('gone')
    const live = await site('live')
    expect((await api(env, alice.key, 'DELETE', '/api/sites/gone')).status).toBe(204)
    const at = env.deps.clock.now().toISOString()
    const fake = (over: Partial<DeletedSiteRecord>): DeletedSiteRecord => ({
      kind: 'site',
      siteId: live.id,
      name: 'live',
      owner: ALICE,
      deletedBy: ALICE,
      deletedAt: at,
      bytes: 1,
      ...over,
    })
    // A record naming a live site's id (a delete that never finished, or a forged one).
    await env.store.putDeletedSite(fake({}))
    await env.store.putDeletedSite(
      fake({ siteId: 'restoring-id', restoring: { name: 'r', by: BOSS, at } })
    )
    await goLive()
    days(10)
    const purged = await run()
    expect(purged.policy.purged).toBe(1)
    expect(await env.store.getDeletedSite('site', gone.id)).toBeNull()
    expect(await env.store.getDeletedSite('site', live.id)).not.toBeNull()
    expect(await env.store.getDeletedSite('site', 'restoring-id')).not.toBeNull()
    expect(await site('live')).toMatchObject({ id: live.id, archived: false })
    const res = await env.app.request(`/api/sites/live`, {
      headers: { authorization: `Bearer ${alice.key}` },
    })
    expect(res.status).toBe(200)
  })

  it('purges nothing in dry run, and a dry run preview lists it', async () => {
    await start()
    await deploy(alice.key, 'gone')
    const gone = await site('gone')
    expect((await api(env, alice.key, 'DELETE', '/api/sites/gone')).status).toBe(204)
    days(5)
    expect((await status()).preview.purge).toEqual([expect.objectContaining({ siteId: gone.id })])
    days(10)
    expect((await run()).policy.purged).toBe(0)
    expect(await env.store.getDeletedSite('site', gone.id)).not.toBeNull()
  })
})

describe('the keep flag', () => {
  it('owners and admins (browser session, audited) set it; it exempts the site from everything', async () => {
    await start()
    const bob = await createUser(env, BOB)
    await deploy(alice.key, 'kept')
    expect((await api(env, bob.key, 'PUT', '/api/sites/kept/keep', { keep: true })).status).toBe(
      404
    )
    expect((await api(env, boss.key, 'PUT', '/api/sites/kept/keep', { keep: true })).status).toBe(
      404
    )
    const set = await api(env, alice.key, 'PUT', '/api/sites/kept/keep', { keep: true })
    expect([set.status, (await json(set)).keep]).toEqual([200, true])
    const cleared = await browser(BOSS, 'PUT', '/api/sites/kept/keep', { keep: false })
    expect((await json(cleared)).keep).toBeUndefined()
    const changes = (await env.store.listAuditEntries(50)).filter(e => e.action === 'site.change')
    expect(changes).toEqual([
      expect.objectContaining({ actor: BOSS, change: 'site.keep', target: 'kept' }),
    ])
    expect((await browser(BOSS, 'PUT', '/api/sites/kept/keep', { keep: true })).status).toBe(200)
    await goLive()
    await run()
    days(100)
    await run()
    expect(await site('kept')).toMatchObject({ archived: false, keep: true })
    expect((await site('kept')).policyWarning).toBeUndefined()
    expect((await detail('kept')).archiveDue).toBeUndefined()
    // Deleted, it is still kept: never purged.
    const id = (await site('kept')).id
    expect((await api(env, alice.key, 'DELETE', '/api/sites/kept')).status).toBe(204)
    expect(await env.store.getDeletedSite('site', id)).toMatchObject({ keep: true })
    days(100)
    await run()
    expect(await env.store.getDeletedSite('site', id)).not.toBeNull()
  })

  it('keeping a warned site takes the warning back; fling_keep sets it over MCP', async () => {
    await start()
    await overdue()
    await goLive()
    await run()
    expect((await site('old')).policyWarning).toBeDefined()
    const { accessToken } = await connect(env, ALICE)
    const res = await callTool(env, accessToken, 'fling_keep', { name: 'old', keep: true })
    expect(res.isError).toBeFalsy()
    expect((await site('old')).keep).toBe(true)
    expect((await site('old')).policyWarning).toBeUndefined()
    await sendMail()
    // The warning recorded before it was kept is dropped at send time.
    expect(subjects()).toEqual([])
    days(30)
    await run()
    expect((await site('old')).archived).toBe(false)
  })
})

describe('the switch', () => {
  it('starts in dry run; only an admin’s browser session turns it live, audited', async () => {
    await start()
    expect(await status()).toMatchObject({ on: true, live: false, settings: POLICY })
    const token = await api(env, boss.key, 'PUT', '/api/admin/archive-policy', { live: true })
    expect([token.status, (await json(token)).error.code]).toEqual([403, 'session_required'])
    expect(
      (await api(env, alice.key, 'PUT', '/api/admin/archive-policy', { live: true })).status
    ).toBe(404)
    expect((await api(env, alice.key, 'GET', '/api/admin/archive-policy')).status).toBe(404)
    await goLive()
    expect(await status()).toMatchObject({ live: true, setBy: BOSS })
    const audit = (await env.store.listAuditEntries(10)).find(
      e => e.action === 'archive_policy.switch'
    )
    expect(audit).toMatchObject({ actor: BOSS, target: 'live' })
    await goLive(false)
    expect((await status()).live).toBe(false)
  })

  it('advertises the capability and the notification kinds', async () => {
    await start()
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.archivePolicy).toBe(true)
    const settings = await json(await api(env, alice.key, 'GET', '/api/me/notifications'))
    const keys = settings.events.map((e: { key: string }) => e.key)
    expect(keys).toEqual(expect.arrayContaining(['site.archive_due', 'site.delete_due']))
  })
})

describe('the remote MCP server', () => {
  it('lists the policy to admins only, read only, and fling_info says when a site falls due', async () => {
    await start()
    await overdue()
    await goLive()
    await run()
    const names = async (email: string) => {
      const { accessToken } = await connect(env, email)
      const list = await json(await rpc(env, accessToken, 'tools/list'))
      return { accessToken, names: (list.result.tools as { name: string }[]).map(t => t.name) }
    }
    const asAlice = await names(ALICE)
    expect(asAlice.names).not.toContain('fling_admin_archive_policy')
    const asBoss = await names(BOSS)
    expect(asBoss.names).toContain('fling_admin_archive_policy')
    const shown = await callTool(env, asBoss.accessToken, 'fling_admin_archive_policy', {})
    const text = shown.content[0]?.text
    expect(text).toMatch(/^The archive policy on .*:\nLive \(by boss@example\.test on /)
    expect(text).toContain('Archives a site nobody has viewed or published for 30 days')
    expect(text).toMatch(/: archive old \(owner alice@example\.test; last viewed or published /)
    expect(text).toContain(`Admin → Archive policy: ${APP_ORIGIN}/admin/archive-policy`)
    const info = await callTool(env, asAlice.accessToken, 'fling_info', { name: 'old' })
    expect(info.content[0]?.text).toMatch(
      /Will be archived on \d{4}-\d{2}-\d{2}, unless someone views or publishes it first, or an owner keeps it \(its owners have been told\)/
    )
  })
})

describe('purging only', () => {
  it('advertises purgeDeleted, and offers admins the status over MCP but nothing to keep', async () => {
    await start({ archivePolicy: { ...POLICY, inactiveDays: 0, deleteArchivedDays: 0 } })
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities).toMatchObject({ archivePolicy: false, purgeDeleted: true })
    const { accessToken } = await connect(env, BOSS)
    const list = await json(await rpc(env, accessToken, 'tools/list'))
    const names = (list.result.tools as { name: string }[]).map(t => t.name)
    expect(names).toContain('fling_admin_archive_policy')
    expect(names).not.toContain('fling_keep')
    const shown = await callTool(env, accessToken, 'fling_admin_archive_policy', {})
    expect(shown.content[0]?.text).toContain('Archives no sites.')
  })
})

describe('the dev clock', () => {
  it('moves the API’s clock on and runs maintenance, only with the dev login on', async () => {
    await start({ appEnv: 'development', devLogin: true, secureCookies: false })
    const clock = new DevClock()
    const app = createApp({ ...env.deps, clock })
    const before = clock.now().getTime()
    const moved = await json(
      await app.request('/dev/clock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 2 }),
      })
    )
    expect(moved.offsetMs).toBe(2 * DAY)
    expect(Date.parse(moved.now) - before).toBeGreaterThanOrEqual(2 * DAY)
    const ran = await json(await app.request('/dev/maintain', { method: 'POST' }))
    expect(ran.policy).toBeDefined()
    // The test clock isn't the dev clock: it can't be moved.
    const fixed = await env.app.request('/dev/clock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days: 1 }),
    })
    expect(fixed.status).toBe(409)
  })

  it('is never mounted, nor the clock used, in production', async () => {
    await start()
    expect((await env.app.request('/dev/clock', { method: 'POST' })).status).toBe(404)
    expect((await env.app.request('/dev/maintain', { method: 'POST' })).status).toBe(404)
    const prod = loadBaseConfig({
      APP_ENV: 'production',
      APP_ORIGIN,
      SITES_DOMAIN: 'fling.test',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      STORE_DRIVER: 'memory',
      STORAGE_DRIVER: 'fs',
      KVS_DRIVER: 'memory',
      DEV_LOGIN: 'on',
    })
    expect(prod.devLogin).toBe(false)
    expect(buildDeps(env.config).clock).not.toBe(devClock)
    const dev = buildDeps({ ...env.config, devLogin: true })
    expect(dev.clock).toBe(devClock)
  })
})
