/**
 * The sites host (`<name>.<sitesDomain>`, `s--<token>.<sitesDomain>`): the shared routing decision
 * (@fling/shared/site-routing, the one the CloudFront Function runs) over the route table, then the
 * object from R2. This file only adapts: it reads the request, provides the lookups and turns the
 * decision into a response. Unknown hosts, archived sites and missing files get the sites' 404
 * page (`_fling/404.html` from the Worker's assets, its `__APP_ORIGIN__` filled in), never cached.
 */
import { createHmac } from 'node:crypto'
import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types'
import type { RouteTable } from '@fling/api/route-table'
import { MISSING_KEY, NOT_FOUND_PAGE } from '@fling/shared/route-keys'
import { normalizeQuery, routeSiteRequest } from '@fling/shared/site-routing'
import type { Bindings } from './env.ts'

export interface SitesOptions {
  appOrigin: string
  siteScheme: string
  cookieKey: string
  routeTable: RouteTable
  bucket: R2Bucket
  assets: Bindings['ASSETS']
  now?: () => number
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

let notFoundPage: { origin: string; html: string } | undefined

/** The sites' 404 page, filled for this instance (cached per isolate). */
async function notFound(opts: SitesOptions, status: number, method: string): Promise<Response> {
  if (notFoundPage?.origin !== opts.appOrigin) {
    // `/_fling/404` (no extension): Static Assets serves 404.html for it without a redirect.
    const res = await opts.assets.fetch('https://assets.invalid/_fling/404')
    const html = res.ok ? await res.text() : 'Not found'
    notFoundPage = {
      origin: opts.appOrigin,
      html: html.replaceAll('__APP_ORIGIN__', opts.appOrigin),
    }
  }
  return new Response(method === 'HEAD' ? null : notFoundPage.html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
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
      cookie: cookieValue(request.headers.get('cookie'), 'fling_site'),
    },
    {
      appOrigin: opts.appOrigin,
      siteScheme: opts.siteScheme,
      nowSeconds: Math.floor((opts.now ?? Date.now)() / 1000),
      getRoute: async key => (await opts.routeTable.get(key)) ?? null,
      getCookieKey: async () => opts.cookieKey,
      hmac,
    }
  )
  if (decision.action === 'respond') {
    return new Response(null, { status: decision.status, headers: decision.headers })
  }
  if (decision.uri === NOT_FOUND_PAGE) return notFound(opts, 200, request.method)
  if (decision.uri === MISSING_KEY) return notFound(opts, 404, request.method)
  let key: string
  try {
    // The object key is the decoded path, as S3 reads a CloudFront origin request's.
    key = decodeURIComponent(decision.uri.slice(1))
  } catch {
    return notFound(opts, 404, request.method)
  }
  return serveObject(request, opts, key)
}
