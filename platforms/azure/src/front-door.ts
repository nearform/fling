/**
 * What the Container App does with a request before the Node host sees it. Every request reaches
 * it through Front Door (infra/edge.tf), which sends the Container App's own name as the Host
 * (Container Apps routes by it). Its rule set writes the name the visitor asked for (its
 * `{hostname}`) as `X-Fling-Host` and `X-Origin-Verify: <ORIGIN_VERIFY_SECRET>`, each overwriting
 * whatever the visitor sent under that name.
 *
 * - A request without the secret went around Front Door, to the app's own address: 403. Without a
 *   secret configured (local runs) every request passes, and in development a missing header is
 *   allowed (a wrong one never is), as the core's own check (`originVerify`) does.
 * - The Host is put back from X-Fling-Host, so the Node host routes the app host and the sites
 *   hosts as named. X-Forwarded-Host is never read: Front Door appends to one a visitor sends, so
 *   its value can be the visitor's. Both headers are dropped before the Node host sees the request.
 * - Front Door's cache sits in front of the app: a response it stores is served to the next
 *   visitor by URL (its cache key has no cookie) without the app deciding again. Azure documents
 *   how long it keeps one ("Caching with Azure Front Door", Cache expiration): for its `s-maxage`
 *   first, else its `max-age`, else its `Expires`, and for one to three days when it has no
 *   Cache-Control; and it never stores `private`, `no-cache` or `no-store`, whatever its rules
 *   say. DEPLOY.md (Checking the edge cache) shows how to see the cap live. So on the sites hosts
 *   (`edgeCacheControl`):
 *   - a response to a request carrying a site cookie (the site session or a site pass) is the
 *     viewer's own, and is made `private`;
 *   - any other response Front Door could store is held for at most `EDGE_MAX_AGE` (60 s): its
 *     `s-maxage` is capped, or set, while browsers keep its `max-age`. A publish, a rollback, a
 *     site made private, archived or deleted and a revoked share link reach every visitor within a
 *     minute, as on Google Cloud's CDN;
 *   - a response without Cache-Control is `no-cache`.
 *   A non-public site's file never reaches a request without a site cookie (the decision answers a
 *   302 with `no-store`), so Front Door never stores one. A share host's files need no cookie and
 *   are served with the file's own Cache-Control (`cacheControlFor`), so Front Door may store them:
 *   the 60 s cap is what bounds them after the link is revoked, as it bounds a public site's
 *   files after a publish or an access change.
 * - The hub's event handler (`LIVE_EVENTS_PATH` on the app host) goes to the live rooms.
 */
import { timingSafeEqual } from 'node:crypto'
import { SITE_PASS_COOKIE_NAME } from '@fling/shared'
import { SITE_COOKIE_NAME } from '@fling/shared/site-cookie'

export interface FrontDoorOptions {
  /** ORIGIN_VERIFY_SECRET */
  secret?: string
  /** a missing header passes (development) */
  allowMissing?: boolean
  /** SITES_DOMAIN: its hosts' responses get Front Door's caching rules (`edgeCacheControl`) */
  sitesDomain?: string
}

const forbidden = () =>
  Response.json(
    { error: { code: 'forbidden', message: 'Forbidden' } },
    { status: 403, headers: { 'cache-control': 'no-store' } }
  )

function verified(request: Request, opts: FrontDoorOptions): boolean {
  if (!opts.secret) return true
  const given = request.headers.get('x-origin-verify')
  if (given === null) return opts.allowMissing === true
  const a = Buffer.from(given)
  const b = Buffer.from(opts.secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The header Front Door's rule set writes the visitor's host name into (infra/edge.tf). */
export const HOST_HEADER = 'x-fling-host'

/** The request as the visitor sent it: Host from X-Fling-Host, when Front Door set one. */
export function visitorRequest(request: Request): Request {
  const named = request.headers.get(HOST_HEADER)?.trim()
  if (!named && !request.headers.has('x-forwarded-host')) return request
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  if (named) {
    url.host = named
    headers.set('host', named)
  }
  headers.delete(HOST_HEADER)
  headers.delete('x-forwarded-host')
  return new Request(url, {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    redirect: 'manual',
  } as RequestInit)
}

/** The longest Front Door holds a sites-host response, in seconds. */
export const EDGE_MAX_AGE = 60

/** The directives Front Door never stores a response with. */
const UNCACHEABLE = new Set(['private', 'no-cache', 'no-store'])

/**
 * The Cache-Control a sites-host response leaves for Front Door with: `private` when the request
 * carried a site cookie, a shared lifetime of at most EDGE_MAX_AGE otherwise, `no-cache` for none.
 */
export function edgeCacheControl(value: string | null, siteCookie: boolean): string {
  if (!value?.trim()) return 'no-cache'
  const directives = value
    .split(',')
    .map(d => d.trim())
    .filter(Boolean)
  const nameOf = (d: string) => d.split('=')[0]?.trim().toLowerCase() ?? ''
  const secondsOf = (name: string) => {
    const found = directives.find(d => nameOf(d) === name)
    const n = found ? Number.parseInt(found.split('=')[1] ?? '', 10) : Number.NaN
    return Number.isNaN(n) ? undefined : n
  }
  if (directives.some(d => UNCACHEABLE.has(nameOf(d)))) return value
  if (siteCookie) {
    const kept = directives.filter(d => !['public', 's-maxage'].includes(nameOf(d)))
    return ['private', ...kept].join(', ')
  }
  const shared = Math.min(
    secondsOf('s-maxage') ?? secondsOf('max-age') ?? EDGE_MAX_AGE,
    EDGE_MAX_AGE
  )
  const kept = directives.filter(d => nameOf(d) !== 's-maxage')
  return [...kept, `s-maxage=${Math.max(0, shared)}`].join(', ')
}

/** `response` with its Cache-Control set to `value`, copied first when its headers are immutable. */
function withCacheControl(response: Response, value: string): Response {
  if (response.headers.get('cache-control') === value) return response
  try {
    response.headers.set('cache-control', value)
    return response
  } catch {
    const copy = new Response(response.body, response)
    copy.headers.set('cache-control', value)
    return copy
  }
}

/** Whether a request carries a site session or a site pass. */
function hasSiteCookie(request: Request): boolean {
  const header = request.headers.get('cookie')
  if (!header) return false
  return header.split(';').some(part => {
    const name = part.slice(0, part.indexOf('=')).trim()
    return name === SITE_COOKIE_NAME || name === SITE_PASS_COOKIE_NAME
  })
}

/** `fetch` behind Front Door's check, with the visitor's Host, and sites-host responses' caching
 * fitted to Front Door's cache. */
export function behindFrontDoor(
  fetch: (request: Request) => Promise<Response>,
  opts: FrontDoorOptions
): (request: Request) => Promise<Response> {
  const sitesSuffix = opts.sitesDomain ? `.${opts.sitesDomain.toLowerCase()}` : undefined
  return async request => {
    if (!verified(request, opts)) return forbidden()
    const visitor = visitorRequest(request)
    const response = await fetch(visitor)
    const host = new URL(visitor.url).hostname.toLowerCase()
    if (!sitesSuffix || !host.endsWith(sitesSuffix)) return response
    const value = edgeCacheControl(response.headers.get('cache-control'), hasSiteCookie(request))
    return withCacheControl(response, value)
  }
}
