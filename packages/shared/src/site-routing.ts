// The site routing decision: what the edge does with a request to a sites host. One function for
// every platform (Decision 3, "the edge only rewrites"): the CloudFront Function
// (edge/src/cloudfront.js, bundled with this file by edge/build.mjs) and the Cloudflare Worker
// (platforms/cloudflare/src/sites.ts) are thin shells that read the request, provide the lookups
// and turn the decision into their runtime's response.
//
//   `<name>.<sitesDomain>`, `s--<token>.<sitesDomain>` → route table `site:<name>` / `share:<token>`
//   → rewrite to `/sites/<id>/<v><path>`, or to MISSING_KEY (unknown host, archived site, dotfile,
//     restricted site whose `fling_pass` says it was refused); NOT_FOUND_PAGE and REVIEW_SHELL pass through on any host
//   → or answer: 405 (not GET/HEAD), 302 to the app's sign-in (private site without a valid
//     `fling_site` cookie; restricted site without a valid `fling_pass` naming it), 301 to add a
//     trailing slash (extensionless path, not an SPA).
//
// Restricted sites (private with an audience; route value `r: 1`) need a site pass, not just
// `fling_site`, because the edge holds no access lists. The app's `/auth/login` asks policy and,
// for a viewer, sends the browser to `/_fling-pass?t=<handoff>&r=<path>` on the site's host. Here
// the handoff (60 s, naming this site's id) becomes a host-only `fling_pass` cookie, signed with
// the same key for 5 minutes, and the browser goes on to `r`. An expired pass renews through
// the same redirects, so removing someone from the audience takes effect within that window.
// Anyone else gets a deny handoff on the same path, and their `fling_pass` instead says this site
// refused them, for SITE_DENIED_TTL_SECONDS: while it lasts the site answers as a missing one (the
// 404 page at the URL asked for), and afterwards the next visit asks the app again, so someone
// added to the audience gets in within seconds and nobody loops between the two hosts.
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

import {
  MISSING_KEY,
  NOT_FOUND_PAGE,
  REVIEW_SHELL,
  SITE_DENIED_TTL_SECONDS,
  SITE_PASS_COOKIE_NAME,
  SITE_PASS_PATH,
  SITE_PASS_TTL_SECONDS,
  shareKvsKey,
  siteKvsKey,
} from './route-keys.ts'
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
  /** the `fling_pass` cookie's value (a restricted site's pass); null when there is none */
  pass: string | null
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
  /** how long a site pass minted here lasts, in seconds; default SITE_PASS_TTL_SECONDS */
  passTtlSeconds?: number
}

/** A cookie to set with a response: `<name>=<value>; <attributes>`. */
export interface SiteCookie {
  value: string
  attributes: string
}

export interface SiteResponse {
  action: 'respond'
  status: number
  statusDescription: string
  headers: Record<string, string>
  /** by name; only `/_fling-pass` sets one (`fling_pass`) */
  cookies?: Record<string, SiteCookie>
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
  /** 1: restricted, the site wants a site pass */
  r?: number
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

/** The payload of a well-signed token (the format of site-cookie.ts), whatever it says; else null. */
function signedPayload(
  value: string,
  key: string,
  hmac: (key: string, data: string) => string
  // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON payload, checked field by field
): any {
  const parts = value.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  if (!safeEqual(hmac(key, parts[0]), parts[1])) return null
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch (_e) {
    return null
  }
}

/** A valid, unexpired `fling_site` cookie (not a site pass or handoff, which carry a kind `k`). */
export function validSiteCookie(
  value: string,
  key: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): boolean {
  const p = signedPayload(value, key, hmac)
  return (
    !!p &&
    p.k === undefined &&
    typeof p.e === 'string' &&
    typeof p.x === 'number' &&
    p.x > nowSeconds
  )
}

/**
 * A valid, unexpired token of exactly `kind` naming site `siteId` (site-cookie.ts): a site pass or
 * pass handoff (`pass`, `handoff`; for one email `e`), or a refusal (`denied`, `deny`; no email).
 * Its payload, else null.
 */
function siteToken(
  value: string,
  key: string,
  kind: string,
  siteId: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
  // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON payload, checked field by field
): any {
  const p = signedPayload(value, key, hmac)
  if (!p || p.k !== kind || p.s !== siteId || typeof p.x !== 'number' || p.x <= nowSeconds) {
    return null
  }
  return p
}

/**
 * A valid, unexpired site pass or pass handoff (`kind`) naming site `siteId`: who it is for (its
 * email), else null.
 */
export function validSitePass(
  value: string,
  key: string,
  kind: 'pass' | 'handoff',
  siteId: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): string | null {
  const p = siteToken(value, key, kind, siteId, nowSeconds, hmac)
  return p && typeof p.e === 'string' ? p.e : null
}

/** A valid, unexpired refusal (`kind`: the API's `deny` handoff or the edge's `denied` cookie). */
export function validSiteDenial(
  value: string,
  key: string,
  kind: 'deny' | 'denied',
  siteId: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): boolean {
  return !!siteToken(value, key, kind, siteId, nowSeconds, hmac)
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

/** The app's sign-in, coming back to this URL afterwards. */
function toSignIn(req: SiteRequest, ctx: SiteRoutingContext, host: string): SiteResponse {
  const back = `${ctx.siteScheme}://${host}${req.uri}${req.query}`
  return redirect(302, `${ctx.appOrigin}/auth/login?return=${encodeURIComponent(back)}`, true)
}

/** `name`'s value in a query string (`?a=1&b=`), still percent-encoded; null when absent. */
function queryParam(query: string, name: string): string | null {
  const parts = query.replace(/^\?/, '').split('&')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf(`${name}=`) === 0) return parts[i].slice(name.length + 1)
  }
  return null
}

/** A pass handoff's `r`: a path on this host (one leading `/`, no control characters), else `/`. */
function sameHostPath(raw: string | null): string {
  let path = '/'
  try {
    path = decodeURIComponent(raw || '/')
  } catch (_e) {
    return '/'
  }
  if (path.charAt(0) !== '/' || path.charAt(1) === '/' || path.indexOf('\\') !== -1) return '/'
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) < 32) return '/'
  return path
}

/**
 * `/_fling-pass?t=<handoff>&r=<path>`: on to `r`, with a `fling_pass` for this site when the
 * handoff is valid: a site pass from a pass handoff, a `denied` token from a deny handoff. Without
 * one, `r` sends the browser to sign in again for a fresh handoff.
 */
async function passFromHandoff(
  req: SiteRequest,
  ctx: SiteRoutingContext,
  siteId: string
): Promise<SiteResponse> {
  const res = redirect(302, sameHostPath(queryParam(req.query, 'r')), true)
  const key = await ctx.getCookieKey()
  const handoff = queryParam(req.query, 't')
  if (!key || !handoff) return res
  const now = ctx.nowSeconds
  const email = validSitePass(handoff, key, 'handoff', siteId, now, ctx.hmac)
  let ttl = ctx.passTtlSeconds || SITE_PASS_TTL_SECONDS
  // biome-ignore lint/suspicious/noExplicitAny: the token's payload, by kind (site-cookie.ts)
  let payload: any = { k: 'pass', s: siteId, e: email, x: now + ttl }
  if (email === null) {
    if (!validSiteDenial(handoff, key, 'deny', siteId, now, ctx.hmac)) return res
    ttl = SITE_DENIED_TTL_SECONDS
    payload = { k: 'denied', s: siteId, x: now + ttl }
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const secure = ctx.siteScheme === 'https' ? 'Secure; ' : ''
  res.cookies = {}
  res.cookies[SITE_PASS_COOKIE_NAME] = {
    value: `${body}.${ctx.hmac(key, body)}`,
    attributes: `${secure}HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}`,
  }
  return res
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

  if (site.vis !== 'public' && !target.share && site.r) {
    if (uri === SITE_PASS_PATH) return await passFromHandoff(req, ctx, site.id)
    const pass = req.pass
    let key: string | null = null
    if (pass) key = await ctx.getCookieKey()
    // Refused a moment ago: answer as a missing site, until the refusal runs out.
    if (key && pass && validSiteDenial(pass, key, 'denied', site.id, ctx.nowSeconds, ctx.hmac)) {
      return { action: 'rewrite', uri: MISSING_KEY }
    }
    if (!key || !pass || !validSitePass(pass, key, 'pass', site.id, ctx.nowSeconds, ctx.hmac)) {
      return toSignIn(req, ctx, host)
    }
  } else if (site.vis !== 'public' && !target.share) {
    const cookie = req.cookie
    let key: string | null = null
    if (cookie !== null) key = await ctx.getCookieKey()
    if (!key || !validSiteCookie(cookie || '', key, ctx.nowSeconds, ctx.hmac)) {
      return toSignIn(req, ctx, host)
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
