/**
 * View counts in the core: the copies with the beacon a version gets at go-live and the route
 * value that serves them (`c`), SITE_VIEW_COUNTS off, the ViewCounter's batches, the buckets'
 * expiry, pushes on every way a version goes live, and the API's SITE_SEEN_PATH behind the origin
 * check (AWS's way in).
 */
import {
  COUNTED_DIR,
  SERVER_SITE_HEADER,
  SITE_SEEN_PATH,
  siteKvsKey,
  siteObjectKey,
} from '@fling/shared'
import { parseRoute } from '@fling/shared/site-routing'
import { VIEW_BEACON } from '@fling/shared/view-beacon'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { maintain } from '../src/maintenance.ts'
import { MAX_COUNTED_PAGES } from '../src/rendering.ts'
import { ViewCounter } from '../src/views.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

type F = ReturnType<typeof file>
const DAY_MS = 86_400_000

const pages = [
  file('index.html', '<html><body><h1>home</h1></body></html>'),
  file('docs/page.htm', '<p>page</p>'),
  file('notes/readme.md', '# Notes', 'text/markdown'),
  file('site.css', 'body{}', 'text/css'),
]

async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const staged = await json(res)
  if (staged.status !== 'upload') return staged
  await upload(env, staged.uploads, files)
  const done = await api(
    env,
    key,
    'POST',
    `/api/sites/${name}/deploys/${staged.versionId}/finalize`
  )
  expect(done.status).toBe(200)
  return json(done)
}

async function text(env: Env, siteId: string, versionId: string, path: string) {
  const bytes = await env.blobs.get(siteObjectKey(siteId, versionId, path))
  return bytes ? new TextDecoder().decode(bytes) : null
}

async function route(env: Env, name: string) {
  return parseRoute((await env.routeTable.get(siteKvsKey(name))) ?? null)
}

describe('counted copies at go-live', () => {
  it('copies every HTML page with the beacon, and the route serves them', async () => {
    const env = setup()
    const alice = await createUser(env)
    const { versionId } = await deploy(env, alice.key, 'counted', pages)
    const site = await env.store.findSite('counted')
    const id = site?.id as string
    expect(await env.store.getVersion(site!, versionId)).toMatchObject({ counted: true })
    expect(await route(env, 'counted')).toMatchObject({ c: 1 })

    expect(await text(env, id, versionId, `${COUNTED_DIR}index.html`)).toBe(
      `<html><body><h1>home</h1>${VIEW_BEACON}</body></html>`
    )
    expect(await text(env, id, versionId, `${COUNTED_DIR}docs/page.htm`)).toContain(VIEW_BEACON)
    // The originals, which pull hands out, are as published.
    expect(await text(env, id, versionId, 'index.html')).not.toContain(VIEW_BEACON)
    expect(await text(env, id, versionId, `${COUNTED_DIR}site.css`)).toBeNull()
    // Rendered Markdown carries the beacon, and a folder's Markdown home page has its copy.
    expect(await text(env, id, versionId, '.rendered/notes/readme.md.html')).toContain(VIEW_BEACON)
    expect(await text(env, id, versionId, `${COUNTED_DIR}notes/index.html`)).toContain(VIEW_BEACON)
  })

  it('leaves a version with more pages than it may count uncounted', async () => {
    const env = setup()
    const alice = await createUser(env)
    const many = Array.from({ length: MAX_COUNTED_PAGES + 1 }, (_, i) =>
      file(`p/${i}.html`, `<p>${i}</p>`)
    )
    const { versionId } = await deploy(env, alice.key, 'many', many)
    const site = await env.store.findSite('many')
    expect((await env.store.getVersion(site!, versionId))?.counted).toBeUndefined()
    expect((await route(env, 'many'))?.c).toBeUndefined()
  })

  it('makes no copies with SITE_VIEW_COUNTS off, and stops serving those there are', async () => {
    const env = setup()
    const alice = await createUser(env)
    await deploy(env, alice.key, 'on', pages)
    expect(await route(env, 'on')).toMatchObject({ c: 1 })

    const off = setup({ viewCounts: false })
    const bob = await createUser(off)
    const { versionId } = await deploy(off, bob.key, 'off', pages)
    const site = await off.store.findSite('off')
    expect((await off.store.getVersion(site!, versionId))?.counted).toBeUndefined()
    expect(await text(off, site!.id, versionId, `${COUNTED_DIR}index.html`)).toBeNull()

    // A version with copies, on an instance that has since turned counting off.
    const offDeps = { ...env.deps, config: { ...env.config, viewCounts: false } }
    const { syncRouteTable } = await import('../src/sites.ts')
    await syncRouteTable(offDeps, (await env.store.findSite('on'))!)
    expect((await route(env, 'on'))?.c).toBeUndefined()
  })
})

describe('ViewCounter', () => {
  it('writes views in batches, at most once an interval when flushed after requests', async () => {
    const env = setup()
    const add = vi.spyOn(env.store, 'addSiteCounts')
    const views = new ViewCounter(env.store, env.deps.clock, 10_000)
    views.count('S1')
    await views.flushDue() // the first, at once
    expect(add).toHaveBeenCalledTimes(1)
    views.count('S1')
    views.count('S1')
    views.count('S2')
    await views.flushDue()
    expect(add).toHaveBeenCalledTimes(1)
    env.advance(10_000)
    await views.flushDue()
    expect(add.mock.calls.slice(1).map(c => [c[0], c[2]])).toEqual([
      ['S1', { views: 2 }],
      ['S2', { views: 1 }],
    ])
    expect(views.waiting.size).toBe(0)
  })

  it('holds the counts a flush failed to write for the next one', async () => {
    const env = setup()
    const add = vi.spyOn(env.store, 'addSiteCounts').mockRejectedValueOnce(new Error('down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count('S1', 3)
    await views.flush()
    expect(views.waiting.get('S1')).toBe(3)
    await views.flush()
    expect(add).toHaveBeenCalledTimes(2)
    expect(views.waiting.size).toBe(0)
    expect((await env.store.getSiteMetrics('S1')).activity?.lastViewAt).toBeDefined()
  })
})

describe('buckets', () => {
  it('adds to the day, week and month at once, and lets each expire on its own', async () => {
    const env = setup() // 2026-01-01, a Thursday: ISO week 2026-W01
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count('S1', 2)
    await views.flush()
    views.count('S1')
    await views.flush()
    let { buckets, activity } = await env.store.getSiteMetrics('S1')
    expect(buckets.map(b => [b.size, b.bucket, b.views, b.pushes])).toEqual([
      ['D', '2026-01-01', 3, 0],
      ['M', '2026-01', 3, 0],
      ['W', '2026-W01', 3, 0],
    ])
    expect(activity).toMatchObject({ since: '2026-01-01T00:00:00.000Z' })

    env.advance(30 * DAY_MS)
    ;({ buckets } = await env.store.getSiteMetrics('S1'))
    expect(buckets.map(b => b.size).sort()).toEqual(['M', 'W'])
    env.advance(40 * DAY_MS)
    ;({ buckets } = await env.store.getSiteMetrics('S1'))
    expect(buckets.map(b => b.size)).toEqual(['M'])
    env.advance(400 * DAY_MS)
    ;({ buckets, activity } = await env.store.getSiteMetrics('S1'))
    expect(buckets).toEqual([])
    // When it was last viewed outlives the counts.
    expect(activity?.lastViewAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('pushes', () => {
  it('counts a publish, the repointed shortcut and a rollback, and nothing for unchanged', async () => {
    const env = setup()
    const alice = await createUser(env)
    const first = await deploy(env, alice.key, 'pushed', pages)
    await deploy(env, alice.key, 'pushed', [file('index.html', '<p>two</p>')])
    await deploy(env, alice.key, 'pushed', [file('index.html', '<p>two</p>')]) // unchanged
    await deploy(env, alice.key, 'pushed', pages) // repointed
    const back = await api(env, alice.key, 'POST', '/api/sites/pushed/current', {
      versionId: first.versionId,
    })
    expect(back.status).toBeLessThan(300)
    const site = await env.store.findSite('pushed')
    const { buckets, activity } = await env.store.getSiteMetrics(site!.id)
    expect(buckets.find(b => b.size === 'D')?.pushes).toBe(4)
    expect(activity?.lastPushAt).toBe('2026-01-01T00:00:00.000Z')
    expect(activity?.lastViewAt).toBeUndefined()
  })
})

describe('the API behind the origin check', () => {
  it('counts what the site router sends on, and has no such route without the check', async () => {
    const env = setup()
    const views = new ViewCounter(env.store, env.deps.clock)
    const behind = {
      ...env.deps,
      views,
      config: {
        ...env.config,
        secrets: { ...env.config.secrets, originVerifySecret: 'v'.repeat(32) },
      },
    }
    const secured = createApp(behind, { viewsFromEdge: true })
    const seen = (app: ReturnType<typeof createApp>, headers: Record<string, string>) =>
      app.request(SITE_SEEN_PATH, { method: 'POST', headers })
    const res = await seen(secured, {
      'x-origin-verify': 'v'.repeat(32),
      [SERVER_SITE_HEADER]: 'S1/V1/private',
    })
    expect(res.status).toBe(204)
    // The first view a runtime counts is written at once.
    expect((await env.store.getSiteMetrics('S1')).buckets[0]?.views).toBe(1)
    // Not through CloudFront: refused before anything is counted.
    expect((await seen(secured, { [SERVER_SITE_HEADER]: 'S2/V2' })).status).toBe(403)
    expect(views.waiting.has('S2')).toBe(false)

    // Without the edge sending views (Front Door adds an origin secret too), or the check: none.
    const verify = { 'x-origin-verify': 'v'.repeat(32), [SERVER_SITE_HEADER]: 'S3/V3' }
    expect((await seen(createApp(behind), verify)).status).toBe(404)
    const open = createApp({ ...env.deps, views }, { viewsFromEdge: true })
    expect((await seen(open, { [SERVER_SITE_HEADER]: 'S3/V3' })).status).toBe(404)
    expect(views.waiting.has('S3')).toBe(false)
  })
})

describe('Admin → Usage', () => {
  const BOSS = 'boss@example.test'

  it("adds every site's views and pushes together, one add a flush", async () => {
    const env = setup()
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count('S1', 2)
    views.count('S2', 3)
    await views.flush()
    const add = vi.spyOn(env.store, 'addInstanceCounts')
    views.count('S1')
    views.count('S2')
    views.count('S3')
    await views.flush()
    expect(add).toHaveBeenCalledTimes(1)
    const day = (await env.store.getInstanceMetrics()).find(b => b.size === 'D')
    expect(day).toMatchObject({ views: 8, pushes: 0 })
  })

  it("shows the instance's counts to admins, and the last lap's tally once maintenance ends one", async () => {
    const env = setup({ adminEmails: [BOSS] })
    const boss = await createUser(env, BOSS)
    const alice = await createUser(env)
    await deploy(env, alice.key, 'busy', pages)
    await deploy(env, alice.key, 'quiet', [file('index.html', '<p>quiet</p>')])
    await deploy(env, alice.key, 'gone', [file('index.html', '<p>gone</p>')])
    expect((await api(env, alice.key, 'POST', '/api/sites/gone/archive')).status).toBe(200)
    const busy = await env.store.findSite('busy')
    env.advance(3_600_000)
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count(busy!.id, 5)
    await views.flush()

    const res = await api(env, boss.key, 'GET', '/api/admin/usage')
    expect(res.status).toBe(200)
    let usage = await json(res)
    expect(usage.totals.days).toEqual({ views: 5, pushes: 3 })
    expect(usage.lap).toBeNull()
    expect((await api(env, alice.key, 'GET', '/api/admin/usage')).status).toBe(404)

    env.advance(60_000)
    await maintain(env.deps)
    usage = await json(await api(env, boss.key, 'GET', '/api/admin/usage'))
    expect(usage.lap).toMatchObject({
      sites: 3,
      live: 2,
      viewed: { days7: 1, days28: 1, days90: 1 },
      neverViewed: 1,
      top: [{ name: 'busy', views: 5 }],
    })
    expect(usage.lap.partial).toBeUndefined()
    expect(usage.lap.idle.map((s: { name: string }) => s.name)).toEqual(['quiet', 'busy'])

    // All sites says when each was last viewed.
    const list = await json(await api(env, boss.key, 'GET', '/api/admin/sites'))
    const byName = Object.fromEntries(list.sites.map((s: { name: string }) => [s.name, s]))
    expect(byName.busy.lastViewAt).toBeDefined()
    expect(byName.quiet.lastViewAt).toBeUndefined()
  })
})

describe('the Sites list with its metrics', () => {
  it('adds up the live sites you own or publish, with each one’s days, read in one batch', async () => {
    const env = setup()
    const alice = await createUser(env)
    const bob = await createUser(env, 'bob@example.test')
    await deploy(env, alice.key, 'mine-a', pages)
    env.advance(3_600_000)
    await deploy(env, alice.key, 'mine-b', [file('index.html', '<p>b</p>')])
    await deploy(env, alice.key, 'mine-gone', [file('index.html', '<p>gone</p>')])
    expect((await api(env, alice.key, 'POST', '/api/sites/mine-gone/archive')).status).toBe(200)
    await deploy(env, bob.key, 'bobs', [file('index.html', '<p>bob</p>')])
    const ids = await Promise.all(['mine-a', 'mine-b', 'bobs'].map(n => env.store.findSite(n)))
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count(ids[0]!.id, 2)
    views.count(ids[1]!.id, 3)
    views.count(ids[2]!.id, 7)
    await views.flush()

    const getMany = vi.spyOn(env.table, 'getMany')
    const query = vi.spyOn(env.table, 'query')
    const res = await api(env, alice.key, 'GET', '/api/sites?metrics=1')
    expect(res.status).toBe(200)
    const list = await json(res)
    // One batch read for every site's metrics, and no query of any site's buckets.
    expect(getMany).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.filter(([pk]) => String(pk).startsWith('SITE#'))).toEqual([])
    expect(list.metrics).toMatchObject({ sites: 2, of: 2, viewCounts: true, counting: true })
    expect(list.metrics.totals.days).toEqual({ views: 5, pushes: 2 })
    expect(list.metrics.since).toBe('2026-01-01T00:00:00.000Z')
    expect(list.metrics.lastPushAt).toBe('2026-01-01T01:00:00.000Z')
    // Each listed site carries its own days, today last.
    const days = Object.fromEntries(
      list.sites.map((s: { name: string; days: { views: number[] } }) => [s.name, s.days.views])
    )
    expect(Object.keys(days).sort()).toEqual(['mine-a', 'mine-b'])
    expect(days['mine-b'].at(-1)).toBe(3)
    expect(days['mine-b']).toHaveLength(list.metrics.days.length)

    // Without asking, or for archived sites, the list carries none.
    const plain = await json(await api(env, alice.key, 'GET', '/api/sites'))
    expect(plain.metrics).toBeUndefined()
    expect(plain.sites[0].days).toBeUndefined()
    const archived = await json(await api(env, alice.key, 'GET', '/api/sites?archived=1&metrics=1'))
    expect(archived.metrics).toBeUndefined()
  })
})
