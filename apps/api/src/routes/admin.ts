/**
 * `/api/admin/*` (behind requireAuth, so cookie requests that change something carry the Origin
 * check): the users list, every site's listing, the audit log, the mail page (settings, health
 * and a test email), the instance's settings, the invitations (list, invite, revoke), a site
 * server's kill switch and limits, resolving a viewer id, the deleted sites kept, restoring them
 * and deleting them for good (deletion.ts), the archive policy and its switch (archive-policy.ts),
 * and starting and stopping an impersonation. admin.ts
 * decides and audits; this turns the result into the session cookie.
 */
import {
  AdminInvitationListSchema,
  AdminInvitationSchema,
  AdminInviteResultSchema,
  AdminRouteTableSchema,
  AdminSettingsSchema,
  AdminSiteListSchema,
  AdminUserListSchema,
  ArchivePolicyStatusSchema,
  ArchivePolicySwitchRequestSchema,
  AuditListSchema,
  DeletedOrderSchema,
  DeletedSitesSchema,
  ImpersonateRequestSchema,
  InviteRequestSchema,
  MailAdminSchema,
  MailTestRequestSchema,
  MailTestResultSchema,
  MeSchema,
  RestoreResultSchema,
  RestoreSiteRequestSchema,
  RouteFormatRequestSchema,
} from '@fling/shared'
import { InstanceUsageSchema, ViewCountingRequestSchema } from '@fling/shared/metrics'
import { Hono } from 'hono'
import { z } from 'zod'
import * as admin from '../admin.ts'
import { archivePolicyStatus, setArchivePolicyLive } from '../archive-policy.ts'
import { principalOf } from '../auth/middleware.ts'
import { IMPERSONATION_TTL_SECONDS, reissueSession } from '../auth/session.ts'
import * as deletion from '../deletion.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { jsonBody } from '../lib/validate.ts'
import { routeTableStatus, setRouteFormat } from '../route-format.ts'
import * as servers from '../servers/api.ts'
import type { AppEnv } from '../types.ts'
import { instanceUsage, setViewCounting } from '../views.ts'

export const adminRoutes = new Hono<AppEnv>()

const ResolveViewerRequestSchema = z.object({ id: z.string().min(1).max(40) })

adminRoutes.get('/users', async c => {
  const limit = c.req.query('limit')
  const list = await admin.listUsers(c.get('deps'), principalOf(c), {
    q: c.req.query('q'),
    cursor: c.req.query('cursor'),
    limit: limit ? Number(limit) || undefined : undefined,
  })
  return c.json(AdminUserListSchema.parse(list))
})

adminRoutes.get('/sites', async c => {
  const limit = c.req.query('limit')
  const list = await admin.listSites(c.get('deps'), principalOf(c), {
    q: c.req.query('q'),
    owner: c.req.query('owner'),
    after: c.req.query('after'),
    limit: limit ? Number(limit) || undefined : undefined,
  })
  return c.json(AdminSiteListSchema.parse(list))
})

// Site servers (servers/api.ts): an admin's kill switch and limits, and resolving a viewer id.
adminRoutes.put('/sites/:name/server', async c => {
  const req = await jsonBody(c, servers.AdminServerRequestSchema)
  const state = await servers.adminSetServer(c.get('deps'), c.get('user'), c.req.param('name'), req)
  return c.json(state)
})

adminRoutes.post('/sites/:name/viewers/resolve', async c => {
  const { id } = await jsonBody(c, ResolveViewerRequestSchema)
  const found = await servers.adminResolveViewer(
    c.get('deps'),
    c.get('user'),
    principalOf(c),
    c.req.param('name'),
    id
  )
  return c.json(found)
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

adminRoutes.get('/route-table', async c =>
  c.json(AdminRouteTableSchema.parse(await routeTableStatus(c.get('deps'), principalOf(c))))
)

adminRoutes.post('/route-table', async c => {
  const p = principalOf(c)
  admin.ensure(p, 'admin.routes.write')
  const { format } = await jsonBody(c, RouteFormatRequestSchema)
  const status = await setRouteFormat(c.get('deps'), p, format)
  return c.json(AdminRouteTableSchema.parse(status))
})

adminRoutes.get('/usage', async c =>
  c.json(InstanceUsageSchema.parse(await instanceUsage(c.get('deps'), principalOf(c))))
)

adminRoutes.put('/usage/view-counting', async c => {
  const p = principalOf(c)
  admin.ensure(p, 'admin.usage.write')
  const { on } = await jsonBody(c, ViewCountingRequestSchema)
  return c.json(InstanceUsageSchema.parse(await setViewCounting(c.get('deps'), p, on)))
})

// The archive policy (archive-policy.ts): any admin credential reads it; only a browser session
// turns it live or back to dry run.
adminRoutes.get('/archive-policy', async c =>
  c.json(ArchivePolicyStatusSchema.parse(await archivePolicyStatus(c.get('deps'), principalOf(c))))
)

adminRoutes.put('/archive-policy', async c => {
  const p = principalOf(c)
  admin.ensure(p, 'admin.archive.write')
  const { live } = await jsonBody(c, ArchivePolicySwitchRequestSchema)
  const status = await setArchivePolicyLive(c.get('deps'), p, live)
  return c.json(ArchivePolicyStatusSchema.parse(status))
})

// Deleted sites (deletion.ts): any admin credential lists them; only a browser session restores
// them or deletes them for good.
adminRoutes.get('/deleted', async c => {
  const p = principalOf(c)
  // Only admins learn that the query was wrong: everyone else gets the 404 first.
  admin.ensure(p, 'admin.deleted.read')
  const limit = c.req.query('limit')
  const order = DeletedOrderSchema.safeParse(c.req.query('order') ?? 'newest')
  if (!order.success) throw badRequest('order is newest or oldest')
  const list = await deletion.listDeleted(c.get('deps'), p, {
    name: c.req.query('name'),
    order: order.data,
    cursor: c.req.query('cursor'),
    limit: limit ? Number(limit) || undefined : undefined,
  })
  return c.json(DeletedSitesSchema.parse(list))
})

adminRoutes.post('/deleted/:siteId/restore', async c => {
  const p = principalOf(c)
  // Only admins learn that the body was wrong: everyone else gets the 404 first.
  admin.ensure(p, 'admin.deleted.restore')
  const req = await jsonBody(c, RestoreSiteRequestSchema)
  const deps = c.get('deps')
  const result = await deletion.restoreSite(deps, c.get('user'), p, c.req.param('siteId'), req)
  return c.json(RestoreResultSchema.parse(result))
})

adminRoutes.post('/deleted/:siteId/paths/:pathId/restore', async c => {
  const deps = c.get('deps')
  const { siteId, pathId } = c.req.param()
  const result = await deletion.restorePath(deps, c.get('user'), principalOf(c), siteId, pathId)
  return c.json(RestoreResultSchema.parse(result))
})

adminRoutes.delete('/deleted/:siteId', async c => {
  await deletion.purgeSite(c.get('deps'), c.get('user'), principalOf(c), c.req.param('siteId'))
  return c.body(null, 204)
})

adminRoutes.delete('/deleted/:siteId/paths/:pathId', async c => {
  const { siteId, pathId } = c.req.param()
  await deletion.purgePath(c.get('deps'), c.get('user'), principalOf(c), siteId, pathId)
  return c.body(null, 204)
})

adminRoutes.get('/settings', c =>
  c.json(AdminSettingsSchema.parse(admin.settings(c.get('deps'), principalOf(c))))
)

adminRoutes.get('/invitations', async c => {
  const limit = c.req.query('limit')
  const list = await admin.listInvitations(c.get('deps'), principalOf(c), {
    q: c.req.query('q'),
    cursor: c.req.query('cursor'),
    limit: limit ? Number(limit) || undefined : undefined,
  })
  return c.json(AdminInvitationListSchema.parse(list))
})

adminRoutes.post('/invitations', async c => {
  const p = principalOf(c)
  // Only admins learn that the body was wrong: everyone else gets the 404 first.
  admin.ensure(p, 'admin.invitations.manage')
  const { email } = await jsonBody(c, InviteRequestSchema)
  const result = await admin.invite(c.get('deps'), p, email)
  return c.json(AdminInviteResultSchema.parse(result), 201)
})

adminRoutes.delete('/invitations/:email', async c => {
  const email = c.req.param('email').trim().toLowerCase()
  const revoked = await admin.revokeInvitation(c.get('deps'), principalOf(c), email)
  return c.json(AdminInvitationSchema.parse(revoked))
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
