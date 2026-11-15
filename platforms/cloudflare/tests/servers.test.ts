/**
 * Site servers on Cloudflare (src/servers/): the conformance suites against CloudflareSiteServers
 * on Miniflare's Worker Loader and R2ServerLogs on its R2, run in workerd by tests/servers-worker.ts
 * and driven from here over HTTP; then what is the Worker's alone: the run sealed in R2 and found
 * by another isolate through the route's target, the rate limit, the body limit, SiteFiles'
 * refusals and the hourly compaction of the logs.
 */
import { join } from 'node:path'
import { serverVersion } from '@fling/api/servers'
import type { ServerLogLine, ServerLogs, SiteServers } from '@fling/api/servers/types'
import { SERVER_FIXTURES, serverLogsConformance, siteServersConformance } from '@fling/conformance'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundle, COMPATIBILITY } from './miniflare.ts'

const KEY = 'a'.repeat(64)

async function start(rateLimit = 100_000) {
  const mf = new Miniflare({
    modules: true,
    script: await bundle(join(import.meta.dirname, 'servers-worker.ts')),
    ...COMPATIBILITY,
    bindings: { KEY, COMPATIBILITY_DATE: COMPATIBILITY.compatibilityDate },
    r2Buckets: ['BUCKET'],
    workerLoaders: { LOADER: {} },
    ratelimits: {
      SERVER_RATE_LIMIT: { namespace_id: '1001', simple: { limit: rateLimit, period: 10 } },
    },
  })
  const call = async (path: string, args: unknown[]) => {
    const res = await mf.dispatchFetch(`http://worker${path}`, {
      method: 'POST',
      body: JSON.stringify(args),
    })
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
    return res.json() as Promise<never>
  }
  const invoke = async (
    site: unknown,
    version: unknown,
    request: Request,
    run?: string,
    fresh = false
  ) => {
    const headers = new Headers(request.headers)
    if (fresh) headers.set('x-test-fresh', '1')
    headers.set('x-test-site', JSON.stringify(site))
    headers.set('x-test-version', JSON.stringify(version))
    headers.set('x-test-url', request.url)
    if (run) headers.set('x-test-run', run)
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const res = await mf.dispatchFetch('http://worker/invoke', {
      method: request.method,
      headers: Object.fromEntries(headers),
      body: hasBody ? Buffer.from(await request.arrayBuffer()) : undefined,
    })
    return res as unknown as Response
  }
  const servers: SiteServers = {
    activate: (...a) => call('/port/activate', a),
    probe: (...a) => call('/port/probe', a),
    reconfigure: (...a) => call('/port/reconfigure', a),
    setEnabled: (...a) => call('/port/setEnabled', a),
    retire: (...a) => call('/port/retire', a),
    invoke: (site, version, request) => invoke(site, version, request),
  }
  const logs: ServerLogs = {
    append: (siteId, lines) => call('/logs/write', [siteId, lines]),
    read: async (siteId, since, limit) => call('/logs/read', [siteId, since.toISOString(), limit]),
  }
  const bucket = await mf.getR2Bucket('BUCKET')
  return { mf, call, servers, logs, bucket, invoke }
}

type Local = Awaited<ReturnType<typeof start>>
let cf: Local
beforeAll(async () => {
  cf = await start()
}, 60_000)
afterAll(() => cf?.mf.dispose())

async function put(
  site: { id: string },
  versionId: string,
  files: Record<string, string | Uint8Array>
) {
  const version = serverVersion(site.id, versionId)
  for (const [path, body] of Object.entries(files))
    await cf.bucket.put(`${version.files}${path}`, body)
  return version
}

siteServersConformance('CloudflareSiteServers (Worker Loader)', async () => ({
  servers: cf.servers,
  logs: cf.logs,
  putVersion: put,
  logsWithinMs: 10_000,
}))

serverLogsConformance('R2ServerLogs', async () => ({
  logs: cf.logs,
  write: (siteId, lines) => cf.logs.append?.(siteId, lines) ?? Promise.resolve(),
}))

const LIMITS = { timeoutSeconds: 5, cpuMs: 1000, rps: 1, environments: 2, bodyBytes: 64 }
const options = (secrets: Record<string, string> = {}) => ({
  secrets,
  egress: 'none' as const,
  limits: LIMITS,
})
const uid = () => crypto.randomUUID().slice(0, 8)

describe('CloudflareSiteServers beyond the port', () => {
  it('names the run by its options, and another isolate finds a run by the route target', async () => {
    const site = { id: `s${uid()}`, name: 'run' }
    const version = await put(site, `v${uid()}`, { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const a = await cf.servers.activate(site, version, options({ GREETING: 'one' }))
    const again = await cf.servers.activate(site, version, options({ GREETING: 'one' }))
    const b = await cf.servers.reconfigure(site, version, options({ GREETING: 'two' }))
    expect(a.target).toMatch(/^[0-9a-f]{16}$/)
    expect(again.target).toBe(a.target)
    expect(b.target).not.toBe(a.target)
    const sealed = await cf.bucket.get(`sites/${site.id}/_servers/${version.id}/${a.target}.json`)
    expect(sealed).not.toBeNull()
    expect(await sealed?.text()).not.toContain('one')
    // Another isolate of the Worker knows nothing of the activation: only the target and R2.
    const req = () => new Request('https://run.sites.example.test/api/hello')
    const res = await cf.invoke(site, version, req(), a.target as string, true)
    expect((await res.json()).env).toBe('one')
    const latest = await cf.invoke(site, version, req(), b.target as string, true)
    expect((await latest.json()).env).toBe('two')
    const unknown = await cf.invoke(site, version, req(), 'ffffffffffffffff', true)
    expect(unknown.status).toBe(502)
  })

  it('refuses a body over the limit, with or without a length', async () => {
    const site = { id: `s${uid()}`, name: 'body' }
    const version = await put(site, `v${uid()}`, { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await cf.servers.activate(site, version, options())
    const big = 'x'.repeat(65)
    const res = await cf.servers.invoke(
      site,
      version,
      new Request('https://body.sites.example.test/api/echo', { method: 'POST', body: big })
    )
    expect([res.status, await res.text()]).toEqual([413, expect.anything()])
    const ok = await cf.servers.invoke(
      site,
      version,
      new Request('https://body.sites.example.test/api/echo', { method: 'POST', body: 'small' })
    )
    expect(await ok.text()).toBe('small')
  })

  it('SiteFiles serves the version only: no dotfile, no _fling/, no other version', async () => {
    const site = { id: `s${uid()}`, name: 'files' }
    const reader = `import { file } from '${'__H__'}'
export default { async fetch(r, env) {
  const p = new URL(r.url).searchParams.get('raw')
  const res = await env.FILES.fetch('https://files.invalid/' + p)
  return new Response(await res.text(), { status: res.status })
} }`.replace('__H__', SERVER_FIXTURES.fetch().match(/from '([^']+)'/)?.[1] ?? '')
    const version = await put(site, `v${uid()}`, {
      '_fling/server.mjs': reader,
      'a.txt': 'mine',
      '.env': 'SECRET=1',
    })
    await put(site, 'other', { 'b.txt': 'not mine' })
    await cf.servers.activate(site, version, options())
    const get = async (raw: string) => {
      const res = await cf.servers.invoke(
        site,
        version,
        new Request(`https://files.sites.example.test/api/f?raw=${encodeURIComponent(raw)}`)
      )
      return [res.status, await res.text()]
    }
    expect(await get('a.txt')).toEqual([200, 'mine'])
    for (const raw of ['.env', '_fling/server.mjs', '../other/b.txt', '%2e%2e/other/b.txt', '']) {
      expect((await get(raw))[0], raw).toBe(404)
    }
  })

  it('has no outbound network with SERVERS_EGRESS=none', async () => {
    const site = { id: `s${uid()}`, name: 'egress' }
    const code = `export default { async fetch() {
  try { await fetch('https://example.com'); return new Response('reached') }
  catch (e) { return new Response('blocked: ' + e.message) }
} }`
    const version = await put(site, `v${uid()}`, { '_fling/server.mjs': code })
    await cf.servers.activate(site, version, options())
    const res = await cf.servers.invoke(
      site,
      version,
      new Request('https://egress.sites.example.test/api/')
    )
    expect(await res.text()).toMatch(/^blocked/)
  })

  it('compacts past hours into one chunk, and reads the same lines after', async () => {
    const siteId = `s${uid()}`
    const at = (h: number, s: number) => new Date(Date.UTC(2020, 0, 1, h, 0, s)).toISOString()
    const now = Date.now()
    const recent = (s: number) => new Date(now - 3 * 3600_000 + s * 1000).toISOString()
    void at
    const line = (iso: string, text: string): ServerLogLine => ({
      at: iso,
      versionId: 'v1',
      kind: 'output',
      level: 'info',
      text,
    })
    await cf.logs.append?.(siteId, [line(recent(2), 'b')])
    await cf.logs.append?.(siteId, [line(recent(1), 'a'), line(recent(3), 'c')])
    const since = new Date(now - 4 * 3600_000)
    const before = await cf.logs.read(siteId, since, 100)
    expect(before.map(l => l.text)).toEqual(['a', 'b', 'c'])
    expect(await cf.call('/logs/compact', [])).toBeGreaterThanOrEqual(2)
    expect((await cf.logs.read(siteId, since, 100)).map(l => l.text)).toEqual(['a', 'b', 'c'])
    expect((await cf.logs.read(siteId, since, 2)).map(l => l.text)).toEqual(['a', 'b'])
    const listed = await cf.bucket.list({ prefix: `server-logs/${siteId}/` })
    expect(listed.objects.map(o => o.key).every(k => k.split('/').length === 3)).toBe(true)
  })
})

describe('the rate limit', () => {
  let limited: Local
  beforeAll(async () => {
    limited = await start(2)
  }, 60_000)
  afterAll(() => limited?.mf.dispose())

  it('answers 429 once a site is over its requests', async () => {
    const site = { id: `s${uid()}`, name: 'busy' }
    const version = serverVersion(site.id, `v${uid()}`)
    await limited.bucket.put(version.bundle, SERVER_FIXTURES.fetch())
    await limited.servers.activate(site, version, options({ GREETING: 'g' }))
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await limited.servers.invoke(
        site,
        version,
        new Request('https://busy.sites.example.test/api/hello')
      )
      statuses.push(res.status)
      await res.body?.cancel()
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200])
    expect(statuses).toContain(429)
  })
})
