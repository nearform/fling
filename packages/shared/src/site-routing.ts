// The site routing decision: what the edge does with a request to a sites host. One function for
// every platform (Decision 3, "the edge only rewrites"): the CloudFront Function
// (edge/src/cloudfront.js, bundled with this file by edge/build.mjs) and the Cloudflare Worker
// (platforms/cloudflare/src/sites.ts) are thin shells that read the request, provide the lookups
// and turn the decision into their runtime's response.
//
//   `<name>.<sitesDomain>`, `s--<token>.<sitesDomain>` → route table `site:<name>` / `share:<token>`
//   → rewrite to `/sites/<id>/<v><path>` (saying `x-fling-version: <v>`), or to MISSING_KEY
//     (unknown host, archived site, dotfile, site whose `fling_pass` says it was refused); NOT_FOUND_PAGE and REVIEW_SHELL pass through on any host,
//     and `/robots.txt` on any host is ROBOTS_TXT
//   → or invoke the site's server (route value `f`): a request under SERVER_PREFIX (`/api/`), any
//     method, after every access check below, naming the viewer they found (see SiteInvoke)
//   → or answer: 405 (not GET/HEAD, outside a server's `/api/`), 403 `cross_origin` (a write to a
//     server's `/api/` from another origin), 503 (a server an admin stopped, `x`), 302 to the app's sign-in (private site without a valid
//     `fling_site` cookie, or a member's the revocation list stops; restricted site, or members-level site to a guest's `fling_site`,
//     without a valid `fling_pass` naming it), 301 to add a trailing slash (extensionless path,
//     not an SPA), 204 to SITE_VERSION_PATH (`/_fling-version`) with `x-fling-version: <v>`.
//   → either way, with the headers every response on that host carries (siteResponseHeaders).
//
// The version a host serves comes from the route table, which reaches the edge eventually (KV on
// Cloudflare, the KeyValueStore on AWS): for a while after a publish a host can serve the previous
// version while the API reports the new one. Whoever needs to know which version a page is of
// (the preview shell, before it draws a Thumbnail) asks `/_fling-version`, which passes the same
// access checks as the site's pages and answers with the version they get. It is an answer rather
// than a header on the pages because only the Worker adds a rewrite's headers to what it serves:
// on AWS (and the local dev server, which runs the CloudFront Function) a page carries none of
// them. A rewrite still says `x-fling-version` (a page, or the 404 page for a file the version
// lacks), for the runtimes that pass it on.
//
// Sites are not indexed: every sites host answers `/robots.txt` with Fling's own `Disallow: /`
// (ROBOTS_TXT, so a site's own robots.txt is never served), and responses say `X-Robots-Tag:
// noindex`. A share host's origin is its secret, so its responses also say `Referrer-Policy:
// no-referrer`: otherwise every cross-origin request its pages make (images, fonts, analytics,
// links) would send `Referer: https://s--<token>.<sitesDomain>/` to a third party. Site-name hosts
// keep the browser's default, because authors may rely on Referer (referrer-restricted API keys,
// analytics). Known limits: a page can still set its own `<meta name="referrer">`, which the
// browser obeys over the header; and on AWS only the responses decided here carry the headers
// (see siteResponseHeaders), so a share host's files keep the default policy and a site's files
// rely on robots.txt alone. Fling's own pages on sites hosts (the 404 page, the review shell) say
// `noindex` and `no-referrer` in meta tags on every host.
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
// Members-level sites (private, no audience) open with any valid `fling_site` that isn't a guest's
// (`g: 1`) and was issued after any revocation of its email on the revocation list
// (`revoked:<mac>`, route-keys.ts); an older one goes to sign in like no cookie, where the app
// refuses someone who has lost their standing and gives anyone else a fresh cookie. The list is
// how revoking an invitation reaches the edge before the cookie expires. A guest's goes through the site pass like a restricted site: the app's `/auth/login`
// refreshes `fling_site` and asks policy, so a real guest gets a deny handoff (the site answers
// as a missing one) and someone who has become a member since their cookie was set goes straight
// back with a member's cookie.
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
// Site servers. A version with a server (SERVER_BUNDLE) has its route value say `f: 1`, and `t`
// the host its runtime is reached at when the platform needs one (AWS: the Web Function's
// endpoint). Requests under SERVER_PREFIX then go to it, any method; every other path keeps the
// GET/HEAD rule, refused before any lookup. A write (any method but GET, HEAD and OPTIONS) needs
// `Sec-Fetch-Site: same-origin` or the site's own `Origin`, or neither header (curl, another
// server: no browser cookies), else 403 `cross_origin`: every site shares the sites domain, and
// `fling_site` is set on it, so to a browser all sites are one site and SameSite does not stop
// another site's page posting as the visitor. The server learns who is calling from the decision's
// `viewer` (null on a public site or a share host), never from a credential: the shell drops the
// browser's cookies and any VIEWER_HEADER it sent. Nothing under FLING_DIR is a site's file.
//
// Contracts: route-keys.ts (keys), site-labels.ts (labels), site-cookie.ts (the cookie format).

import {
  FLING_DIR,
  MISSING_KEY,
  NOT_FOUND_PAGE,
  PATHS_JSON_PATH,
  pathKvsKey,
  REVIEW_SHELL,
  ROBOTS_TXT,
  revokedKvsKey,
  SERVER_PREFIX,
  SITE_DENIED_TTL_SECONDS,
  SITE_PASS_COOKIE_NAME,
  SITE_PASS_PATH,
  SITE_PASS_TTL_SECONDS,
  SITE_VERSION_HEADER,
  SITE_VERSION_PATH,
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
  /** the `Sec-Fetch-Site` header; absent or null when not sent */
  fetchSite?: string | null
  /** the `Origin` header; absent or null when not sent */
  origin?: string | null
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
  /**
   * the revocation list's value at `key` (`revoked:<mac>`: an expiry), null when missing. May
   * trail a revocation by the platform's propagation, never by more.
   */
  getRevocation(key: string): Promise<string | null>
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
  /** the body to send (JSON: `{"error":{"code","message"}}`); absent: none */
  body?: string
  /** it answers for a site that isn't public, or on a share host (see SiteRewrite.private) */
  private?: boolean
}

/** Serve this object key (`/sites/<id>/<v>/<path>`, MISSING_KEY, NOT_FOUND_PAGE or REVIEW_SHELL). */
export interface SiteRewrite {
  action: 'rewrite'
  uri: string
  /** to add to the response served for it (siteResponseHeaders) */
  headers: Record<string, string>
  /**
   * The file is of a site that isn't public, or served on a share host. CloudFront caches by the
   * rewritten key, behind the checks, so it needs nothing; a host that may sit behind a cache
   * keyed by the viewer's URL (the Node host behind Cloud CDN) makes its Cache-Control `private`
   * (serverCacheControl), so no shared cache keeps what only the checks may hand out.
   */
  private?: boolean
}

/** Who the access checks found calling a site's server: what VIEWER_HEADER carries. */
export interface SiteViewer {
  /** the viewer id (viewerIdOf): the same for one person on one site, different on every other */
  id: string
  email: string
  /** their `fling_site` says they are a guest */
  guest: boolean
}

/**
 * Run the site's server, version `v`, for this request. The shell drops the browser's cookies and
 * any VIEWER_HEADER, sets VIEWER_HEADER to `viewer` (JSON) when there is one and SERVER_SITE_HEADER
 * to `<siteId>/<v>`, and sends the request on unchanged otherwise: to `target` when there is one,
 * else to the platform's own runtime. What the server answers goes back with its Cache-Control
 * made safe (serverCacheControl, site-server.ts), as `private` says.
 */
export interface SiteInvoke {
  action: 'invoke'
  siteId: string
  v: string
  /** where the server is reached (route value `t`), when the platform needs one; else null */
  target: string | null
  /** the site is not public: a `public` Cache-Control becomes `private` */
  private: boolean
  /** who the checks found signed in; null on a public site or a share host */
  viewer: SiteViewer | null
  headers: Record<string, string>
}

export type SiteDecision = SiteResponse | SiteRewrite | SiteInvoke

/** Route table value of a live site (KvsSiteValueSchema in kvs.ts). */
interface RouteValue {
  id?: string
  v?: string
  vis?: string
  spa?: boolean
  /** 1: restricted, the site wants a site pass */
  r?: number
  /** 1: the site has live Paths (`path:<id>/<folder>`) */
  p?: number
  /** the rendered home page and Paths listing (`sites/<id>/_rendered/<i>.html|json`) */
  i?: string
  /** 1: the version's Markdown files have rendered pages (`.rendered/<path>.html`) */
  m?: number
  /** 1: the version has a server (SERVER_BUNDLE), run for SERVER_PREFIX */
  f?: number
  /** where the server is reached, when the platform needs it (the decision's `target`) */
  t?: string
  /** 1: an admin stopped the server: SERVER_PREFIX answers 503 */
  x?: number
}

// Any path segment starting with a dot (incl. `.`/`..` traversal and `.env`, `.git/…`,
// percent-encoded too): never served, even from versions flung before dotfiles were refused.
const DOT_SEGMENT_RE = /(^|\/)(\.|%2e)/i
// Percent-encoded `/`, `\` and NUL: refused outside SERVER_PREFIX, so the decoded path the store
// reads has the segments the checks saw.
const ENCODED_SEPARATOR_RE = /%(2f|5c|00)/i

/** The route table key for a sites host, or null when its first label is not a site's. */
export function routeKeyForHost(host: string): { key: string; share: boolean } | null {
  const label = host.toLowerCase().split(':')[0].split('.')[0]
  const parsed = parseLabel(label)
  if (!parsed) return null
  if (parsed.kind === 'site') return { key: siteKvsKey(parsed.name), share: false }
  return { key: shareKvsKey(parsed.token), share: true }
}

/**
 * The headers every response on `host` carries, whatever is served: `X-Robots-Tag: noindex`, and
 * `Referrer-Policy: no-referrer` on a share host. Every decision carries them: a response has them
 * already, a rewrite's are for the shell to add to what it serves. The Worker does; the CloudFront
 * Function runs at viewer-request only and never sees what S3 serves, so on AWS a share host's
 * files keep the browser's default (see edge/src/cloudfront.js).
 */
export function siteResponseHeaders(host: string): Record<string, string> {
  const target = routeKeyForHost(host)
  const headers: Record<string, string> = { 'x-robots-tag': 'noindex' }
  if (target && target.share) headers['referrer-policy'] = 'no-referrer'
  return headers
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

/** The payload of a valid, unexpired `fling_site` cookie (`e`, `x`, `g`); null when it isn't one. */
function siteCookieClaims(
  value: string,
  key: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
  // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON payload, checked field by field
): any {
  const p = signedPayload(value, key, hmac)
  if (
    !p ||
    p.k !== undefined ||
    typeof p.e !== 'string' ||
    typeof p.x !== 'number' ||
    p.x <= nowSeconds
  ) {
    return null
  }
  return p
}

/**
 * Who a valid, unexpired `fling_site` cookie (not a site pass or handoff, which carry a kind `k`)
 * says is signed in: 'guest' when it carries `g: 1`, else 'member'; null when it isn't one.
 */
export function siteCookieOf(
  value: string,
  key: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): 'member' | 'guest' | null {
  const p = siteCookieClaims(value, key, nowSeconds, hmac)
  if (!p) return null
  return p.g === 1 ? 'guest' : 'member'
}

/** A valid, unexpired `fling_site` cookie, a guest's or a member's. */
export function validSiteCookie(
  value: string,
  key: string,
  nowSeconds: number,
  hmac: (key: string, data: string) => string
): boolean {
  return siteCookieOf(value, key, nowSeconds, hmac) !== null
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

/**
 * A site that wants a site pass: `/_fling-pass` takes a handoff; a refusal still running answers
 * as a missing site; without a valid pass, off to sign in. null: the pass is good, serve the site.
 */
async function bySitePass(
  req: SiteRequest,
  ctx: SiteRoutingContext,
  host: string,
  siteId: string
): Promise<SiteDecision | null> {
  if (req.uri === SITE_PASS_PATH) return await passFromHandoff(req, ctx, siteId)
  const pass = req.pass
  let key: string | null = null
  if (pass) key = await ctx.getCookieKey()
  // Refused a moment ago: answer as a missing site, until the refusal runs out.
  if (key && pass && validSiteDenial(pass, key, 'denied', siteId, ctx.nowSeconds, ctx.hmac)) {
    return rewrite(MISSING_KEY)
  }
  if (!key || !pass || !validSitePass(pass, key, 'pass', siteId, ctx.nowSeconds, ctx.hmac)) {
    return toSignIn(req, ctx, host)
  }
  return null
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * SERVER_SITE_HEADER's value for an invoke: `<siteId>/<v>`, then `/private` on a site that isn't
 * public, so the shell running the server knows the version and the caching rule
 * (site-server.ts serverCacheControl).
 */
export function serverSiteHeader(decision: Pick<SiteInvoke, 'siteId' | 'v' | 'private'>): string {
  return decision.siteId + '/' + decision.v + (decision.private ? '/private' : '')
}

/**
 * The viewer id of `email` on site `siteId`: `v_` and the first 8 bytes of
 * HMAC(key, `viewer:<siteId>:<email>`) in base32 (lowercase, unpadded: 13 characters), under the
 * site cookie key. One person has one id per site and a different one on every other site, so a
 * site's logs can follow a user without two sites' logs being joined, and no log names an address.
 */
export function viewerIdOf(
  key: string,
  siteId: string,
  email: string,
  hmac: (key: string, data: string) => string
): string {
  const mac = Buffer.from(hmac(key, `viewer:${siteId}:${email}`), 'base64url')
  let out = 'v_'
  let bits = 0
  let value = 0
  for (let i = 0; i < 8; i++) {
    value = ((value << 8) | mac[i]) & 0xfff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32.charAt((value >> bits) & 31)
    }
  }
  return out + BASE32.charAt((value << (5 - bits)) & 31)
}

/** An answer with a JSON error body: `{"error":{"code","message"}}`. */
function refuse(status: number, description: string, code: string, message: string): SiteResponse {
  return {
    action: 'respond',
    status: status,
    statusDescription: description,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ error: { code: code, message: message } }),
  }
}

/**
 * A write from another origin: a browser said where it came from (Sec-Fetch-Site or Origin), and
 * it is not this site's host.
 */
function crossOrigin(req: SiteRequest, ctx: SiteRoutingContext, host: string): boolean {
  const site = req.fetchSite || ''
  const origin = req.origin || ''
  if (!site && !origin) return false
  return site !== 'same-origin' && origin !== `${ctx.siteScheme}://${host}`
}

function notAllowed(): SiteResponse {
  return {
    action: 'respond',
    status: 405,
    statusDescription: 'Method Not Allowed',
    headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
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

function rewrite(uri: string): SiteRewrite {
  return { action: 'rewrite', uri: uri, headers: {} }
}

export async function routeSiteRequest(
  req: SiteRequest,
  ctx: SiteRoutingContext
): Promise<SiteDecision> {
  const decision = await decide(req, ctx)
  const extra = siteResponseHeaders(req.host)
  Object.keys(extra).forEach(name => {
    decision.headers[name] = extra[name]
  })
  return decision
}

async function decide(req: SiteRequest, ctx: SiteRoutingContext): Promise<SiteDecision> {
  const uri = req.uri
  const readOnly = req.method === 'GET' || req.method === 'HEAD'
  const api = uri.indexOf(SERVER_PREFIX) === 0
  // Only a site's server takes other methods: a path it can't own is refused before any lookup.
  if (!readOnly && !api) return notAllowed()
  // Static pages that hold no site data, on any host: the 404 page, the review shell (the site it
  // frames is requested separately and goes through the checks below), and Fling's robots.txt in
  // place of any the site has.
  if (uri === NOT_FOUND_PAGE || uri === REVIEW_SHELL) return rewrite(uri)
  if (uri === '/robots.txt') return rewrite(ROBOTS_TXT)
  // The checks below run on the path the store reads, which it decodes once. An encoded `/`, `\`
  // or NUL never names a site's file, so only a site's server (which owns its own paths) gets one.
  if (!api && ENCODED_SEPARATOR_RE.test(uri)) return rewrite(MISSING_KEY)
  let decoded = uri
  try {
    decoded = decodeURIComponent(uri)
  } catch (_e) {
    // A malformed escape names no file; a server is given its paths as they came.
    if (!api) return rewrite(MISSING_KEY)
  }
  // Fling's own paths: a site's files there (its server's bundle among them) are never served.
  if (decoded.indexOf(FLING_DIR) === 0) return rewrite(MISSING_KEY)

  const host = req.host.toLowerCase()
  const target = routeKeyForHost(host)
  let raw: string | null = null
  if (target) raw = await ctx.getRoute(target.key)
  const site = parseRoute(raw)
  if (!target || !site || !site.id || !site.v || DOT_SEGMENT_RE.test(decoded)) {
    return rewrite(MISSING_KEY)
  }

  const invoke = site.f === 1 && api
  if (!readOnly && !invoke) return notAllowed()
  if (invoke && !readOnly && req.method !== 'OPTIONS' && crossOrigin(req, ctx, host)) {
    return refuse(403, 'Forbidden', 'cross_origin', 'Not from this site')
  }

  const checked = site.vis !== 'public' && !target.share
  if (checked && site.r) {
    const held = await bySitePass(req, ctx, host, site.id)
    if (held) return held
  } else if (checked) {
    const cookie = req.cookie
    let key: string | null = null
    if (cookie !== null) key = await ctx.getCookieKey()
    // biome-ignore lint/suspicious/noExplicitAny: the claims siteCookieClaims checked
    let claims: any = null
    if (key) claims = siteCookieClaims(cookie || '', key, ctx.nowSeconds, ctx.hmac)
    if (!claims) return toSignIn(req, ctx, host)
    if (claims.g === 1) {
      // A guest's cookie may be stale (they have since become a member): the app decides, through
      // the same sign-in hop as a restricted site, which refreshes the cookie on the way.
      const held = await bySitePass(req, ctx, host, site.id)
      if (held) return held
    } else {
      // A member's that expires no later than its email's revocation-list value was issued no
      // later than the second of the revocation. Someone who keeps their standing gets a newer one
      // at sign-in, so at worst they pass through it again within that second.
      const until = await ctx.getRevocation(revokedKvsKey(ctx.hmac(key as string, claims.e)))
      if (until !== null && claims.x <= Number(until)) return toSignIn(req, ctx, host)
    }
  }

  // What follows serves the site to someone the checks let in. On a site that isn't public, or a
  // share host, nothing it answers may be kept by a cache keyed by the viewer's URL.
  const known = site as RouteValue & { id: string; v: string }
  const decision = await serveSite(req, ctx, known, uri, invoke, checked)
  if (decision.action !== 'invoke' && (site.vis !== 'public' || target.share)) {
    decision.private = true
  }
  return decision
}

/** The decision for a request the access checks let through. */
async function serveSite(
  req: SiteRequest,
  ctx: SiteRoutingContext,
  site: RouteValue & { id: string; v: string },
  uri: string,
  invoke: boolean,
  checked: boolean
): Promise<SiteDecision> {
  if (invoke) {
    if (site.x) {
      return refuse(503, 'Service Unavailable', 'server_stopped', 'Server stopped')
    }
    // Who the checks above let in: a restricted site's pass names them, else their `fling_site`
    // (whose `g` says whether they are a guest; a pass says nothing of standing).
    let viewer: SiteViewer | null = null
    if (checked) {
      let key = await ctx.getCookieKey()
      key = key || ''
      const claims = siteCookieClaims(req.cookie || '', key, ctx.nowSeconds, ctx.hmac)
      const email = site.r
        ? validSitePass(req.pass || '', key, 'pass', site.id, ctx.nowSeconds, ctx.hmac)
        : claims.e
      const guest = !!claims && claims.g === 1
      viewer = { id: viewerIdOf(key, site.id, email, ctx.hmac), email: email, guest: guest }
    }
    return {
      action: 'invoke',
      siteId: site.id,
      v: site.v,
      target: site.t || null,
      private: site.vis !== 'public',
      viewer: viewer,
      headers: {},
    }
  }

  if (uri === SITE_VERSION_PATH) {
    const headers: Record<string, string> = { 'cache-control': 'no-store' }
    headers[SITE_VERSION_HEADER] = site.v
    return { action: 'respond', status: 204, statusDescription: 'No Content', headers: headers }
  }

  // A rendered home page (the site's index.html with its Paths block filled in, or the default
  // one listing the Paths) stands in for the version's own, and the listing's data beside it.
  if (site.i && (uri === '/' || uri === '/index.html')) {
    return served(`/sites/${site.id}/_rendered/${site.i}.html`, site.v)
  }
  if (site.i && uri === PATHS_JSON_PATH)
    return served(`/sites/${site.id}/_rendered/${site.i}.json`, site.v)

  // A Path: the first folder of the request, when the site has one by that name, is served from
  // the Path's own current version. It is matched decoded, so no spelling of the folder reaches
  // the site's own copy of it.
  if (site.p) {
    const slash = uri.indexOf('/', 1)
    const raw = slash === -1 ? uri.slice(1) : uri.slice(1, slash)
    if (raw && (slash !== -1 || raw.indexOf('.') === -1)) {
      let folder = ''
      try {
        folder = decodeURIComponent(raw)
      } catch (_e) {
        return rewrite(MISSING_KEY)
      }
      const found = await ctx.getRoute(pathKvsKey(site.id, folder))
      const mounted = parseRoute(found)
      if (mounted && mounted.id && mounted.v) {
        if (slash === -1) return redirect(301, `${uri}/${req.query}`, false)
        const rest = uri.slice(slash)
        let inner = rest
        if (inner.endsWith('/')) {
          inner += 'index.html'
        } else if (inner.slice(inner.lastIndexOf('/') + 1).indexOf('.') === -1) {
          return redirect(301, `${uri}/${req.query}`, false)
        }
        return served(
          `/sites/${mounted.id}/${mounted.v}${markdown(inner, mounted, req)}`,
          mounted.v
        )
      }
    }
  }

  let path = uri
  if (path.endsWith('/')) {
    path += 'index.html'
  } else if (path.slice(path.lastIndexOf('/') + 1).indexOf('.') === -1) {
    if (!site.spa) return redirect(301, `${uri}/${req.query}`, false)
    path = '/index.html'
    if (site.i) return served(`/sites/${site.id}/_rendered/${site.i}.html`, site.v)
  }
  return served(`/sites/${site.id}/${site.v}${markdown(path, site, req)}`, site.v)
}

/**
 * A Markdown file of a version whose Markdown was rendered: its rendered page, unless the request
 * asks for the source (`?raw=1`).
 */
function markdown(path: string, route: RouteValue, req: SiteRequest): string {
  if (!route.m || !/\.(md|markdown)$/i.test(path) || queryParam(req.query, 'raw') !== null)
    return path
  return `/.rendered${path}.html`
}

/** Serve an object of version `v` (`x-fling-version` says which). */
function served(uri: string, v: string): SiteRewrite {
  const decision = rewrite(uri)
  decision.headers[SITE_VERSION_HEADER] = v
  return decision
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
