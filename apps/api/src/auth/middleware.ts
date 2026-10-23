/**
 * `requireAuth`: Bearer API key, else the session cookie. Cookie-authenticated mutating
 * requests must carry `Origin: <APP_ORIGIN>` (CSRF); Bearer requests skip that check.
 */
import { createMiddleware } from 'hono/factory'
import { forbidden, unauthorized } from '../lib/errors.ts'
import type { AppEnv } from '../types.ts'
import { validateApiKey } from './api-keys.ts'
import { readSessionToken, verifySession } from './session.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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

  const email = await verifySession(readSessionToken(c), config.secrets.sessionSecret, clock.now())
  const user = email ? await store.getUser(email) : null
  if (!user) throw unauthorized()
  if (!SAFE_METHODS.has(c.req.method) && c.req.header('origin') !== config.appOrigin) {
    throw forbidden('Cross-origin request refused', 'csrf')
  }
  c.set('user', user)
  c.set('via', 'session')
  return next()
})
