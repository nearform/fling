/**
 * The sites host (`<name>.<sitesDomain>`, `s--<token>.<sitesDomain>`): the shared routing decision
 * (@fling/shared/site-routing, the one the CloudFront Function runs) over the route table, then the
 * object from R2. This file only adapts: it reads the request, provides the lookups and turns the
 * decision into a response. Unknown hosts, archived sites and missing files get the sites' 404
 * page (`_fling/404.html` from the Worker's assets, its `__APP_ORIGIN__` filled in), never cached.
 * The review shell (`_fling/review.html`) comes from the assets the same way, revalidated on every
 * use and with no header that would stop the app from framing it. `/robots.txt` on every sites
 * host is Fling's `Disallow: /` (`_fling/robots.txt` from the assets), whatever the site has. Every
 * response carries the decision's headers: `X-Robots-Tag: noindex`, on a share host
 * `Referrer-Policy: no-referrer`, so its address never leaks as a Referer, and on a site's files
 * `X-Fling-Version`, the version served.
 */
import { createHmac } from 'node:crypto'
import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types'
import type { RouteTable } from '@fling/api/route-table'
import {
  MISSING_KEY,
  NOT_FOUND_PAGE,
  REVIEW_SHELL,
  ROBOTS_TXT,
  SITE_PASS_COOKIE_NAME,
} from '@fling/shared/route-keys'
import { SITE_COOKIE_NAME } from '@fling/shared/site-cookie'
import { normalizeQuery, routeSiteRequest } from '@fling/shared/site-routing'
import type { Bindings } from './env.ts'

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

const pages = new Map<string, { origin: string; html: string | null }>()

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

/** The sites' 404 page, filled for this instance. */
async function notFound(opts: SitesOptions, status: number, method: string): Promise<Response> {
  // `/_fling/404` (no extension): Static Assets serves 404.html for it without a redirect.
  const html = (await assetPage(opts, '/_fling/404')) ?? 'Not found'
  return new Response(method === 'HEAD' ? null : html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The review shell, filled for this instance. */
async function reviewShell(opts: SitesOptions, method: string): Promise<Response> {
  const html = await assetPage(opts, '/_fling/review')
  if (html === null) return notFound(opts, 404, method)
  return new Response(method === 'HEAD' ? null : html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** Fling's robots.txt for every sites host. */
async function robotsTxt(opts: SitesOptions, method: string): Promise<Response> {
  const text = await assetPage(opts, ROBOTS_TXT)
  if (text === null) return notFound(opts, 404, method)
  return new Response(method === 'HEAD' ? null : text, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  })
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
  if (!object) return notFound(opts, 404, request.method)
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

export async function handleSiteRequest(request: Request, opts: SitesOptions): Promise<Response> {
  const url = new URL(request.url)
  const decision = await routeSiteRequest(
    {
      method: request.method,
      host: url.host,
      uri: url.pathname,
      query: normalizeQuery(url.search),
      cookie: cookieValue(request.headers.get('cookie'), SITE_COOKIE_NAME),
      pass: cookieValue(request.headers.get('cookie'), SITE_PASS_COOKIE_NAME),
    },
    {
      appOrigin: opts.appOrigin,
      siteScheme: opts.siteScheme,
      nowSeconds: Math.floor((opts.now ?? Date.now)() / 1000),
      getRoute: async key => (await opts.routeTable.get(key)) ?? null,
      getCookieKey: async () => opts.cookieKey,
      getRevocation: async key => (await opts.revocations.get(key)) ?? null,
      hmac,
      passTtlSeconds: opts.passTtlSeconds,
    }
  )
  if (decision.action === 'respond') {
    const headers = new Headers(decision.headers)
    for (const [name, cookie] of Object.entries(decision.cookies ?? {})) {
      headers.append('set-cookie', `${name}=${cookie.value}; ${cookie.attributes}`)
    }
    return new Response(null, { status: decision.status, headers })
  }
  // The host's headers on whatever is served: file, 404 page, review shell or robots.txt.
  const res = await serveRewrite(request, opts, decision.uri)
  for (const [name, value] of Object.entries(decision.headers)) res.headers.set(name, value)
  return res
}

function serveRewrite(request: Request, opts: SitesOptions, uri: string): Promise<Response> {
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
  return serveObject(request, opts, key)
}
