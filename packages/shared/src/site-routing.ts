// The site routing decision: what the edge does with a request to a sites host. One function for
// every platform (Decision 3, "the edge only rewrites"): the CloudFront Function
// (edge/src/cloudfront.js, bundled with this file by edge/build.mjs) and the Cloudflare Worker
// (platforms/cloudflare/src/sites.ts) are thin shells that read the request, provide the lookups
// and turn the decision into their runtime's response.
//
//   `<name>.<sitesDomain>`, `s--<token>.<sitesDomain>` → route table `site:<name>` / `share:<token>`
//   → rewrite to `/sites/<id>/<v><path>`, or to MISSING_KEY (unknown host, archived site, dotfile);
//     NOT_FOUND_PAGE and REVIEW_SHELL pass through on any host
//   → or answer: 405 (not GET/HEAD), 302 to the app's sign-in (private site without a valid
//     `fling_site` cookie), 301 to add a trailing slash (extensionless path, not an SPA).
//
// SYNTAX. This file runs in the CloudFront Functions runtime (cloudfront-js-2.0: ES5.1 plus
// const/let, arrow functions, template literals, async/await on function declarations). So: no
// destructuring, spread, default parameters, for-of, optional chaining, `??`, classes or async
// arrow functions/expressions, and only built-ins that runtime has. `await` only as a statement
// or a declaration's whole initializer (`x = await f()`), never inside a call's arguments or another
// expression: the runtime rejects that ("await in arguments not supported"). edge/build.mjs
// refuses a bundle that needed any syntax lowered or nests an await, and edge's tests run the
// bundle in a harness.
//
// Contracts: route-keys.ts (keys), site-labels.ts (labels), site-cookie.ts (the cookie format).

import { MISSING_KEY, NOT_FOUND_PAGE, REVIEW_SHELL, shareKvsKey, siteKvsKey } from './route-keys.ts'
import { parseLabel } from './site-labels.ts'

/** A request to a sites host, as the shell read it. */
export interface SiteRequest {
  method: string
  /** the Host header as sent (port included), '' when missing */
  host: string
  /** the path as received, still percent-encoded */
  uri: string
  /** the query string to repeat in redirects: '' or `?a=1&b=` */
  query: string
  /** the `fling_site` cookie's value; null when there is no such cookie */
  cookie: string | null
}

/** What the decision needs from the platform. Lookups return promises (no async closures). */
export interface SiteRoutingContext {
  /** e.g. `https://fling.example.test` (no trailing slash) */
  appOrigin: string
  /** the scheme sites are served on, for the sign-in return URL */
  siteScheme: string
  nowSeconds: number
  /** the route table value at `key` (JSON), null when missing */
  getRoute(key: string): Promise<string | null>
  /** the key `fling_site` cookies are signed with; null when unknown */
  getCookieKey(): Promise<string | null>
  /** base64url HMAC-SHA256 of `data` under `key` */
  hmac(key: string, data: string): string
}

export interface SiteResponse {
  action: 'respond'
  status: number
  statusDescription: string
  headers: Record<string, string>
}

/** Serve this object key (`/sites/<id>/<v>/<path>`, MISSING_KEY, NOT_FOUND_PAGE or REVIEW_SHELL). */
export interface SiteRewrite {
  action: 'rewrite'
  uri: string
}

export type SiteDecision = SiteResponse | SiteRewrite

/** Route table value of a live site (KvsSiteValueSchema in kvs.ts). */
interface RouteValue {
  id?: string
  v?: string
  vis?: string
  spa?: boolean
}

// Any path segment starting with a dot (incl. `.`/`..` traversal and `.env`, `.git/…`,
// percent-encoded too): never served, even from versions flung before dotfiles were refused.
const DOT_SEGMENT_RE = /(^|\/)(\.|%2e)/i

/** The route table key for a sites host, or null when its first label is not a site's. */
export function routeKeyForHost(host: string): { key: string; share: boolean } | null {
  const label = host.toLowerCase().split(':')[0].split('.')[0]
  const parsed = parseLabel(label)
  if (!parsed) return null
  if (parsed.kind === 'site') return { key: siteKvsKey(parsed.name), share: false }
  return { key: shareKvsKey(parsed.token), share: true }
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** A valid, unexpired `fling_site` cookie (the format of site-cookie.ts). */
export function validSiteCookie(
  value: string,
  key: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): boolean {
  const parts = value.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  if (!safeEqual(hmac(key, parts[0]), parts[1])) return false
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    return typeof p.e === 'string' && typeof p.x === 'number' && p.x > nowSeconds
  } catch (_e) {
    return false
  }
}

function redirect(status: number, location: string, noStore: boolean): SiteResponse {
  const headers: Record<string, string> = { location: location }
  if (noStore) headers['cache-control'] = 'no-store'
  return {
    action: 'respond',
    status: status,
    statusDescription: status === 301 ? 'Moved Permanently' : 'Found',
    headers: headers,
  }
}

function parseRoute(raw: string | null): RouteValue | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (_e) {
    return null
  }
}

export async function routeSiteRequest(
  req: SiteRequest,
  ctx: SiteRoutingContext
): Promise<SiteDecision> {
  const uri = req.uri
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return {
      action: 'respond',
      status: 405,
      statusDescription: 'Method Not Allowed',
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
    }
  }
  // Static pages that hold no site data, on any host: the 404 page, and the review shell (the
  // site it frames is requested separately and goes through the checks below).
  if (uri === NOT_FOUND_PAGE || uri === REVIEW_SHELL) return { action: 'rewrite', uri: uri }

  const host = req.host.toLowerCase()
  const target = routeKeyForHost(host)
  let raw: string | null = null
  if (target) raw = await ctx.getRoute(target.key)
  const site = parseRoute(raw)
  if (!target || !site || !site.id || !site.v || DOT_SEGMENT_RE.test(uri)) {
    return { action: 'rewrite', uri: MISSING_KEY }
  }

  if (site.vis !== 'public' && !target.share) {
    const cookie = req.cookie
    let key: string | null = null
    if (cookie !== null) key = await ctx.getCookieKey()
    if (!key || !validSiteCookie(cookie || '', key, ctx.nowSeconds, ctx.hmac)) {
      const back = `${ctx.siteScheme}://${host}${uri}${req.query}`
      return redirect(302, `${ctx.appOrigin}/auth/login?return=${encodeURIComponent(back)}`, true)
    }
  }

  let path = uri
  if (path.endsWith('/')) {
    path += 'index.html'
  } else if (path.slice(path.lastIndexOf('/') + 1).indexOf('.') === -1) {
    if (!site.spa) return redirect(301, `${uri}/${req.query}`, false)
    path = '/index.html'
  }
  return { action: 'rewrite', uri: `/sites/${site.id}/${site.v}${path}` }
}

/**
 * A raw query string (`a=1&b`, no `?`) as the CloudFront Function repeats it: every key with an
 * `=`, so `?a=1&b=`. For shells that see the query unparsed (the Worker).
 */
export function normalizeQuery(raw: string): string {
  const out: string[] = []
  raw
    .replace(/^\?/, '')
    .split('&')
    .forEach(part => {
      if (!part) return
      out.push(part.indexOf('=') === -1 ? `${part}=` : part)
    })
  return out.length ? `?${out.join('&')}` : ''
}
