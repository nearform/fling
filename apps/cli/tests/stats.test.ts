import type { InstanceMetadata } from '@fling/shared'
import { metricRanges, type SiteMetrics } from '@fling/shared/metrics'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import { runStats } from '../src/commands/sites.ts'
import { createMcpServer } from '../src/mcp.ts'
import { sparkline } from '../src/stats.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  mockFetch,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempDir,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const METRICS_ON: InstanceMetadata = {
  ...INSTANCE,
  capabilities: { ...INSTANCE.capabilities, metrics: true, viewCounts: true },
}

/** Metrics with 3 views and a push today, 5 views yesterday. */
function metrics(viewCounts = true): SiteMetrics {
  const { days, weeks, months } = metricRanges(new Date())
  const today = days.length - 1
  const views = (i: number) => (!viewCounts ? 0 : i === today ? 3 : i === today - 1 ? 5 : 0)
  return {
    name: 'my-app',
    viewCounts,
    since: '2026-10-01T10:00:00.000Z',
    lastViewAt: viewCounts ? new Date().toISOString() : null,
    lastPushAt: new Date().toISOString(),
    days: days.map((day, i) => ({ day, views: views(i), pushes: i === today ? 1 : 0 })),
    weeks: weeks.map(w => ({ ...w, views: 0, pushes: 0 })),
    months: months.map(month => ({ month, views: 0, pushes: 0 })),
    totals: {
      days: { views: viewCounts ? 8 : 0, pushes: 1 },
      months: { views: viewCounts ? 8 : 0, pushes: 1 },
    },
  }
}

async function storeWith(instance: InstanceMetadata) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: TEST_KEY })
  return store
}

const metricsRoute = (body: SiteMetrics) => ({
  'GET /api/sites/my-app/metrics': () => jsonResponse(body),
})

describe('fling stats', () => {
  it('shows the totals, the last view and push, and a line per day', async () => {
    const m = mockFetch(metricsRoute(metrics()))
    const { ctx, out } = await testContext({ store: await storeWith(METRICS_ON), fetch: m.fetch })
    await runStats(ctx, 'my-app')
    const shown = out.content()
    expect(shown).toMatch(/Views:\s+8 in 28 days · 8 in 12 months/)
    expect(shown).toMatch(/Pushes:\s+1 in 28 days/)
    expect(shown).toMatch(/Last viewed:\s+just now/)
    expect(shown).toContain('█')
    expect(shown).toMatch(/nothing is recorded about who viewed/)
  })

  it('leaves views out where the Fling does not count them', async () => {
    const m = mockFetch(metricsRoute(metrics(false)))
    const { ctx, out } = await testContext({ store: await storeWith(METRICS_ON), fetch: m.fetch })
    await runStats(ctx, 'my-app')
    expect(out.content()).not.toMatch(/Views:|Last viewed/)
    expect(out.content()).toMatch(/doesn't count views/)
  })

  it('prints the metrics as they came with --json', async () => {
    const body = metrics()
    const m = mockFetch(metricsRoute(body))
    const { ctx, out } = await testContext({
      store: await storeWith(METRICS_ON),
      fetch: m.fetch,
      json: true,
    })
    await runStats(ctx, 'my-app')
    expect(JSON.parse(out.content())).toEqual(body)
  })

  it('says who may read them when the site is not found', async () => {
    const { ctx } = await testContext({
      store: await storeWith(METRICS_ON),
      fetch: mockFetch({}).fetch,
    })
    const error = await captureError(runStats(ctx, 'my-app'))
    expect(error.message).toMatch(/No site "my-app" whose metrics you can read/)
    expect(error.hint).toMatch(/owners and publishers/)
  })

  it('refuses on a Fling without metrics', async () => {
    const m = mockFetch({ 'GET /.well-known/fling': () => jsonResponse(INSTANCE) })
    const { ctx } = await testContext({ store: await storeWith(INSTANCE), fetch: m.fetch })
    expect((await captureError(runStats(ctx, 'my-app'))).message).toMatch(/has no site metrics/)
  })

  it('draws a count per day relative to the largest', () => {
    expect(sparkline([0, 4, 8])).toBe('▁▅█')
    expect(sparkline([0, 0])).toBe('▁▁')
  })
})

async function connect(instance: InstanceMetadata, fetchImpl?: FetchLike) {
  const store = await storeWith(instance)
  const home = await tempDir()
  const server = createMcpServer({
    store,
    fetch: fetchImpl,
    cwd: home,
    waitReady: async () => ({ ready: true, waitedMs: 0 }),
    servers: [{ url: SERVER, instance, current: true, signedIn: true }],
    locate: { cwd: home, home, platform: process.platform, env: {} },
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''

describe('fling_stats on the local MCP', () => {
  it('is offered only where a Fling has metrics', async () => {
    const names = async (instance: InstanceMetadata) =>
      (await (await connect(instance)).listTools()).tools.map(t => t.name)
    expect(await names(METRICS_ON)).toContain('fling_stats')
    expect(await names(INSTANCE)).not.toContain('fling_stats')
  })

  it('answers with the counts, never people', async () => {
    const client = await connect(METRICS_ON, mockFetch(metricsRoute(metrics())).fetch)
    const r = await client.callTool({ name: 'fling_stats', arguments: { name: 'my-app' } })
    const said = text(r)
    expect(said).toMatch(/my-app, last 28 days: 8 views, 1 push\./)
    expect(said).toMatch(/Views\/pushes per UTC day, .* 0\/0 5\/0 3\/1/)
    expect(said).toMatch(/nothing is recorded about who viewed/)
    expect(said).toContain(`Fling: ${SERVER.replace(/^https?:\/\//, '')}`)
  })

  it('says when views are not counted', async () => {
    const client = await connect(METRICS_ON, mockFetch(metricsRoute(metrics(false))).fetch)
    const said = text(await client.callTool({ name: 'fling_stats', arguments: { name: 'my-app' } }))
    expect(said).toMatch(/my-app, last 28 days: 1 push\./)
    expect(said).toMatch(/Example Fling doesn't count views/)
    expect(said).not.toMatch(/last viewed/i)
  })
})
