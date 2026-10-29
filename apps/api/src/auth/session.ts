/**
 * Session + site cookies.
 *  - session: stateless HS256 JWT (jose, SESSION_SECRET, 7 days) in `__Host-fling_session`
 *    (HttpOnly, Secure, SameSite=Lax, Path=/). Over plain-http dev it is `fling_session`
 *    without Secure, since browsers drop `__Host-`/Secure cookies on http.
 *  - `fling_site`: HMAC cookie on SITE_COOKIE_DOMAIN that the edge verifies for private sites;
 *    a guest's says so (`g: 1`).
 *
 * Claims: `sub` is who signed in, `iat`/`exp` the session. An admin impersonating someone has the
 * same session (same `sub` and `exp`: starting and stopping never extend it) plus `imp` (whom
 * they act as) and `impx` (epoch seconds when that lapses; IMPERSONATION_TTL_SECONDS after it
 * started, never pushed out). Sessions from before impersonation have neither and are unchanged;
 * code from before reads an impersonating session as the admin's own (`sub`), never as the
 * target's. Whether `imp` is honoured is decided per request (resolveSession in middleware.ts).
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
/** How long an impersonation lasts, from its start; never extended. */
export const IMPERSONATION_TTL_SECONDS = 60 * 60

export interface SessionClaims {
  /** who signed in (`sub`) */
  email: string
  /** when the session ends (epoch seconds) */
  exp: number
  /** an admin acting as another user, until `until` (epoch seconds) */
  impersonating?: { email: string; until: number }
}

export const sessionCookieName = (cfg: Pick<Config, 'secureCookies'>) =>
  cfg.secureCookies ? '__Host-fling_session' : 'fling_session'

const keyOf = (secret: string) => new TextEncoder().encode(secret)

/** A new session (7 days), or with `exp`, the rest of an existing one. */
export async function signSession(
  email: string,
  secret: string,
  now: Date,
  opts: { exp?: number; impersonating?: { email: string; until: number } } = {}
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  const imp = opts.impersonating
  return new SignJWT(imp ? { imp: imp.email, impx: imp.until } : {})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(email)
    .setIssuedAt(iat)
    .setExpirationTime(opts.exp ?? iat + SESSION_TTL_SECONDS)
    .sign(keyOf(secret))
}

/** The session's claims, or null if missing/invalid/expired. */
export async function readSession(
  token: string | undefined,
  secret: string,
  now: Date
): Promise<SessionClaims | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: ['HS256'],
      currentDate: now,
    })
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null
    const { imp, impx } = payload
    return {
      email: payload.sub,
      exp: payload.exp,
      ...(typeof imp === 'string' && typeof impx === 'number'
        ? { impersonating: { email: imp, until: impx } }
        : {}),
    }
  } catch {
    return null
  }
}

/** The session's email (who signed in), or null if missing/invalid/expired. */
export async function verifySession(token: string | undefined, secret: string, now: Date) {
  return (await readSession(token, secret, now))?.email ?? null
}

export function readSessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, sessionCookieName(c.get('deps').config))
}

/** Who the site cookie is for. A guest's says `g: 1`, so the edge keeps them off members' sites. */
export interface SiteCookieUser {
  email: string
  guest?: boolean
}

export function setSiteCookie(c: Context<AppEnv>, user: SiteCookieUser) {
  const { config, clock } = c.get('deps')
  const exp = Math.floor(clock.now().getTime() / 1000) + SITE_COOKIE_TTL_SECONDS
  const payload = { e: user.email, x: exp, ...(user.guest ? { g: 1 as const } : {}) }
  setCookie(c, SITE_COOKIE_NAME, signSiteCookie(payload, config.secrets.siteHmacKey), {
    domain: config.siteCookieDomain,
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge: SITE_COOKIE_TTL_SECONDS,
  })
}

function setSessionCookie(c: Context<AppEnv>, token: string, maxAge: number) {
  const { config } = c.get('deps')
  setCookie(c, sessionCookieName(config), token, {
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge,
  })
}

/** Sign in: session cookie + site cookie. */
export async function startSession(c: Context<AppEnv>, user: SiteCookieUser) {
  const { config, clock } = c.get('deps')
  const token = await signSession(user.email, config.secrets.sessionSecret, clock.now())
  setSessionCookie(c, token, SESSION_TTL_SECONDS)
  setSiteCookie(c, user)
}

/**
 * The same session (who signed in, and when it ends), now impersonating someone or, without
 * `impersonating`, no longer. The site cookie stays: it only says "signed in".
 */
export async function reissueSession(
  c: Context<AppEnv>,
  session: SessionClaims,
  impersonating?: { email: string; until: number }
) {
  const { config, clock } = c.get('deps')
  const now = clock.now()
  const token = await signSession(session.email, config.secrets.sessionSecret, now, {
    exp: session.exp,
    ...(impersonating ? { impersonating } : {}),
  })
  setSessionCookie(c, token, Math.max(0, session.exp - Math.floor(now.getTime() / 1000)))
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
