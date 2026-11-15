/**
 * SiteServers and ServerLogs conformance: what the core relies on from a platform that runs site
 * servers. Each adapter runs both suites from a vitest file of its own:
 *
 *   siteServersConformance('NodeSiteServers', async () => ({ servers, logs, putVersion }))
 *   serverLogsConformance('MemoryServerLogs', async () => ({ logs, write }))
 *
 * The servers are the two pre-bundled fixtures (fixtures/*.mjs: a fetch handler and a node:http
 * server, no npm dependencies) and a few inline ones, stored by the harness where the adapter reads
 * versions from (`putVersion`). The suite talks to the adapter only through the port: activate,
 * probe, invoke (with the request the sites host's shell makes), reconfigure, setEnabled, retire.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ServerLimits } from '@fling/api/config'
import { SERVER_HELPER_MODULE } from '@fling/api/servers'
import type {
  ServerLogLine,
  ServerLogs,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '@fling/api/servers/types'
import { afterAll, describe, expect, it } from 'vitest'

export interface SiteServersHarness {
  servers: SiteServers
  /** where the adapter's output lines go, read back by the suite */
  logs: ServerLogs
  /**
   * Store a version's files (its `_fling/server.mjs` among them) where the adapter reads them,
   * and return the version as the core names it (serverVersion).
   */
  putVersion(
    site: ServerSite,
    versionId: string,
    files: Record<string, string | Uint8Array>
  ): Promise<ServerVersion>
  /** stop whatever the harness started */
  close?(): Promise<void>
  /** how long logs take to become readable (default 5 s) */
  logsWithinMs?: number
}

export interface ServerLogsHarness {
  logs: ServerLogs
  /** lines into the log as the platform takes them (append, or the platform's own collector) */
  write(siteId: string, lines: ServerLogLine[]): Promise<void>
}

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8').replaceAll(
    '__FLING_HELPER__',
    SERVER_HELPER_MODULE
  )

/** The fixtures as stored, with Fling's helper specifier in place. */
export const SERVER_FIXTURES = {
  fetch: () => fixture('fetch-server.mjs'),
  node: () => fixture('node-server.mjs'),
}

const LIMITS: ServerLimits = {
  timeoutSeconds: 2,
  cpuMs: 1000,
  rps: 100,
  environments: 2,
  bodyBytes: 1024 * 1024,
}

const options = (secrets: Record<string, string> = {}, limits: Partial<ServerLimits> = {}) =>
  ({ secrets, egress: 'none', limits: { ...LIMITS, ...limits } }) satisfies ServerOptions

const PROBE = { method: 'GET' as const, path: '/api/', timeoutMs: 10_000 }
const VIEWER = { id: 'v_abcdefghijklm', email: 'ada@example.test', guest: false }
const HOST = 'https://conformance.sites.example.test'

/** A request as the sites host's shell sends it (serverRequestHeaders already applied). */
function request(path: string, init: RequestInit & { viewer?: typeof VIEWER | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.viewer) headers.set('x-fling-viewer', JSON.stringify(init.viewer))
  return new Request(`${HOST}${path}`, { ...init, headers })
}

const uid = () => randomUUID().replaceAll('-', '').slice(0, 12)

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, withinMs: number) {
  const until = Date.now() + withinMs
  let last = await fn()
  while (!ok(last) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 100))
    last = await fn()
  }
  return last
}

export function siteServersConformance(name: string, factory: () => Promise<SiteServersHarness>) {
  describe(`SiteServers conformance: ${name}`, () => {
    const harnesses: SiteServersHarness[] = []
    afterAll(async () => {
      for (const h of harnesses) await h.close?.()
    })

    async function ready(files: Record<string, string>, secrets: Record<string, string> = {}) {
      const h = await factory()
      harnesses.push(h)
      const site: ServerSite = { id: uid(), name: `conformance-${uid()}` }
      const version = await h.putVersion(site, uid(), files)
      const { target } = await h.servers.activate(site, version, options(secrets))
      return { h, site, version, target }
    }

    it('runs a fetch handler: the viewer, its secrets in env and secret(), node:*, file()', async () => {
      const { h, site, version, target } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch(), 'data/hello.txt': 'hello file' },
        { GREETING: 'hi' }
      )
      expect(target === null || typeof target === 'string').toBe(true)
      const probe = await h.servers.probe(site, version, PROBE)
      expect(probe).toMatchObject({ ok: true, status: 404 })
      const res = await h.servers.invoke(site, version, request('/api/hello', { viewer: VIEWER }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        kind: 'fetch',
        method: 'GET',
        host: new URL(HOST).host,
        viewer: VIEWER,
        env: 'hi',
        secret: 'hi',
        digest: expect.stringMatching(/^[0-9a-f]{8}$/),
        cookie: null,
      })
      const anonymous = await h.servers.invoke(site, version, request('/api/hello'))
      expect((await anonymous.json()).viewer).toBeNull()
      const read = await h.servers.invoke(site, version, request('/api/file?path=data/hello.txt'))
      expect(read.status).toBe(200)
      expect(await read.text()).toBe('hello file')
      for (const p of ['_fling/server.mjs', '../x', '.env', 'data/none.txt']) {
        const res = await h.servers.invoke(site, version, request(`/api/file?path=${p}`))
        expect(res.status, p).toBe(404)
      }
      const undeclared = await h.servers.invoke(site, version, request('/api/missing-secret'))
      expect(await undeclared.text()).toContain('NOT_DECLARED')
    })

    it('runs a plain Node server on PORT, with nothing of the host environment', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.node() },
        { GREETING: 'hello' }
      )
      expect(await h.servers.probe(site, version, PROBE)).toMatchObject({ ok: true, status: 404 })
      const res = await h.servers.invoke(site, version, request('/api/hello', { viewer: VIEWER }))
      expect(await res.json()).toEqual({
        kind: 'node',
        method: 'GET',
        viewer: VIEWER,
        env: 'hello',
        home: null,
      })
    })

    it('passes any method and the body through, and the response as it was', async () => {
      for (const server of [SERVER_FIXTURES.fetch(), SERVER_FIXTURES.node()]) {
        const { h, site, version } = await ready({ '_fling/server.mjs': server })
        await h.servers.probe(site, version, PROBE)
        const res = await h.servers.invoke(
          site,
          version,
          request('/api/echo', {
            method: 'POST',
            body: 'payload',
            headers: { 'content-type': 'text/plain' },
          })
        )
        expect(res.status).toBe(201)
        expect(await res.text()).toBe('payload')
        const put = await h.servers.invoke(
          site,
          version,
          request('/api/echo', { method: 'PUT', body: 'x' })
        )
        expect(put.status).toBe(201)
      }
    })

    it('streams a response', async () => {
      const { h, site, version } = await ready({ '_fling/server.mjs': SERVER_FIXTURES.fetch() })
      const res = await h.servers.invoke(site, version, request('/api/stream'))
      expect(await res.text()).toBe('one two three')
    })

    it('ends a request at the wall-time limit', async () => {
      const { h, site, version } = await ready({ '_fling/server.mjs': SERVER_FIXTURES.fetch() })
      await h.servers.probe(site, version, PROBE)
      const started = Date.now()
      const res = await h.servers.invoke(site, version, request('/api/slow'))
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(Date.now() - started).toBeLessThan(4500)
    })

    it('the start probe: a crash is no answer, with what it printed', async () => {
      const crash = 'console.error("missing config: BOOM"); throw new Error("boom")'
      const { h, site, version } = await ready({ '_fling/server.mjs': crash })
      const probe = await h.servers.probe(site, version, { ...PROBE, timeoutMs: 5000 })
      expect(probe.ok).toBe(false)
      expect(probe.logs.join('\n')).toContain('missing config: BOOM')
    })

    it('the start probe: a server that never listens is no answer within the timeout', async () => {
      const silent = 'setInterval(() => {}, 1000)'
      const { h, site, version } = await ready({ '_fling/server.mjs': silent })
      const started = Date.now()
      const probe = await h.servers.probe(site, version, { ...PROBE, timeoutMs: 1500 })
      expect(probe.ok).toBe(false)
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('reconfigure: the live version runs with the new secrets', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch() },
        { GREETING: 'one' }
      )
      await h.servers.probe(site, version, PROBE)
      await h.servers.reconfigure(site, version, options({ GREETING: 'two' }))
      const res = await h.servers.invoke(site, version, request('/api/hello'))
      expect((await res.json()).env).toBe('two')
    })

    it('activate is idempotent: a version activated again keeps answering', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch() },
        { GREETING: 'same' }
      )
      await h.servers.activate(site, version, options({ GREETING: 'same' }))
      const res = await h.servers.invoke(site, version, request('/api/hello'))
      expect((await res.json()).env).toBe('same')
    })

    it('two versions of one site run side by side', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch() },
        { GREETING: 'first' }
      )
      const second = await h.putVersion(site, uid(), {
        '_fling/server.mjs': SERVER_FIXTURES.node(),
      })
      await h.servers.activate(site, second, options({ GREETING: 'second' }))
      const a = await h.servers.invoke(site, version, request('/api/hello'))
      const b = await h.servers.invoke(site, second, request('/api/hello'))
      expect((await a.json()).kind).toBe('fetch')
      expect(await b.json()).toMatchObject({ kind: 'node', env: 'second' })
    })

    it('setEnabled: a stopped site answers 503 until it runs again; retire forgets it', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch() },
        { GREETING: 'g' }
      )
      await h.servers.setEnabled(site, false)
      expect((await h.servers.invoke(site, version, request('/api/hello'))).status).toBe(503)
      await h.servers.setEnabled(site, true)
      const again = await h.servers.invoke(site, version, request('/api/hello'))
      expect(again.status).toBe(200)
      await again.body?.cancel()
      await h.servers.retire(site, version)
      const gone = await h.servers.invoke(site, version, request('/api/hello'))
      expect(gone.status).not.toBe(200)
      await h.servers.retire(site)
    })

    it('what a server prints reaches its log, naming the version', async () => {
      const { h, site, version } = await ready(
        { '_fling/server.mjs': SERVER_FIXTURES.fetch() },
        { GREETING: 'g' }
      )
      const n = uid()
      const res = await h.servers.invoke(site, version, request(`/api/log?n=${n}`))
      await res.text()
      const since = new Date(Date.now() - 60_000)
      const lines = await eventually(
        () => h.logs.read(site.id, since, 1000),
        ls => ls.some(l => l.text === `logged ${n}`),
        h.logsWithinMs ?? 5000
      )
      const line = lines.find(l => l.text === `logged ${n}`)
      expect(line).toMatchObject({ kind: 'output', versionId: version.id })
      expect(lines.some(l => l.text === 'an error line' && l.level === 'error')).toBe(true)
    })
  })
}

export function serverLogsConformance(name: string, factory: () => Promise<ServerLogsHarness>) {
  describe(`ServerLogs conformance: ${name}`, () => {
    const line = (at: string, text: string, versionId = 'v1'): ServerLogLine => ({
      at,
      versionId,
      kind: 'output',
      level: 'info',
      text,
    })
    const now = Date.now()
    const ago = (s: number) => new Date(now - s * 1000).toISOString()

    it('reads lines since a time, oldest first, at most limit, per site', async () => {
      const h = await factory()
      const [site, other] = [uid(), uid()]
      await h.write(site, [line(ago(30), 'c'), line(ago(50), 'a')])
      await h.write(site, [line(ago(40), 'b')])
      await h.write(other, [line(ago(45), 'elsewhere')])
      const all = await h.logs.read(site, new Date(now - 60_000), 100)
      expect(all.map(l => l.text)).toEqual(['a', 'b', 'c'])
      const recent = await h.logs.read(site, new Date(now - 45_000), 100)
      expect(recent.map(l => l.text)).toEqual(['b', 'c'])
      expect((await h.logs.read(site, new Date(now - 60_000), 2)).map(l => l.text)).toEqual([
        'a',
        'b',
      ])
      expect(await h.logs.read(uid(), new Date(now - 60_000), 100)).toEqual([])
    })

    it('keeps a request line as written', async () => {
      const h = await factory()
      const site = uid()
      const request: ServerLogLine = {
        at: ago(10),
        versionId: 'v2',
        kind: 'request',
        method: 'POST',
        path: '/api/request',
        status: 201,
        ms: 41,
        viewer: 'v_abcdefghijklm',
      }
      await h.write(site, [request])
      expect(await h.logs.read(site, new Date(now - 60_000), 10)).toEqual([request])
    })
  })
}
