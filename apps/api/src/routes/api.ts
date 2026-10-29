/** `/api/*` — JSON, authenticated (session cookie + Origin check, or Bearer API key). */
import {
  ApiKeyListSchema,
  CommentListSchema,
  CommentSchema,
  ConnectionListSchema,
  CreateCommentRequestSchema,
  CreateGroupRequestSchema,
  DeployResponseSchema,
  FinalizeResponseSchema,
  GroupDetailSchema,
  GroupListSchema,
  GroupMembersRequestSchema,
  LiveTicketSchema,
  MeSchema,
  NameCheckSchema,
  NotificationPreferencesUpdateSchema,
  NotificationSettingsSchema,
  OAuthDecisionSchema,
  OAuthRequestInfoSchema,
  RollbackRequestSchema,
  SentNotificationListSchema,
  SharedSiteListSchema,
  ShareResponseSchema,
  SiteDetailSchema,
  SiteListSchema,
  SiteSchema,
  SiteWithAudienceSchema,
  splitEmails,
  UpdateCommentRequestSchema,
  UpdateGroupRequestSchema,
  UpdateSiteRequestSchema,
  VersionFilesSchema,
  WhySiteSchema,
} from '@fling/shared'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { meOf } from '../admin.ts'
import { principalOf, requireAccountAction, requireAuth } from '../auth/middleware.ts'
import * as comments from '../comments.ts'
import * as groups from '../groups.ts'
import { ApiError, forbidden, notFound } from '../lib/errors.ts'
import { jsonBody } from '../lib/validate.ts'
import { issueLiveTicket } from '../live.ts'
import type { Acting } from '../notifications/notify.ts'
import * as notifications from '../notifications/settings.ts'
import { decide, requestInfo } from '../oauth/flow.ts'
import { canInstance, userActor } from '../policy.ts'
import * as publication from '../publication.ts'
import * as sites from '../sites.ts'
import type { AppEnv } from '../types.ts'
import { adminRoutes } from './admin.ts'

export const apiRoutes = new Hono<AppEnv>()

apiRoutes.use(
  '*',
  bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: () => {
      throw new ApiError(413, 'too_large', 'Request body too large')
    },
  })
)
apiRoutes.use('*', requireAuth)

/** The admin acting as the user, if any: what they do then notifies nobody. */
function acting(c: Context<AppEnv>): Acting {
  const impersonator = c.get('impersonator')
  return impersonator ? { impersonator } : {}
}

apiRoutes.get('/me', c => {
  const impersonator = c.get('impersonator')
  const until = c.get('session')?.impersonating?.until
  const impersonation =
    impersonator && until ? { by: impersonator, until: new Date(until * 1000) } : undefined
  return c.json(MeSchema.parse(meOf(c.get('deps'), c.get('user'), impersonation)))
})

apiRoutes.route('/admin', adminRoutes)

// --- notifications (the `notifications` capability): what the caller hears about, and what was sent ---

apiRoutes.get('/me/notifications', async c => {
  const settings = await notifications.getNotificationSettings(c.get('deps'), c.get('user').email)
  return c.json(NotificationSettingsSchema.parse(settings))
})

apiRoutes.put('/me/notifications', async c => {
  notifications.channelsOn(c.get('deps'))
  const update = await jsonBody(c, NotificationPreferencesUpdateSchema)
  const settings = await notifications.updateNotificationSettings(
    c.get('deps'),
    principalOf(c),
    update
  )
  return c.json(NotificationSettingsSchema.parse(settings))
})

apiRoutes.get('/me/notifications/sent', async c => {
  notifications.channelsOn(c.get('deps'))
  const p = principalOf(c)
  // Admins never read other people's mail, impersonating or not.
  if (!canInstance(p, 'account.notifications.sent')) {
    throw forbidden(`Not while impersonating ${p.email}: the mail sent to them`, 'impersonating')
  }
  const sent = await notifications.sentNotifications(c.get('deps'), p.email)
  return c.json(SentNotificationListSchema.parse({ sent }))
})

apiRoutes.get('/keys', async c => {
  const keys = await c.get('deps').store.listApiKeys(c.get('user').email)
  return c.json(
    ApiKeyListSchema.parse({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    })
  )
})

apiRoutes.delete('/keys/:id', async c => {
  requireAccountAction(c, 'account.revoke', "revoking the user's CLI logins")
  const deleted = await c.get('deps').store.deleteApiKey(c.get('user').email, c.req.param('id'))
  if (!deleted) throw notFound('No such API key')
  return c.body(null, 204)
})

/** Apps connected through OAuth (Claude connectors); revoking one cuts it off at once. */
apiRoutes.get('/connections', async c => {
  const grants = await c.get('deps').store.listGrants(c.get('user').email)
  const now = c.get('deps').clock.now().getTime()
  return c.json(
    ConnectionListSchema.parse({
      connections: grants
        .filter(g => Date.parse(g.expiresAt) > now)
        .map(g => ({
          id: g.id,
          clientName: g.clientName,
          clientHost: g.clientHost,
          createdAt: g.createdAt,
          lastUsedAt: g.lastUsedAt,
        })),
    })
  )
})

apiRoutes.delete('/connections/:id', async c => {
  requireAccountAction(c, 'account.revoke', "revoking the user's connected apps")
  const deleted = await c.get('deps').store.deleteGrant(c.get('user').email, c.req.param('id'))
  if (!deleted) throw notFound('No such connection')
  return c.body(null, 204)
})

/** Consent for /oauth/authorize — browser session only (never an API key), not impersonating. */
const requireSession = (c: Context<AppEnv>) => {
  if (c.get('via') !== 'session') throw forbidden('Sign in with your browser to approve apps')
  requireAccountAction(c, 'account.oauth.approve', 'connecting apps to the account')
}

apiRoutes.get('/oauth/requests/:id', async c => {
  requireSession(c)
  const info = await requestInfo(c.get('deps'), c.get('user'), c.req.param('id'))
  if (!info) throw notFound('This sign-in request has expired. Start again from the app.')
  return c.json(OAuthRequestInfoSchema.parse(info))
})

for (const action of ['approve', 'deny'] as const) {
  apiRoutes.post(`/oauth/requests/:id/${action}`, async c => {
    requireSession(c)
    const redirectUrl = await decide(
      c.get('deps'),
      c.get('user'),
      c.req.param('id'),
      action === 'approve'
    )
    if (!redirectUrl) throw notFound('This sign-in request has expired. Start again from the app.')
    return c.json(OAuthDecisionSchema.parse({ redirectUrl }))
  })
}

apiRoutes.get('/names/:name', async c => {
  requireAccountAction(c, 'account.site.create', 'checking names for new sites')
  const check = await sites.checkName(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.json(NameCheckSchema.parse(check))
})

apiRoutes.get('/why', async c => c.json(WhySiteSchema.parse(await sites.whySite(c.get('deps')))))

apiRoutes.get('/sites', async c => {
  const archived = ['1', 'true'].includes(c.req.query('archived') ?? '')
  const list = await sites.listSites(c.get('deps'), c.get('user'), archived)
  return c.json(SiteListSchema.parse({ sites: list }))
})

apiRoutes.get('/shared', async c => {
  const list = await sites.listShared(c.get('deps'), c.get('user'))
  return c.json(SharedSiteListSchema.parse({ sites: list }))
})

apiRoutes.get('/sites/:name', async c => {
  const detail = await sites.siteDetail(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.json(SiteDetailSchema.parse(detail))
})

apiRoutes.get('/sites/:name/versions/:versionId/files', async c => {
  const files = await sites.versionFiles(
    c.get('deps'),
    c.get('user'),
    c.req.param('name'),
    c.req.param('versionId')
  )
  return c.json(VersionFilesSchema.parse(files))
})

apiRoutes.patch('/sites/:name', async c => {
  const patch = await jsonBody(c, UpdateSiteRequestSchema)
  const site = await sites.updateSite(
    c.get('deps'),
    c.get('user'),
    c.req.param('name'),
    patch,
    acting(c)
  )
  return c.json(SiteWithAudienceSchema.parse(site))
})

apiRoutes.post('/sites/:name/deploys', async c => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ApiError(400, 'invalid_json', 'Body must be JSON')
  }
  const res = await publication.stage(
    c.get('deps'),
    c.get('user'),
    c.req.param('name'),
    raw,
    principalOf(c)
  )
  return c.json(DeployResponseSchema.parse(res))
})

apiRoutes.post('/sites/:name/deploys/:versionId/finalize', async c => {
  const res = await publication.publish(
    c.get('deps'),
    c.get('user'),
    c.req.param('name'),
    c.req.param('versionId'),
    acting(c)
  )
  return c.json(FinalizeResponseSchema.parse(res))
})

apiRoutes.post('/sites/:name/current', async c => {
  const { versionId } = await jsonBody(c, RollbackRequestSchema)
  const site = await sites.rollback(c.get('deps'), c.get('user'), c.req.param('name'), versionId)
  return c.json(SiteSchema.parse(site))
})

apiRoutes.post('/sites/:name/share', async c => {
  const res = await sites.rotateShare(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.json(ShareResponseSchema.parse(res))
})

apiRoutes.delete('/sites/:name/share', async c => {
  await sites.revokeShare(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.body(null, 204)
})

apiRoutes.post('/sites/:name/archive', async c => {
  const site = await sites.setArchived(c.get('deps'), c.get('user'), c.req.param('name'), true)
  return c.json(SiteSchema.parse(site))
})

apiRoutes.post('/sites/:name/unarchive', async c => {
  const site = await sites.setArchived(c.get('deps'), c.get('user'), c.req.param('name'), false)
  return c.json(SiteSchema.parse(site))
})

apiRoutes.delete('/sites/:name', async c => {
  await sites.deleteSite(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.body(null, 204)
})

// --- comments (review mode). Policy decides per site: members of the instance take part too. ---

apiRoutes.get('/sites/:name/comments', async c => {
  const list = await comments.listComments(
    c.get('deps'),
    userActor(c.get('user')),
    c.req.param('name'),
    { path: c.req.query('path') }
  )
  return c.json(CommentListSchema.parse(list))
})

apiRoutes.post('/sites/:name/comments', async c => {
  const input = await jsonBody(c, CreateCommentRequestSchema)
  const comment = await comments.addComment(
    c.get('deps'),
    userActor(c.get('user')),
    c.req.param('name'),
    input,
    acting(c)
  )
  return c.json(CommentSchema.parse(comment), 201)
})

apiRoutes.patch('/sites/:name/comments/:id', async c => {
  const { resolved } = await jsonBody(c, UpdateCommentRequestSchema)
  const comment = await comments.resolveComment(
    c.get('deps'),
    userActor(c.get('user')),
    c.req.param('name'),
    c.req.param('id'),
    resolved
  )
  return c.json(CommentSchema.parse(comment))
})

apiRoutes.delete('/sites/:name/comments/:id', async c => {
  await comments.deleteComment(
    c.get('deps'),
    userActor(c.get('user')),
    c.req.param('name'),
    c.req.param('id')
  )
  return c.body(null, 204)
})

/** A ticket into the site's live room (`live` capability): connect to `${url}?ticket=…` within `expiresIn`. */
apiRoutes.post('/sites/:name/live', async c => {
  const ticket = await issueLiveTicket(c.get('deps'), userActor(c.get('user')), c.req.param('name'))
  return c.json(LiveTicketSchema.parse(ticket))
})

// --- groups (the `groups` capability). canGroup decides: anyone reads, the owner changes. ---

apiRoutes.get('/groups', async c => {
  requireAccountAction(c, 'account.groups.read', 'listing groups')
  const mine = ['1', 'true'].includes(c.req.query('mine') ?? '')
  const members = c.req.query('members')
  const list = await groups.listGroups(c.get('deps'), c.get('user'), {
    mine,
    members: members === undefined ? undefined : splitEmails(members),
  })
  return c.json(GroupListSchema.parse({ groups: list }))
})

apiRoutes.post('/groups', async c => {
  requireAccountAction(c, 'account.group.create', 'making groups')
  const input = await jsonBody(c, CreateGroupRequestSchema)
  const group = await groups.createGroup(c.get('deps'), c.get('user'), input, acting(c))
  return c.json(GroupDetailSchema.parse(group), 201)
})

apiRoutes.get('/groups/:slug', async c => {
  requireAccountAction(c, 'account.groups.read', 'reading groups')
  const group = await groups.groupDetail(c.get('deps'), c.get('user'), c.req.param('slug'))
  return c.json(GroupDetailSchema.parse(group))
})

apiRoutes.patch('/groups/:slug', async c => {
  const { name } = await jsonBody(c, UpdateGroupRequestSchema)
  const group = await groups.renameGroup(c.get('deps'), c.get('user'), c.req.param('slug'), name)
  return c.json(GroupDetailSchema.parse(group))
})

apiRoutes.post('/groups/:slug/members', async c => {
  const change = await jsonBody(c, GroupMembersRequestSchema)
  const group = await groups.changeMembers(
    c.get('deps'),
    c.get('user'),
    c.req.param('slug'),
    change,
    acting(c)
  )
  return c.json(GroupDetailSchema.parse(group))
})

apiRoutes.delete('/groups/:slug', async c => {
  await groups.deleteGroup(c.get('deps'), c.get('user'), c.req.param('slug'))
  return c.body(null, 204)
})
