/**
 * View counting as an admin's switch (views.ts): on or off from Admin → Usage, rolled out by
 * maintenance to every live site without a new version, and, the first time, to the sites live
 * before view counting existed. Off keeps the counts so far and the copies; on again serves them.
 */
import { COUNTED_DIR, pathKvsKey, siteKvsKey, siteObjectKey } from '@fling/shared'
import { parseRoute } from '@fling/shared/site-routing'
import { VIEW_BEACON } from '@fling/shared/view-beacon'
import { describe, expect, it } from 'vitest'
import { maintain } from '../src/maintenance.ts'
import { MAX_COUNTED_PAGES } from '../src/rendering.ts'
import { ViewCounter, viewCountingOn } from '../src/views.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const BOSS = 'boss@example.test'
const ALICE = 'alice@example.test'
type F = ReturnType<typeof file>

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

const pages = (at = '') => [
  file(`${at}index.html`, '<html><body><h1>home</h1></body></html>'),
  file(`${at}notes/readme.md`, '# Notes', 'text/markdown'),
]

async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const staged = await json(res)
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

async function text(env: Env, storageId: string, versionId: string, path: string) {
  const bytes = await env.blobs.get(siteObjectKey(storageId, versionId, path))
  return bytes ? new TextDecoder().decode(bytes) : null
}

const route = async (env: Env, key: string) => parseRoute((await env.routeTable.get(key)) ?? null)

async function world() {
  const env = setup({ adminEmails: [BOSS] })
  const boss = await createUser(env, BOSS)
  const alice = await createUser(env, ALICE)
  return { env, boss, alice }
}

/** Publish while view counting is off, then forget it was set: a site live before it existed. */
async function liveBefore(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const at = env.deps.clock.now().toISOString()
  await env.store.putViewCounting({ on: false, setAt: at, rollout: { after: null, sites: 0 } })
  await deploy(env, key, name, files, extra)
  await env.table.delete('VIEWS', 'COUNTING')
}

describe('the sites live before view counting existed', () => {
  it('get their counted copies from maintenance, without a new version or a push', async () => {
    const { env, alice } = await world()
    await liveBefore(env, alice.key, 'old', pages())
    await liveBefore(env, alice.key, 'team', pages('PAY-1/'), { path: 'PAY-1' })
    const before = await env.store.findSite('old')
    const versionId = before?.currentVersionId as string
    expect((await env.store.getVersion(before!, versionId))?.counted).toBeUndefined()
    expect((await route(env, siteKvsKey('old')))?.c).toBeUndefined()
    const pushes = (await env.store.getSiteMetrics(before!.id)).buckets

    expect((await maintain(env.deps)).viewCounting).toBe(2)

    const after = await env.store.findSite('old')
    // The site is as it was: same version, same revision, same time.
    expect(after).toEqual(before)
    expect(await env.store.getVersion(after!, versionId)).toMatchObject({ counted: true })
    expect(await route(env, siteKvsKey('old'))).toMatchObject({ c: 1 })
    expect(await text(env, after!.id, versionId, `${COUNTED_DIR}index.html`)).toContain(VIEW_BEACON)
    expect(await text(env, after!.id, versionId, '.rendered/notes/readme.md.html')).toContain(
      VIEW_BEACON
    )
    expect((await env.store.getSiteMetrics(before!.id)).buckets).toEqual(pushes)

    // A live Path gets its copies too, under its own route.
    const team = await env.store.findSite('team')
    const [path] = await env.store.listPaths(team!.id)
    expect(await route(env, pathKvsKey(team!.id, 'PAY-1'))).toMatchObject({ c: 1 })
    expect(
      await text(env, path!.id, path!.currentVersionId as string, `${COUNTED_DIR}index.html`)
    ).toContain(VIEW_BEACON)

    // Done once: the next run has nothing to roll out.
    expect((await maintain(env.deps)).viewCounting).toBe(0)
  })

  it('marks a version too big to count, so the rollout never copies it again', async () => {
    const { env, alice } = await world()
    const many = Array.from({ length: MAX_COUNTED_PAGES + 1 }, (_, i) =>
      file(`p/${i}.html`, `<p>${i}</p>`)
    )
    await liveBefore(env, alice.key, 'many', many)
    await maintain(env.deps)
    const site = await env.store.findSite('many')
    expect(await env.store.getVersion(site!, site!.currentVersionId as string)).toMatchObject({
      counted: false,
    })
    expect((await route(env, siteKvsKey('many')))?.c).toBeUndefined()
  })
})

describe('the switch on Admin → Usage', () => {
  it('turns counting off on every live site and back on, keeping the copies', async () => {
    const { env, boss, alice } = await world()
    await deploy(env, alice.key, 'docs', pages())
    await maintain(env.deps)
    const site = await env.store.findSite('docs')
    const id = site!.id
    const v = site!.currentVersionId as string
    expect(await route(env, siteKvsKey('docs'))).toMatchObject({ c: 1 })

    const off = await browser(env, boss.session, 'PUT', '/api/admin/usage/view-counting', {
      on: false,
    })
    expect(off.status).toBe(200)
    expect((await json(off)).counting).toMatchObject({ on: false, setBy: BOSS })
    expect(await viewCountingOn(env.deps)).toBe(false)
    expect((await maintain(env.deps)).viewCounting).toBe(1)
    expect((await route(env, siteKvsKey('docs')))?.c).toBeUndefined()
    expect(await text(env, id, v, '.rendered/notes/readme.md.html')).not.toContain(VIEW_BEACON)
    // The copies stay, for when it is turned back on.
    expect(await text(env, id, v, `${COUNTED_DIR}index.html`)).toContain(VIEW_BEACON)

    // A publish while it is off makes no copies.
    await deploy(env, alice.key, 'quiet', pages())
    const quiet = await env.store.findSite('quiet')
    expect(
      await text(env, quiet!.id, quiet!.currentVersionId as string, `${COUNTED_DIR}index.html`)
    ).toBeNull()

    // Views reported by pages served before it went off aren't counted.
    const views = new ViewCounter(env.store, env.deps.clock, 0, () => viewCountingOn(env.deps))
    views.count(id, 3)
    await views.flush()
    expect((await env.store.getSiteMetrics(id)).activity?.lastViewAt).toBeUndefined()

    await browser(env, boss.session, 'PUT', '/api/admin/usage/view-counting', { on: true })
    await maintain(env.deps)
    expect(await route(env, siteKvsKey('docs'))).toMatchObject({ c: 1 })
    expect(await text(env, id, v, '.rendered/notes/readme.md.html')).toContain(VIEW_BEACON)
    // The site published while it was off gets its copies now.
    expect(await route(env, siteKvsKey('quiet'))).toMatchObject({ c: 1 })

    const usage = await json(await browser(env, boss.session, 'GET', '/api/admin/usage'))
    expect(usage.counting).toMatchObject({ on: true, rollout: { sites: 2 } })
    expect(usage.counting.rollout.finishedAt).toBeDefined()
    const audit = await json(await browser(env, boss.session, 'GET', '/api/admin/audit'))
    const turned = audit.entries.filter(
      (e: { action: string }) => e.action === 'usage.view_counting'
    )
    expect(turned.map((e: { target: string }) => e.target).sort()).toEqual(['off', 'on'])
    expect(turned.every((e: { actor: string }) => e.actor === BOSS)).toBe(true)
  })

  it('is set only in an admin browser session, and not where the instance counts no views', async () => {
    const { env, boss, alice } = await world()
    const body = { on: false }
    expect(
      (await browser(env, alice.session, 'PUT', '/api/admin/usage/view-counting', body)).status
    ).toBe(404)
    expect((await api(env, boss.key, 'PUT', '/api/admin/usage/view-counting', body)).status).toBe(
      404
    )

    const none = setup({ adminEmails: [BOSS], viewCounts: false })
    const admin = await createUser(none, BOSS)
    const refused = await browser(
      none,
      admin.session,
      'PUT',
      '/api/admin/usage/view-counting',
      body
    )
    expect(refused.status).toBe(400)
    const usage = await json(await browser(none, admin.session, 'GET', '/api/admin/usage'))
    expect(usage.counting).toBeUndefined()
    expect((await maintain(none.deps)).viewCounting).toBe(0)
  })
})
