// Node-only. The signed tokens the edge checks, all under the site HMAC key and in one format
// (`<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, payloadPart))>`):
//
// - `fling_site` (payload { e: email, x: expiry, g?: 1 }): lets signed-in members view private
//   sites. `g: 1` marks a guest, to whom members-level sites answer as missing ones. Minted by the
//   API at login, verified at the edge by siteCookieOf in site-routing.ts.
// - the pass handoff (payload { k: 'handoff', s: siteId, e, x }): the API's word, valid for
//   60 seconds, that `e` may view the restricted site `s`; it travels in the URL of
//   `/_fling-pass` on the site's host.
// - `fling_pass` (payload { k: 'pass', s, e, x }): the site pass the edge mints from a handoff,
//   a host-only cookie that opens that one restricted site for 5 minutes.
// - the deny handoff (payload { k: 'deny', s, x }): the API's word, valid for 60 seconds, that the
//   browser's user may not view `s`; it travels in the same `/_fling-pass` URL.
// - a refused `fling_pass` (payload { k: 'denied', s, x }): what the edge mints from a deny
//   handoff, in the same cookie. For SITE_DENIED_TTL_SECONDS the site answers its 404 page rather
//   than sending the browser to sign in again; a later pass simply replaces it.
//
// `k` keeps them apart, strictly: each verifier takes exactly one kind, so a handoff is never a
// pass, a refusal is never a pass or a handoff, and none of them is a `fling_site` cookie. The edge
// verifies with the HMAC passed in as a function (for the CloudFront runtime's `crypto` module):
// keep the two in step; edge tests check them against each other.

import { createHmac, timingSafeEqual } from 'node:crypto'

export {
  SITE_DENIED_TTL_SECONDS,
  SITE_PASS_COOKIE_NAME,
  SITE_PASS_TTL_SECONDS,
} from './route-keys.ts'

export const SITE_COOKIE_NAME = 'fling_site'
export const SITE_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60

/** `g: 1`: a guest (auth/standing.ts), who sees only the restricted sites that name them. */
export type SiteCookiePayload = { e: string; x: number; g?: 1 }

/** How long a pass handoff (the URL the API sends the browser to) is good for. */
export const PASS_HANDOFF_TTL_SECONDS = 60

export type SitePassPayload = { s: string; e: string; x: number }

/** A refusal names only the site: no one's email travels in it. */
export type SiteDenialPayload = { s: string; x: number }

function sign(payload: object, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${mac}`
}

/** The payload of a well-signed token, whatever its kind or expiry; null otherwise. */
function verify(value: string, key: string): Record<string, unknown> | null {
  const [body, mac, extra] = value.split('.')
  if (!body || !mac || extra !== undefined) return null
  const expected = createHmac('sha256', key).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

export function signSiteCookie(payload: SiteCookiePayload, key: string): string {
  return sign(payload, key)
}

export function verifySiteCookie(
  value: string,
  key: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): SiteCookiePayload | null {
  const p = verify(value, key)
  if (!p || p.k !== undefined || typeof p.e !== 'string' || typeof p.x !== 'number') return null
  if (p.x <= nowSeconds) return null
  return p.g === 1 ? { e: p.e, x: p.x, g: 1 } : { e: p.e, x: p.x }
}

/** A pass handoff: the API lets `e` view restricted site `s` (the edge turns it into a pass). */
export function signPassHandoff(payload: SitePassPayload, key: string): string {
  return sign({ k: 'handoff', ...payload }, key)
}

/** A site pass, as the edge mints it (tests, and checks against the edge). */
export function signSitePass(payload: SitePassPayload, key: string): string {
  return sign({ k: 'pass', ...payload }, key)
}

/** A valid, unexpired token of `kind` ('pass' or 'handoff'); null otherwise. */
export function verifySitePass(
  value: string,
  key: string,
  kind: 'pass' | 'handoff',
  nowSeconds = Math.floor(Date.now() / 1000)
): SitePassPayload | null {
  const p = verify(value, key)
  if (!p || p.k !== kind) return null
  if (typeof p.s !== 'string' || typeof p.e !== 'string' || typeof p.x !== 'number') return null
  return p.x > nowSeconds ? { s: p.s, e: p.e, x: p.x } : null
}

/** A deny handoff: the API refuses this browser restricted site `s` (the edge remembers it). */
export function signDenyHandoff(payload: SiteDenialPayload, key: string): string {
  return sign({ k: 'deny', ...payload }, key)
}

/** A refused `fling_pass`, as the edge mints it (tests, and checks against the edge). */
export function signSiteDenied(payload: SiteDenialPayload, key: string): string {
  return sign({ k: 'denied', ...payload }, key)
}

/** A valid, unexpired refusal of `kind` ('deny' or 'denied'); null otherwise. */
export function verifySiteDenial(
  value: string,
  key: string,
  kind: 'deny' | 'denied',
  nowSeconds = Math.floor(Date.now() / 1000)
): SiteDenialPayload | null {
  const p = verify(value, key)
  if (!p || p.k !== kind || typeof p.s !== 'string' || typeof p.x !== 'number') return null
  return p.x > nowSeconds ? { s: p.s, x: p.x } : null
}
