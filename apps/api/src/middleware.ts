import { timingSafeEqual } from 'node:crypto'
import type { ErrorHandler, NotFoundHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import { ApiError } from './lib/errors.ts'
import type { AppEnv } from './types.ts'

/** Minimal security headers on every response (JSON API and the odd server-rendered page, never framed). */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  if (c.get('deps').config.secureCookies) {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  // A page the API renders itself (the unsubscribe page) sets its own, stricter where it can.
  if (!c.res.headers.has('Referrer-Policy')) {
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  }
  if (!c.res.headers.has('Content-Security-Policy')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  }
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
})

/**
 * CloudFront adds `x-origin-verify: <secret>` on its way to the function URL; anything without it
 * went around CloudFront. Skipped when no secret is configured, and in development a missing
 * header is allowed (a wrong one never is).
 */
export const originVerify = createMiddleware<AppEnv>(async (c, next) => {
  const { config } = c.get('deps')
  const secret = config.secrets.originVerifySecret
  if (secret) {
    const given = c.req.header('x-origin-verify')
    const missingOk = given === undefined && config.appEnv === 'development'
    if (!missingOk) {
      const a = Buffer.from(given ?? '')
      const b = Buffer.from(secret)
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return c.json({ error: { code: 'forbidden', message: 'Forbidden' } }, 403)
      }
    }
  }
  return next()
})

export const notFoundHandler: NotFoundHandler<AppEnv> = c =>
  c.json({ error: { code: 'not_found', message: `Not found: ${c.req.path}` } }, 404)

/** The only place errors become responses: `{ error: { code, message, ...extra } }`. */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...err.extra } },
      err.status as ContentfulStatusCode
    )
  }
  if (err instanceof ZodError) {
    const message = err.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '(body)'}: ${i.message}`)
      .join('; ')
    return c.json({ error: { code: 'validation_failed', message } }, 400)
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode
    const code = status === 413 ? 'too_large' : 'http_error'
    return c.json({ error: { code, message: err.message || 'Request failed' } }, status)
  }
  console.error(
    JSON.stringify({
      level: 'error',
      path: c.req.path,
      err: String(err),
      stack: (err as Error).stack,
    })
  )
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
}
