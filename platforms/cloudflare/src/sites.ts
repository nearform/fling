/**
 * The Worker's sites host (`<name>.<sitesDomain>`, `s--<token>.<sitesDomain>`): the core's sites
 * host (@fling/api/sites-host: the shared routing decision over the route table, carried out the
 * same way on every platform where one host routes) with what Cloudflare supplies. Site files come
 * from R2 with their stored Content-Type and Cache-Control, ETag revalidation and ranges. Fling's
 * own pages (`_fling/404.html`, `_fling/review.html`, `_fling/robots.txt`) come from the Worker's
 * assets, their `__APP_ORIGIN__` filled in.
 *
 * A site server's request (the decision's `invoke`, `/api/*` of a site whose version has one) goes
 * through the core's shell (`runInvoke`: the server's request headers, its Cache-Control, the
 * request line) to the version's isolate (servers/runtime.ts), in the run the route value names
 * (`t`). With no SiteServers (SERVERS off) it answers as a missing page.
 *
 * A view a page's beacon reports (SITE_SEEN_PATH) is handed to `seen`: the Worker counts it in the
 * isolate's ViewCounter and flushes after the response, at most every FLUSH_INTERVAL_MS.
 */
import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types'
import type { RouteTable } from '@fling/api/route-table'
import type { ServerLogs, SiteServers } from '@fling/api/servers/types'
import {
  handleSiteRequest as handleSitesHostRequest,
  invokeSiteServer,
  type SitesPage,
} from '@fling/api/sites-host'
import type { Clock } from '@fling/api/types'
import { NOT_FOUND_PAGE, REVIEW_SHELL, ROBOTS_TXT } from '@fling/shared/route-keys'
import type { SiteInvoke } from '@fling/shared/site-routing'
import type { Bindings } from './env.ts'
import type { CloudflareSiteServers } from './servers/runtime.ts'

export interface SitesOptions {
  appOrigin: string
  siteScheme: string
  cookieKey: string
  routeTable: RouteTable
  /**
   * Where the revocation list is read: KV alone, not KV and D1 as routes are. A key on the list is
   * missing for nearly every request, and a miss there would otherwise cost a D1 read; KV shows a
   * new revocation within about a minute.
   */
  revocations: RouteTable
  bucket: R2Bucket
  assets: Bindings['ASSETS']
  /** runs site servers (SERVERS on), with their logs and the clock the request lines take */
  servers?: { runtime: CloudflareSiteServers; logs: ServerLogs; clock: Clock }
  /** a view a page's beacon reported (absent: views are not counted) */
  seen?(siteId: string): void
  now?: () => number
  /** how long a site pass lasts (default: the routing decision's, 5 minutes) */
  passTtlSeconds?: number
}

const pages = new Map<string, { origin: string; html: string | null }>()

/** Where each of Fling's pages is in the Worker's assets. */
const ASSET_OF: Record<SitesPage, string> = {
  // No extension: Static Assets serves 404.html for it without a redirect.
  [NOT_FOUND_PAGE]: '/_fling/404',
  [REVIEW_SHELL]: '/_fling/review',
  [ROBOTS_TXT]: ROBOTS_TXT,
}

/** A file from the Worker's assets with this instance's app origin filled in (cached per isolate). */
async function assetPage(opts: SitesOptions, asset: string): Promise<string | null> {
  let page = pages.get(asset)
  if (page?.origin !== opts.appOrigin) {
    const res = await opts.assets.fetch(`https://assets.invalid${asset}`)
    const html = res.ok ? await res.text() : null
    page = {
      origin: opts.appOrigin,
      html: html?.replaceAll('__APP_ORIGIN__', opts.appOrigin) ?? null,
    }
    pages.set(asset, page)
  }
  return page.html
}

const hasBody = (o: R2Object | R2ObjectBody): o is R2ObjectBody => 'body' in o

/** A site file: R2 with its stored Content-Type/Cache-Control, ETag revalidation and ranges. */
async function serveObject(request: Request, opts: SitesOptions, key: string) {
  const head = request.method === 'HEAD'
  const object = head
    ? await opts.bucket.head(key)
    : await opts.bucket.get(key, {
        onlyIf: request.headers as never,
        range: request.headers as never,
      })
  if (!object) return null
  const headers = new Headers()
  object.writeHttpMetadata(headers as never)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  if (!head && !hasBody(object)) return new Response(null, { status: 304, headers })
  if (head) {
    headers.set('content-length', String(object.size))
    return new Response(null, { status: 200, headers })
  }
  const body = object as R2ObjectBody
  const range = body.range as { offset?: number; length?: number } | undefined
  if (
    request.headers.has('range') &&
    range &&
    (range.offset !== undefined || range.length !== undefined)
  ) {
    const offset = range.offset ?? 0
    const length = range.length ?? body.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${body.size}`)
    return new Response(body.body as never, { status: 206, headers })
  }
  return new Response(body.body as never, { status: 200, headers })
}

export function handleSiteRequest(request: Request, opts: SitesOptions): Promise<Response> {
  return handleSitesHostRequest(request, {
    appOrigin: opts.appOrigin,
    siteScheme: opts.siteScheme,
    cookieKey: opts.cookieKey,
    routes: opts.routeTable,
    revocations: opts.revocations,
    page: page => assetPage(opts, ASSET_OF[page]),
    object: (req, key) => serveObject(req, opts, key),
    ...(opts.servers
      ? { invoke: (req, decision) => invoke(req, opts.servers as never, decision) }
      : {}),
    ...(opts.seen ? { seen: opts.seen } : {}),
    now: opts.now,
    passTtlSeconds: opts.passTtlSeconds,
  })
}

/** The request through the shell to the version's server, in the run the route names. */
async function invoke(
  request: Request,
  servers: NonNullable<SitesOptions['servers']>,
  decision: SiteInvoke
): Promise<Response> {
  const { runtime } = servers
  // The shell asks the port; this host answers with the route's run.
  const atRun: SiteServers = {
    activate: (...a) => runtime.activate(...a),
    probe: (...a) => runtime.probe(...a),
    reconfigure: (...a) => runtime.reconfigure(...a),
    setEnabled: (...a) => runtime.setEnabled(...a),
    retire: (...a) => runtime.retire(...a),
    invoke: (site, version, req) => runtime.serve(site, version, req, decision.target),
  }
  return invokeSiteServer(
    { servers: atRun, serverLogs: servers.logs, clock: servers.clock },
    request,
    decision
  )
}
