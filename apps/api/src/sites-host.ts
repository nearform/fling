/**
 * The sites host of a platform where one host routes (the Cloudflare Worker, the Node host): a
 * request to `<name>.<sitesDomain>` or `s--<token>.<sitesDomain>` goes through the shared routing
 * decision (`routeSiteRequest`, @fling/shared/site-routing, the one the CloudFront Function runs),
 * and the decision becomes a response. This module only carries the decision out; the platform
 * supplies where things come from:
 *
 * - `routes` and `revocations`: the route table lookups the decision asks for;
 * - `page`: Fling's own pages (the sites' 404, the review shell, robots.txt), filled in for this
 *   instance (`__APP_ORIGIN__`);
 * - `object`: a site file from the platform's store, null when there is none;
 * - `invoke`: a site server's request (absent: SERVERS off, answered as a missing page);
 * - `seen`: a view the page's beacon reported (SITE_SEEN_PATH, which the decision makes an invoke
 *   with no server): the platform counts it (views.ts `ViewCounter`). It is answered with a 204
 *   either way, and absent nothing is counted.
 *
 * Unknown hosts, archived sites and missing files get the 404 page, never cached. What a site that
 * isn't public, or a share host, serves goes out `private` (serverCacheControl), so a cache keyed
 * by the viewer's URL in front of the host (Cloud CDN) never keeps it. The review shell
 * is revalidated on every use and carries no header that would stop the app framing it.
 * `/robots.txt` is Fling's `Disallow: /` on every sites host, whatever the site has. Every response
 * carries the decision's headers: `X-Robots-Tag: noindex`, on a share host
 * `Referrer-Policy: no-referrer`, and on a site's files `X-Fling-Version`, the version served.
 */
import { createHmac } from 'node:crypto'
import {
  MISSING_KEY,
  NOT_FOUND_PAGE,
  REVIEW_SHELL,
  ROBOTS_TXT,
  SITE_PASS_COOKIE_NAME,
  SITE_SEEN_PATH,
} from '@fling/shared/route-keys'
import { SITE_COOKIE_NAME } from '@fling/shared/site-cookie'
import { normalizeQuery, routeSiteRequest, type SiteInvoke } from '@fling/shared/site-routing'
import { serverCacheControl } from '@fling/shared/site-server'
import type { RouteTable } from './route-table/types.ts'
import { runInvoke } from './servers/shell.ts'
import type { ServerLogs, SiteServers } from './servers/types.ts'
import type { Clock } from './types.ts'

/** Fling's own pages on a sites host. */
export type SitesPage = typeof NOT_FOUND_PAGE | typeof REVIEW_SHELL | typeof ROBOTS_TXT

export interface SitesHostOptions {
  appOrigin: string
  siteScheme: string
  cookieKey: string
  routes: RouteTable
  /** where the revocation list is read (default `routes`) */
  revocations?: RouteTable
  /** a page's text with this instance's app origin filled in; null when the build has none */
  page(page: SitesPage): Promise<string | null>
  /** a site file (the decoded object key), or null when there is none */
  object(request: Request, key: string): Promise<Response | null>
  /** a site server's request, as the decision says (absent: no site servers) */
  invoke?(request: Request, decision: SiteInvoke): Promise<Response>
  /** a view of the site `siteId` (absent: views are not counted) */
  seen?(siteId: string): void
  now?: () => number
  /** how long a site pass lasts (default: the routing decision's, 5 minutes) */
  passTtlSeconds?: number
}

const hmac = (key: string, data: string) =>
  createHmac('sha256', key).update(data).digest('base64url')

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/** The sites' 404 page, filled for this instance. */
async function notFound(opts: SitesHostOptions, status: number, method: string) {
  const html = (await opts.page(NOT_FOUND_PAGE)) ?? 'Not found'
  return new Response(method === 'HEAD' ? null : html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function reviewShell(opts: SitesHostOptions, method: string) {
  const html = await opts.page(REVIEW_SHELL)
  if (html === null) return notFound(opts, 404, method)
  return new Response(method === 'HEAD' ? null : html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

async function robotsTxt(opts: SitesHostOptions, method: string) {
  const text = await opts.page(ROBOTS_TXT)
  if (text === null) return notFound(opts, 404, method)
  return new Response(method === 'HEAD' ? null : text, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  })
}

/** Set `headers` on a response, copying it first when its headers are immutable (a fetch's). */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) res.headers.set(name, value)
    return res
  } catch {
    const copy = new Response(res.body, res)
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
    return copy
  }
}

export async function handleSiteRequest(
  request: Request,
  opts: SitesHostOptions
): Promise<Response> {
  const url = new URL(request.url)
  const cookies = request.headers.get('cookie')
  const revocations = opts.revocations ?? opts.routes
  const decision = await routeSiteRequest(
    {
      method: request.method,
      host: url.host,
      uri: url.pathname,
      query: normalizeQuery(url.search),
      cookie: cookieValue(cookies, SITE_COOKIE_NAME),
      pass: cookieValue(cookies, SITE_PASS_COOKIE_NAME),
      fetchSite: request.headers.get('sec-fetch-site'),
      origin: request.headers.get('origin'),
    },
    {
      appOrigin: opts.appOrigin,
      siteScheme: opts.siteScheme,
      nowSeconds: Math.floor((opts.now ?? Date.now)() / 1000),
      getRoute: async key => (await opts.routes.get(key)) ?? null,
      getCookieKey: async () => opts.cookieKey,
      getRevocation: async key => (await revocations.get(key)) ?? null,
      hmac,
      passTtlSeconds: opts.passTtlSeconds,
    }
  )
  if (decision.action === 'respond') {
    const headers = new Headers(decision.headers)
    for (const [name, cookie] of Object.entries(decision.cookies ?? {})) {
      headers.append('set-cookie', `${name}=${cookie.value}; ${cookie.attributes}`)
    }
    if (decision.private) {
      headers.set('cache-control', serverCacheControl(headers.get('cache-control'), true))
    }
    return new Response(decision.body ?? null, { status: decision.status, headers })
  }
  if (decision.action === 'invoke' && url.pathname === SITE_SEEN_PATH) {
    // Only the beacon's POST counts (as on AWS, where the API takes only a POST there).
    if (request.method === 'POST') opts.seen?.(decision.siteId)
    return withHeaders(seenAnswer(), decision.headers)
  }
  if (decision.action === 'invoke') {
    if (!opts.invoke)
      return withHeaders(await notFound(opts, 404, request.method), decision.headers)
    return withHeaders(await opts.invoke(request, decision), decision.headers)
  }
  // The host's headers on whatever is served: file, 404 page, review shell or robots.txt.
  const res = await serveRewrite(request, opts, decision.uri)
  const headers = { ...decision.headers }
  // A file only the access checks may hand out is never kept by a shared cache in front of this
  // host: the stored `public, …, s-maxage` becomes `private`, as a site server's answer does.
  if (decision.private) {
    headers['cache-control'] = serverCacheControl(res.headers.get('cache-control'), true)
  }
  return withHeaders(res, headers)
}

/** What a view beacon gets back: nothing, never stored. */
export const seenAnswer = () =>
  new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })

async function serveRewrite(
  request: Request,
  opts: SitesHostOptions,
  uri: string
): Promise<Response> {
  if (uri === NOT_FOUND_PAGE) return notFound(opts, 200, request.method)
  if (uri === REVIEW_SHELL) return reviewShell(opts, request.method)
  if (uri === ROBOTS_TXT) return robotsTxt(opts, request.method)
  if (uri === MISSING_KEY) return notFound(opts, 404, request.method)
  let key: string
  try {
    // The object key is the decoded path, as S3 reads a CloudFront origin request's.
    key = decodeURIComponent(uri.slice(1))
  } catch {
    return notFound(opts, 404, request.method)
  }
  return (await opts.object(request, key)) ?? notFound(opts, 404, request.method)
}

/**
 * A site server's request through the core's shell (`runInvoke`: the server's request headers,
 * its Cache-Control, the request line) to `servers`, as the decision names it. A platform whose
 * runtime runs a version in more than one place hands in a `servers` that serves `decision.target`.
 */
export function invokeSiteServer(
  host: { servers: SiteServers; serverLogs?: ServerLogs; clock: Clock },
  request: Request,
  decision: SiteInvoke
): Promise<Response> {
  const label = new URL(request.url).hostname.split('.')[0] ?? ''
  return runInvoke(host, request, {
    site: { id: decision.siteId, name: label },
    v: decision.v,
    private: decision.private,
    viewer: decision.viewer,
  })
}
