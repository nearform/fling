/**
 * `requireAuth`: Bearer API key, else the session cookie. Cookie-authenticated mutating
 * requests must carry `Origin: <APP_ORIGIN>` (CSRF); Bearer requests skip that check.
 *
 * `resolveSession` is the one place a session cookie becomes a user, impersonation included:
 * the routes outside /api that read the session (/auth/login, /auth/cli, /oauth/authorize) use
 * it too.
 */
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { type Config, isAdminEmail } from '../config.ts'
import { forbidden, unauthorized } from '../lib/errors.ts'
import { canInstance, type InstanceAction, type Principal } from '../policy.ts'
import type { User } from '../store/types.ts'
import type { AppEnv } from '../types.ts'
import { validateApiKey } from './api-keys.ts'
import { readSession, readSessionToken, type SessionClaims } from './session.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface ResolvedSession {
  /** the effective user: whom an impersonating admin acts as, else who signed in */
  user: User
  /** the admin, while impersonating */
  impersonator?: string
  claims: SessionClaims
}

/**
 * The session's user. An impersonation is honoured only while it hasn't lapsed, whoever signed in
 * is still an admin, and the target is a user who isn't one; otherwise the session is the
 * signer's own (and stopping clears the leftover claim).
 */
export async function resolveSession(c: Context<AppEnv>): Promise<ResolvedSession | null> {
  const { config, clock, store } = c.get('deps')
  const now = clock.now()
  const claims = await readSession(readSessionToken(c), config.secrets.sessionSecret, now)
  if (!claims) return null
  const imp = claims.impersonating
  if (
    imp &&
    imp.until * 1000 > now.getTime() &&
    isAdminEmail(config, claims.email) &&
    !isAdminEmail(config, imp.email)
  ) {
    const [admin, target] = await Promise.all([
      store.getUser(claims.email),
      store.getUser(imp.email),
    ])
    if (admin && target) return { user: target, impersonator: claims.email, claims }
  }
  const user = await store.getUser(claims.email)
  return user ? { user, claims } : null
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { store, config, clock } = c.get('deps')
  const header = c.req.header('authorization')
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    const result = match?.[1] ? await validateApiKey(store, match[1], clock.now()) : null
    if (!result) throw unauthorized('Invalid API key')
    c.set('user', result.user)
    c.set('via', 'api_key')
    return next()
  }

  const session = await resolveSession(c)
  if (!session) throw unauthorized()
  if (!SAFE_METHODS.has(c.req.method) && c.req.header('origin') !== config.appOrigin) {
    throw forbidden('Cross-origin request refused', 'csrf')
  }
  c.set('user', session.user)
  c.set('via', 'session')
  c.set('session', session.claims)
  if (session.impersonator) c.set('impersonator', session.impersonator)
  return next()
})

/** A browser session as a caller, for the instance and account actions in policy.ts. */
export function sessionPrincipal(
  config: Pick<Config, 'adminEmails'>,
  session: ResolvedSession
): Principal {
  return {
    email: session.user.email,
    admin: isAdminEmail(config, session.user.email),
    via: 'session',
    ...(session.impersonator ? { impersonator: session.impersonator } : {}),
  }
}

/** The authenticated caller, for the instance and account actions in policy.ts. */
export function principalOf(c: Context<AppEnv>): Principal {
  const { config } = c.get('deps')
  const email = c.get('user').email
  const impersonator = c.get('impersonator')
  return {
    email,
    admin: isAdminEmail(config, email),
    via: c.get('via'),
    ...(impersonator ? { impersonator } : {}),
  }
}

/** Refuse an account action while impersonating (403, so the UI can say why). */
export function requireAccountAction(c: Context<AppEnv>, action: InstanceAction, what: string) {
  if (!canInstance(principalOf(c), action)) {
    throw forbidden(`Not while impersonating ${c.get('user').email}: ${what}`, 'impersonating')
  }
}
