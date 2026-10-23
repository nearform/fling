/**
 * Session + site cookies.
 *  - session: stateless HS256 JWT (jose, SESSION_SECRET, 7 days) in `__Host-fling_session`
 *    (HttpOnly, Secure, SameSite=Lax, Path=/). Over plain-http dev it is `fling_session`
 *    without Secure, since browsers drop `__Host-`/Secure cookies on http.
 *  - `fling_site`: HMAC cookie on SITE_COOKIE_DOMAIN that the edge verifies for private sites.
 */
import {
  SITE_COOKIE_NAME,
  SITE_COOKIE_TTL_SECONDS,
  signSiteCookie,
} from '@fling/shared/site-cookie'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { jwtVerify, SignJWT } from 'jose'
import type { Config } from '../config.ts'
import type { AppEnv } from '../types.ts'

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export const sessionCookieName = (cfg: Pick<Config, 'secureCookies'>) =>
  cfg.secureCookies ? '__Host-fling_session' : 'fling_session'

const keyOf = (secret: string) => new TextEncoder().encode(secret)

export async function signSession(email: string, secret: string, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(email)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(keyOf(secret))
}

/** The session's email, or null if missing/invalid/expired. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now: Date
): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: ['HS256'],
      currentDate: now,
    })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, sessionCookieName(c.get('deps').config))
}

export function setSiteCookie(c: Context<AppEnv>, email: string) {
  const { config, clock } = c.get('deps')
  const exp = Math.floor(clock.now().getTime() / 1000) + SITE_COOKIE_TTL_SECONDS
  setCookie(c, SITE_COOKIE_NAME, signSiteCookie({ e: email, x: exp }, config.secrets.siteHmacKey), {
    domain: config.siteCookieDomain,
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge: SITE_COOKIE_TTL_SECONDS,
  })
}

/** Sign in: session cookie + site cookie. */
export async function startSession(c: Context<AppEnv>, email: string) {
  const { config, clock } = c.get('deps')
  const token = await signSession(email, config.secrets.sessionSecret, clock.now())
  setCookie(c, sessionCookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SECONDS,
  })
  setSiteCookie(c, email)
}

export function endSession(c: Context<AppEnv>) {
  const { config } = c.get('deps')
  deleteCookie(c, sessionCookieName(config), { path: '/', secure: config.secureCookies })
  deleteCookie(c, SITE_COOKIE_NAME, {
    path: '/',
    domain: config.siteCookieDomain,
    secure: config.secureCookies,
  })
}
