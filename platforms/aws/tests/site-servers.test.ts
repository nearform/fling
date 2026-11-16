/**
 * Site servers on AWS against the local fake of Lambda Web Functions (fake-web-functions.ts): the
 * conformance suites, which run the real entry (web-entry.ts, bundled as Lambda gets it) inside the
 * real zip, and what is AWS's own: a version is probed on the probe endpoint before `live` routes
 * to it, revisions are found again rather than made twice, limits as Lambda's steps, the kill
 * switch, the quota and egress refusals, retire, and the sweep.
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestKey } from '@fling/api/blobs'
import { FsBlobs } from '@fling/api/blobs/fs'
import type { ServerLimits } from '@fling/api/config'
import { serverVersion } from '@fling/api/servers'
import type { ServerOptions, ServerSite } from '@fling/api/servers/types'
import { SERVER_FIXTURES, serverLogsConformance, siteServersConformance } from '@fling/conformance'
import {
  EDGE_SERVER_READ_TIMEOUT_SECONDS,
  SERVER_STAND_IN_STATUS,
  SERVER_STATUS_HEADER,
} from '@fling/shared/route-keys'
import { afterAll, describe, expect, it } from 'vitest'
import { buildServerEntry } from '../scripts/server-entry.mjs'
import { requestLogText } from '../src/servers/entry-contract.ts'
import { LIVE_ENDPOINT, PROBE_ENDPOINT, revisionLabel } from '../src/servers/naming.ts'
import { CloudWatchServerLogs } from '../src/servers/server-logs.ts'
import {
  type AwsServersSettings,
  AwsSiteServers,
  environmentsStep,
  rateStep,
} from '../src/servers/site-servers.ts'
import { loadServerRuntime, type ServerRuntime } from '../src/servers/zip.ts'
import { FakeLogEvents, FakeWebFunctions, MemoryZips } from './fake-web-functions.ts'

const PREFIX = 'acme-test-fling-site-'
const SETTINGS: AwsServersSettings = {
  functionPrefix: PREFIX,
  instance: 'acme-test-fling',
  roleArn: 'arn:aws:iam::123456789012:role/acme-test-fling-server',
  distributionArn: 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE',
  connectorArn: 'arn:aws:lambda:eu-west-1:123456789012:network-connector:acme:1',
  maxSites: 50,
  environments: 2,
}

let runtime: Promise<ServerRuntime> | undefined
const roots: string[] = []
const loadRuntime = () => {
  runtime ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fling-server-entry-'))
    roots.push(dir)
    await buildServerEntry(dir)
    return loadServerRuntime(new URL(`file://${dir}/`))
  })()
  return runtime
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

function harness(settings: Partial<AwsServersSettings> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fling-aws-servers-'))
  roots.push(root)
  const blobs = new FsBlobs(join(root, 'blobs'), 'http://localhost:0', 'x'.repeat(32))
  const zips = new MemoryZips()
  const logEvents = new FakeLogEvents()
  const functions = new FakeWebFunctions(zips, logEvents, join(root, 'run'))
  const logs = new CloudWatchServerLogs(logEvents, functions, PREFIX)
  const servers = new AwsSiteServers({
    settings: { ...SETTINGS, ...settings },
    functions,
    zips,
    blobs,
    logs,
    logEvents,
    runtime: loadRuntime,
    pollMs: 10,
  })
  return {
    servers,
    logs,
    functions,
    zips,
    logEvents,
    async putVersion(
      site: ServerSite,
      versionId: string,
      files: Record<string, string | Uint8Array>
    ) {
      const version = serverVersion(site.id, versionId)
      const manifest: { path: string; size: number }[] = []
      for (const [path, body] of Object.entries(files)) {
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
        await blobs.put(`${version.files}${path}`, bytes)
        manifest.push({ path, size: bytes.length })
      }
      await blobs.putJson(manifestKey(site.id, versionId), { files: manifest })
      return version
    },
    close: () => functions.close(),
  }
}

siteServersConformance('AwsSiteServers (fake Web Functions)', async () => harness())

serverLogsConformance('CloudWatchServerLogs (fake CloudWatch)', async () => {
  const logEvents = new FakeLogEvents()
  const functions = new FakeWebFunctions(new MemoryZips(), logEvents, tmpdir())
  const logs = new CloudWatchServerLogs(logEvents, functions, PREFIX)
  return {
    logs,
    async write(siteId, lines) {
      const fn = `${PREFIX}${siteId}`
      for (const line of lines) {
        // the revision the line's version runs as, as a function would have it
        let f = functions.functions.get(fn)
        if (!f) {
          await functions.createFunction({
            name: fn,
            tags: {},
            revision: {
              description: revisionLabel('none', '0'),
              zip: { bucket: '', key: '', versionId: '' },
              roleArn: '',
              timeoutSeconds: 30,
              environment: {},
            },
            endpoint: { name: LIVE_ENDPOINT, rateLimit: 100, maxEnvironments: 2 },
          })
          f = functions.functions.get(fn)
        }
        const label = revisionLabel(line.versionId, 'h')
        const rev =
          (await functions.listRevisions(fn)).find(r => r.description === label)?.revisionId ??
          (await functions.createRevision(fn, {
            description: label,
            zip: { bucket: '', key: '', versionId: '' },
            roleArn: '',
            timeoutSeconds: 30,
            environment: {},
          }))
        const timestamp = Date.parse(line.at)
        const message =
          line.kind === 'request'
            ? requestLogText(line)
            : JSON.stringify({
                timestamp: line.at,
                level: line.level === 'error' ? 'ERROR' : 'INFO',
                message: line.text,
              })
        logEvents.add(`/aws/lambda/web/${fn}`, {
          timestamp,
          stream: `2026/11/15/${fn}[${rev}]fake`,
          message,
        })
      }
    },
  }
})

const LIMITS: ServerLimits = {
  timeoutSeconds: 30,
  cpuMs: 1000,
  rps: 100,
  environments: 2,
  bodyBytes: 1024 * 1024,
}
const options = (over: Partial<ServerOptions> = {}): ServerOptions => ({
  secrets: {},
  egress: 'none',
  limits: LIMITS,
  ...over,
})
const PROBE = { method: 'GET' as const, path: '/api/', timeoutMs: 10_000 }
let n = 0
const site = (): ServerSite => ({ id: `site${++n}abcdefg`.slice(0, 12), name: `site-${n}` })

describe('AwsSiteServers', () => {
  const made: ReturnType<typeof harness>[] = []
  const make = (settings: Partial<AwsServersSettings> = {}) => {
    const h = harness(settings)
    made.push(h)
    return h
  }
  afterAll(async () => {
    for (const h of made) await h.close()
  })

  it('rounds limits to the steps Lambda takes', () => {
    expect([1, 100, 101, 950, 1000, 1001, 4500, 50_000].map(rateStep)).toEqual([
      100, 100, 200, 1000, 1000, 2000, 5000, 10_000,
    ])
    expect([1, 2, 7, 20_000].map(environmentsStep)).toEqual([2, 2, 7, 10_000])
  })

  it('probes a version on the probe endpoint; live routes to it only once it goes live', async () => {
    const h = make()
    const s = site()
    const v1 = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const { target } = await h.servers.activate(s, v1, options({ secrets: { GREETING: 'a' } }))
    const fn = `${PREFIX}${s.id}`
    expect(target).toBe((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.domainName)
    expect(await h.servers.probe(s, v1, PROBE)).toMatchObject({ ok: true, status: 404 })
    await h.servers.goLive(s, v1)
    const firstLive = (await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights

    const v2 = await h.putVersion(s, 'v2', { '_fling/server.mjs': SERVER_FIXTURES.node() })
    const again = await h.servers.activate(s, v2, options({ secrets: { GREETING: 'b' } }))
    expect(again.target).toBe(target)
    expect(await h.servers.probe(s, v2, PROBE)).toMatchObject({ ok: true, status: 404 })
    // probed, not live: live still routes to v1's revision
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights).toEqual(firstLive)
    const probeWeights = (await h.functions.getEndpoint(fn, PROBE_ENDPOINT))?.weights ?? []
    expect(probeWeights[0]?.revisionId).not.toBe(firstLive?.[0]?.revisionId)

    await h.servers.goLive(s, v2)
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights).toEqual(probeWeights)

    // rollback: the old revision is still there, so it is one weights change
    const before = h.functions.calls.filter(c => c === 'createRevision').length
    await h.servers.activate(s, v1, options({ secrets: { GREETING: 'a' } }))
    await h.servers.goLive(s, v1)
    expect(h.functions.calls.filter(c => c === 'createRevision').length).toBe(before)
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights).toEqual(firstLive)
  })

  it('a probe answered by the revision before (the switch still rolling out) asks again', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(s, v, options())
    const real = h.functions.fetch.bind(h.functions)
    let calls = 0
    h.functions.fetch = async (domain, request, signal) => {
      calls++
      if (calls === 1) {
        return new Response('old', { headers: { 'lambda-web-logstream': `x/${s.id}[rev-old]a` } })
      }
      return real(domain, request, signal)
    }
    expect(await h.servers.probe(s, v, PROBE)).toMatchObject({ ok: true, status: 404 })
    expect(calls).toBe(2)
  })

  it('creates the function with its fence: tags, the distribution-only policy, log retention', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(s, v, options())
    const f = h.functions.functions.get(`${PREFIX}${s.id}`)
    expect(f?.tags).toMatchObject({ 'fling:instance': SETTINGS.instance, 'fling:site': s.name })
    const policy = JSON.parse(f?.policy ?? '{}')
    expect(policy.Statement[0]).toMatchObject({
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 'lambda:InvokeWebFunctionEndpoint',
      Resource: `${f?.arn}/endpoint/live`,
      Condition: { StringEquals: { 'aws:SourceArn': SETTINGS.distributionArn } },
    })
    expect(h.logEvents.retention.get(`/aws/lambda/web/${PREFIX}${s.id}`)).toBe(7)
    expect(h.logEvents.retention.get(`/aws/lambda/web/${PREFIX}${s.id}.local`)).toBe(7)
    const [revision] = await h.functions.listRevisions(`${PREFIX}${s.id}`)
    const spec = f?.revisions.get(revision?.revisionId ?? '')?.spec
    expect(spec).toMatchObject({ roleArn: SETTINGS.roleArn, connectorArn: SETTINGS.connectorArn })
  })

  it('a server with no secrets, or an empty one, sets no empty environment value (Lambda refuses one)', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const fn = `${PREFIX}${s.id}`
    await h.servers.activate(s, v, options({ secrets: { EMPTY: '', GREETING: 'hi' } }))
    const [revision] = await h.functions.listRevisions(fn)
    const env = revision?.spec.environment ?? {}
    expect(env).not.toHaveProperty('EMPTY')
    expect(env.FLING_SECRET_NAMES).toBe('GREETING')

    const bare = site()
    const w = await h.putVersion(bare, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(bare, w, options({ secrets: {} }))
    const [only] = await h.functions.listRevisions(`${PREFIX}${bare.id}`)
    expect(only?.spec.environment).not.toHaveProperty('FLING_SECRET_NAMES')
  })

  it('reconfigure with the same options makes no revision; a new secret makes one, live at once', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const fn = `${PREFIX}${s.id}`
    await h.servers.activate(s, v, options({ secrets: { GREETING: 'one' } }))
    await h.servers.goLive(s, v)
    await h.servers.reconfigure(s, v, options({ secrets: { GREETING: 'one' } }))
    expect(await h.functions.listRevisions(fn)).toHaveLength(1)
    await h.servers.reconfigure(s, v, options({ secrets: { GREETING: 'two' } }))
    const revisions = await h.functions.listRevisions(fn)
    expect(revisions).toHaveLength(2)
    const newest = revisions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights).toEqual([
      { revisionId: newest?.revisionId, weight: 100 },
    ])
    // the one with the old secret goes before the next is made
    await h.servers.reconfigure(s, v, options({ secrets: { GREETING: 'three' } }))
    const after = await h.functions.listRevisions(fn)
    expect(after.some(r => r.revisionId === revisions.find(x => x !== newest)?.revisionId)).toBe(
      false
    )
  })

  it('limits: the live endpoint follows rps and environments; the kill switch holds at 0', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const fn = `${PREFIX}${s.id}`
    await h.servers.activate(s, v, options({ limits: { ...LIMITS, rps: 250, environments: 4 } }))
    expect(await h.functions.getEndpoint(fn, LIVE_ENDPOINT)).toMatchObject({
      rateLimit: 300,
      maxEnvironments: 4,
    })
    await h.servers.setEnabled(s, false)
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.rateLimit).toBe(0)
    await h.servers.reconfigure(s, v, options({ limits: { ...LIMITS, rps: 500, environments: 4 } }))
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.rateLimit).toBe(0)
    await h.servers.setEnabled(s, true)
    expect((await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.rateLimit).toBe(500)
  })

  it('refuses egress none without a network connector, and a first server past the vCPU quota', async () => {
    const open = make({ connectorArn: undefined })
    const s = site()
    const v = await open.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await expect(open.servers.activate(s, v, options())).rejects.toMatchObject({
      status: 409,
      code: 'servers_egress_unavailable',
    })
    await expect(
      open.servers.activate(s, v, options({ egress: 'open', secrets: { AWS_REGION: 'x' } }))
    ).rejects.toMatchObject({ status: 400, code: 'invalid_secret_name' })
    await open.servers.activate(s, v, options({ egress: 'open' }))
    const spec = [
      ...(open.functions.functions.get(`${PREFIX}${s.id}`)?.revisions.values() ?? []),
    ][0]?.spec
    expect(spec?.connectorArn).toBeUndefined()

    const small = make({ maxSites: 50, environments: 2 })
    small.functions.vcpus = 199
    const t = site()
    const w = await small.putVersion(t, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await expect(small.servers.activate(t, w, options())).rejects.toMatchObject({
      status: 409,
      code: 'servers_quota',
    })
  })

  it('retire: a version that is not live goes; the last one takes the function and its logs', async () => {
    const h = make()
    const s = site()
    const fn = `${PREFIX}${s.id}`
    const v1 = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    const v2 = await h.putVersion(s, 'v2', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(s, v1, options())
    await h.servers.goLive(s, v1)
    await h.servers.activate(s, v2, options())
    await h.servers.probe(s, v2, PROBE)
    await h.servers.retire(s, v2)
    expect((await h.functions.listRevisions(fn)).map(r => r.description.split(' ')[0])).toEqual([
      'v1',
    ])
    expect(await h.zips.find(`${s.id}/v2.zip`)).toBeNull()
    await h.servers.retire(s)
    expect(await h.functions.getFunction(fn)).toBeNull()
    expect(await h.logEvents.groups(`/aws/lambda/web/${fn}`)).toEqual([])
    expect(await h.zips.find(`${s.id}/v1.zip`)).toBeNull()
  })

  it('the sweep deletes functions whose site is gone and log groups whose function is', async () => {
    const h = make()
    const [kept, gone] = [site(), site()]
    for (const s of [kept, gone]) {
      const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
      await h.servers.activate(s, v, options())
    }
    // a group Lambda wrote again after its function was deleted
    await h.logEvents.retain(`/aws/lambda/web/${PREFIX}late12345678`, 7)
    const swept = await h.servers.sweep(async siteId => siteId === kept.id)
    expect(swept).toEqual({ functions: 1, logGroups: 1 })
    expect(await h.functions.getFunction(`${PREFIX}${kept.id}`)).not.toBeNull()
    expect(await h.functions.getFunction(`${PREFIX}${gone.id}`)).toBeNull()
    expect(await h.logEvents.groups(`/aws/lambda/web/${PREFIX}${kept.id}`)).toHaveLength(2)
  })

  it("sends a server's 404 as the stand-in status naming it, which invoke and the probe put back", async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(s, v, options())
    await h.servers.goLive(s, v)
    const fn = `${PREFIX}${s.id}`
    const domain = (await h.functions.getEndpoint(fn, LIVE_ENDPOINT))?.domainName ?? ''
    // What CloudFront gets from the Web Function: out of the custom error responses' reach.
    const raw = await h.functions.fetch(
      domain,
      new Request(`https://${domain}/api/nothing-here`, {
        headers: { 'x-fling-site': `${s.id}/v1/private` },
      })
    )
    await raw.body?.cancel()
    expect(raw.status).toBe(SERVER_STAND_IN_STATUS)
    expect(raw.headers.get(SERVER_STATUS_HEADER)).toBe('404')
    const res = await h.servers.invoke(
      s,
      v,
      new Request('https://x.sites.example.test/api/nothing-here', {
        headers: { 'x-fling-site': `${s.id}/v1/private` },
      })
    )
    expect(res.status).toBe(404)
    expect(res.headers.get(SERVER_STATUS_HEADER)).toBeNull()
    expect(await h.servers.probe(s, v, PROBE)).toMatchObject({ ok: true, status: 404 })
    const lines = await h.logs.read(s.id, new Date(Date.now() - 60_000), 100)
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: 'request', path: '/api/nothing-here', status: 404 })
    )
  })

  it('serves a request for at most as long as CloudFront waits', () => {
    expect(make().servers.maxTimeoutSeconds).toBe(EDGE_SERVER_READ_TIMEOUT_SECONDS)
  })

  it('logs a request line for every request, and Cache-Control as the core rules', async () => {
    const h = make()
    const s = site()
    const v = await h.putVersion(s, 'v1', { '_fling/server.mjs': SERVER_FIXTURES.fetch() })
    await h.servers.activate(s, v, options())
    const viewer = { id: 'v_abcdefghijklm', email: 'ada@example.test', guest: false }
    const res = await h.servers.invoke(
      s,
      v,
      new Request('https://x.sites.example.test/api/echo', {
        method: 'POST',
        body: 'hi',
        headers: {
          'x-fling-viewer': JSON.stringify(viewer),
          'x-fling-site': `${s.id}/v1/private`,
        },
      })
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('private, max-age=60')
    expect(res.headers.get('lambda-web-logstream')).toBeNull()
    const lines = await h.logs.read(s.id, new Date(Date.now() - 60_000), 100)
    expect(lines).toContainEqual(
      expect.objectContaining({
        kind: 'request',
        versionId: 'v1',
        method: 'POST',
        path: '/api/echo',
        status: 201,
        viewer: viewer.id,
      })
    )
    expect(lines.some(l => l.kind === 'output' && l.text === 'fetch server starting')).toBe(true)
  })
})
