// Node-only. The `fling_site` cookie that lets signed-in members view private
// sites. Minted by the API at login, verified at the edge by
// validSiteCookie in site-routing.ts (which takes the HMAC as a function, for the CloudFront
// runtime's `crypto` module — keep the two in step; edge tests check them against each other).
//
// Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, payloadPart))>`
// Payload: { e: email, x: expiry (unix seconds) }

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SITE_COOKIE_NAME = 'fling_site'
export const SITE_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60

export type SiteCookiePayload = { e: string; x: number }

export function signSiteCookie(payload: SiteCookiePayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifySiteCookie(
  value: string,
  key: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): SiteCookiePayload | null {
  const [body, mac, extra] = value.split('.')
  if (!body || !mac || extra !== undefined) return null
  const expected = createHmac('sha256', key).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SiteCookiePayload
    if (typeof payload.e !== 'string' || typeof payload.x !== 'number') return null
    return payload.x > nowSeconds ? payload : null
  } catch {
    return null
  }
}
