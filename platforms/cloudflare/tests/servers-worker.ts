/**
 * The Worker the site server tests run in workerd (bundled by servers.test.ts): CloudflareSiteServers
 * on Miniflare's Worker Loader, R2 and rate-limit binding, with the real SiteFiles and ServerTail
 * entrypoints exported as the Fling Worker exports them. The tests drive the port from Node over
 * HTTP: `POST /port/<method>` with the arguments as JSON, `/invoke` with the request itself (its
 * site and version in headers), and `/logs/read`, `/logs/write`, `/logs/compact`.
 */
import { exports } from 'cloudflare:workers'
import type { R2Bucket, RateLimit, WorkerLoader } from '@cloudflare/workers-types'
import type { ServerLogLine } from '@fling/api/servers/types'
import { serverBindings } from '../src/servers/entrypoints.ts'
import { serverLogsIn } from '../src/servers/logs.ts'
import { CloudflareSiteServers } from '../src/servers/runtime.ts'

export { ServerTail, SiteFiles } from '../src/servers/entrypoints.ts'

interface Env {
  BUCKET: R2Bucket
  LOADER: WorkerLoader
  SERVER_RATE_LIMIT: RateLimit
  KEY: string
  COMPATIBILITY_DATE: string
}

let servers: CloudflareSiteServers | undefined

const make = (env: Env) =>
  new CloudflareSiteServers({
    loader: env.LOADER,
    bucket: env.BUCKET,
    bindings: serverBindings(exports),
    key: env.KEY,
    rateLimit: env.SERVER_RATE_LIMIT,
    baseRps: 1,
    compatibilityDate: env.COMPATIBILITY_DATE,
  })

export default {
  async fetch(request: Request, env: Env) {
    servers ??= make(env)
    const url = new URL(request.url)
    const logs = serverLogsIn(env.BUCKET)
    if (url.pathname === '/invoke') {
      const site = JSON.parse(request.headers.get('x-test-site') ?? '{}')
      const version = JSON.parse(request.headers.get('x-test-version') ?? '{}')
      const run = request.headers.get('x-test-run')
      const headers = new Headers(request.headers)
      for (const h of ['x-test-site', 'x-test-version', 'x-test-run', 'x-test-url', 'x-test-fresh'])
        headers.delete(h)
      const forwarded = new Request(request.headers.get('x-test-url') ?? request.url, {
        method: request.method,
        headers,
        body: request.body,
      })
      // As another isolate of the Worker would: nothing activated here.
      const fresh = request.headers.get('x-test-fresh') ? make(env) : servers
      return fresh.serve(site, version, forwarded, run)
    }
    const args = (await request.json()) as unknown[]
    if (url.pathname.startsWith('/port/')) {
      const method = url.pathname.slice(6) as
        | 'activate'
        | 'probe'
        | 'reconfigure'
        | 'setEnabled'
        | 'retire'
      const fn = servers[method] as (...a: unknown[]) => Promise<unknown>
      return Response.json((await fn.apply(servers, args)) ?? null)
    }
    if (url.pathname === '/logs/read') {
      const [siteId, since, limit] = args as [string, string, number]
      return Response.json(await logs.read(siteId, new Date(since), limit))
    }
    if (url.pathname === '/logs/write') {
      const [siteId, lines] = args as [string, ServerLogLine[]]
      await logs.append(siteId, lines)
      return Response.json(null)
    }
    if (url.pathname === '/logs/compact')
      return Response.json(await logs.compact(Date.now() + 10_000))
    return new Response(null, { status: 404 })
  },
}
