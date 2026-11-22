/**
 * A site's metrics through the API and the remote MCP: who may read them (owners, publishers,
 * admins; anyone else gets the 404 of a missing site), the shape (every day, week and month,
 * oldest first), pushes and views as counted, and fling_stats' text.
 */
import {
  METRIC_DAYS,
  METRIC_MONTHS,
  METRIC_WEEKS,
  metricRanges,
  SiteMetricsSchema,
} from '@fling/shared/metrics'
import { describe, expect, it } from 'vitest'
import { ViewCounter } from '../src/views.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const ADMIN = 'boss@example.test'

async function deploy(env: Env, key: string, name: string, extra: object = {}) {
  const files = [file('index.html', '<h1>hi</h1>')]
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  await upload(env, body.uploads, files)
  const done = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  expect(done.status).toBe(200)
}

/** Alice owns `deck` (members-level, live), Bob publishes it, Carol is a member. */
async function world(overrides = {}) {
  const env = setup({ adminEmails: [ADMIN], ...overrides })
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  const carol = await createUser(env, CAROL)
  const boss = await createUser(env, ADMIN)
  await deploy(env, alice.key, 'deck', { access: 'members' })
  await api(env, alice.key, 'PATCH', '/api/sites/deck', { publishers: { emails: [BOB] } })
  return { env, alice, bob, carol, boss }
}

const metricsOf = (env: Env, key: string, name = 'deck') =>
  api(env, key, 'GET', `/api/sites/${name}/metrics`)

describe('GET /api/sites/:name/metrics', () => {
  it("shows an owner the site's pushes, every bucket present and oldest first", async () => {
    const { env, alice } = await world()
    const res = await metricsOf(env, alice.key)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const m = SiteMetricsSchema.parse(await json(res))
    const ranges = metricRanges(env.deps.clock.now())
    expect(m.days).toHaveLength(METRIC_DAYS)
    expect(m.weeks).toHaveLength(METRIC_WEEKS)
    expect(m.months).toHaveLength(METRIC_MONTHS)
    expect(m.days.map(d => d.day)).toEqual(ranges.days)
    expect(m.weeks.map(w => w.week)).toEqual(ranges.weeks.map(w => w.week))
    expect(m.months.map(x => x.month)).toEqual(ranges.months)
    expect([...m.days.map(d => d.day)].sort()).toEqual(m.days.map(d => d.day))
    const now = env.deps.clock.now().toISOString()
    expect(m.days.at(-1)).toMatchObject({ day: now.slice(0, 10), pushes: 1, views: 0 })
    expect(m.weeks.at(-1)?.pushes).toBe(1)
    expect(m.months.at(-1)).toMatchObject({ month: now.slice(0, 7), pushes: 1 })
    expect(m.totals).toEqual({ days: { views: 0, pushes: 1 }, months: { views: 0, pushes: 1 } })
    expect(m).toMatchObject({ name: 'deck', viewCounts: true, lastPushAt: now, lastViewAt: null })
    expect(m.since).toBe(now)
  })

  it('shows the views a flush wrote', async () => {
    const { env, alice } = await world()
    const site = await env.store.findSite('deck')
    const views = new ViewCounter(env.store, env.deps.clock)
    views.count(site?.id ?? '', 3)
    await views.flush()
    const m = await json(await metricsOf(env, alice.key))
    expect(m.days.at(-1).views).toBe(3)
    expect(m.totals.days.views).toBe(3)
    expect(m.lastViewAt).toBe(env.deps.clock.now().toISOString())
  })

  it('answers publishers and admins; a member who views the site gets a 404, as for no site', async () => {
    const { env, bob, carol, boss } = await world()
    expect((await metricsOf(env, bob.key)).status).toBe(200)
    expect((await metricsOf(env, boss.key)).status).toBe(200)
    expect((await api(env, carol.key, 'GET', '/api/sites/deck')).status).toBe(404)
    const refused = await metricsOf(env, carol.key)
    const missing = await metricsOf(env, carol.key, 'nope')
    expect(refused.status).toBe(404)
    expect(missing.status).toBe(404)
    expect((await json(refused)).error.code).toBe((await json(missing)).error.code)
  })

  it('says when the instance does not count views', async () => {
    const { env, alice } = await world({ viewCounts: false })
    const m = await json(await metricsOf(env, alice.key))
    expect(m.viewCounts).toBe(false)
    expect(m.totals.days.pushes).toBe(1)
  })
})

describe('fling_stats', () => {
  it('answers with the counts, and refuses a site the caller cannot read as missing', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const stats = await callTool(env, accessToken, 'fling_stats', { name: 'deck' })
    expect(stats.isError).toBeFalsy()
    expect(stats.content[0]?.text).toContain(`deck, last ${METRIC_DAYS} days: 0 views, 1 push.`)
    expect(stats.content[0]?.text).toMatch(/nothing is recorded about who viewed/)
    expect(stats.structuredContent.days).toHaveLength(METRIC_DAYS)
    const other = await connect(env, CAROL)
    const refused = await callTool(env, other.accessToken, 'fling_stats', { name: 'deck' })
    expect(refused.isError).toBe(true)
  })

  it('says pushes only where views are not counted', async () => {
    const { env } = await world({ viewCounts: false })
    const { accessToken } = await connect(env, ALICE)
    const stats = await callTool(env, accessToken, 'fling_stats', { name: 'deck' })
    expect(stats.content[0]?.text).toContain(`deck, last ${METRIC_DAYS} days: 1 push.`)
    expect(stats.content[0]?.text).toMatch(/doesn't count views/)
  })
})
