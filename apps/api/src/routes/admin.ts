/**
 * `/api/admin/*` (behind requireAuth, so cookie requests that change something carry the Origin
 * check): the users list, the audit log, the mail page (settings, health and a test email), and
 * starting and stopping an impersonation. admin.ts
 * decides and audits; this turns the result into the session cookie.
 */
import {
  AdminUserListSchema,
  AuditListSchema,
  ImpersonateRequestSchema,
  MailAdminSchema,
  MailTestRequestSchema,
  MailTestResultSchema,
  MeSchema,
} from '@fling/shared'
import { Hono } from 'hono'
import * as admin from '../admin.ts'
import { principalOf } from '../auth/middleware.ts'
import { IMPERSONATION_TTL_SECONDS, reissueSession } from '../auth/session.ts'
import { notFound } from '../lib/errors.ts'
import { jsonBody } from '../lib/validate.ts'
import type { AppEnv } from '../types.ts'

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.get('/users', async c => {
  const limit = c.req.query('limit')
  const list = await admin.listUsers(c.get('deps'), principalOf(c), {
    q: c.req.query('q'),
    cursor: c.req.query('cursor'),
    limit: limit ? Number(limit) || undefined : undefined,
  })
  return c.json(AdminUserListSchema.parse(list))
})

adminRoutes.get('/audit', async c => {
  const entries = await admin.auditLog(c.get('deps'), principalOf(c))
  return c.json(AuditListSchema.parse({ entries }))
})

adminRoutes.get('/mail', async c => {
  const overview = await admin.mail(c.get('deps'), principalOf(c))
  return c.json(MailAdminSchema.parse(overview))
})

adminRoutes.post('/mail/test', async c => {
  const p = principalOf(c)
  // Only admins learn that the body was wrong: everyone else gets the 404 first.
  admin.ensure(p, 'admin.mail.test')
  const { to } = await jsonBody(c, MailTestRequestSchema)
  const result = await admin.mailTest(c.get('deps'), p, to)
  return c.json(MailTestResultSchema.parse(result))
})

adminRoutes.post('/impersonate', async c => {
  const { email } = await jsonBody(c, ImpersonateRequestSchema)
  const deps = c.get('deps')
  const session = c.get('session')
  // Fixed from now, and never past the admin's own session.
  const now = Math.floor(deps.clock.now().getTime() / 1000)
  const until = Math.min(now + IMPERSONATION_TTL_SECONDS, session?.exp ?? now)
  const target = await admin.startImpersonation(deps, principalOf(c), email, new Date(until * 1000))
  if (!session) throw notFound('Not found') // unreachable: startImpersonation needs a session
  await reissueSession(c, session, { email: target.email, until })
  const me = admin.meOf(deps, target, { by: session.email, until: new Date(until * 1000) })
  return c.json(MeSchema.parse(me))
})

/**
 * Back to the admin's own session, no sign-in needed. Also clears an impersonation that lapsed
 * (or that stopped counting because its admin no longer is one): audited with `lapsed`.
 */
adminRoutes.post('/impersonate/stop', async c => {
  const deps = c.get('deps')
  const session = c.get('session')
  const imp = session?.impersonating
  if (!session || !imp) throw notFound('Not impersonating anyone')
  const active = c.get('impersonator') !== undefined
  await admin.stopImpersonation(deps, session.email, imp.email, !active)
  await reissueSession(c, session)
  const user = await deps.store.getUser(session.email)
  if (!user) throw notFound('Not found')
  return c.json(MeSchema.parse(admin.meOf(deps, user)))
})
