/** `/api/*` — JSON, authenticated (session cookie + Origin check, or Bearer API key). */
import {
  ApiKeyListSchema,
  ConnectionListSchema,
  DeployRequestSchema,
  DeployResponseSchema,
  FinalizeResponseSchema,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  type Me,
  NameCheckSchema,
  OAuthDecisionSchema,
  OAuthRequestInfoSchema,
  RollbackRequestSchema,
  ShareResponseSchema,
  SiteDetailSchema,
  SiteListSchema,
  SiteSchema,
  UpdateSiteRequestSchema,
  VersionFilesSchema,
} from '@fling/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth } from '../auth/middleware.ts'
import { ApiError, forbidden, notFound } from '../lib/errors.ts'
import { jsonBody } from '../lib/validate.ts'
import { decide, requestInfo } from '../oauth/flow.ts'
import * as sites from '../sites.ts'
import type { AppEnv } from '../types.ts'

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

apiRoutes.get('/me', c => {
  const u = c.get('user')
  const me: Me = { email: u.email, name: u.name, picture: u.picture, userSlug: u.userSlug }
  return c.json(me)
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
  const deleted = await c.get('deps').store.deleteGrant(c.get('user').email, c.req.param('id'))
  if (!deleted) throw notFound('No such connection')
  return c.body(null, 204)
})

/** Consent for /oauth/authorize — browser session only (never an API key). */
const requireSession = (c: { get(k: 'via'): string }) => {
  if (c.get('via') !== 'session') throw forbidden('Sign in with your browser to approve apps')
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
  const check = await sites.checkName(c.get('deps'), c.get('user'), c.req.param('name'))
  return c.json(NameCheckSchema.parse(check))
})

apiRoutes.get('/sites', async c => {
  const archived = ['1', 'true'].includes(c.req.query('archived') ?? '')
  const list = await sites.listSites(c.get('deps'), c.get('user'), archived)
  return c.json(SiteListSchema.parse({ sites: list }))
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
  const site = await sites.updateSite(c.get('deps'), c.get('user'), c.req.param('name'), patch)
  return c.json(SiteSchema.parse(site))
})

/** Size caps are 413s, checked before the schema (whose refinements would make them 400s). */
function checkDeploySize(raw: unknown) {
  const files = (raw as { manifest?: { files?: unknown } } | null)?.manifest?.files
  if (!Array.isArray(files)) return
  if (files.length > MAX_FILES) {
    throw new ApiError(413, 'too_large', `Too many files (max ${MAX_FILES})`)
  }
  let total = 0
  for (const f of files) {
    const size = typeof f?.size === 'number' ? f.size : 0
    if (size > MAX_FILE_BYTES) {
      throw new ApiError(
        413,
        'too_large',
        `${String(f.path)} is larger than ${MAX_FILE_BYTES} bytes`
      )
    }
    total += size
  }
  if (total > MAX_DEPLOY_BYTES) {
    throw new ApiError(413, 'too_large', `Deploy is larger than ${MAX_DEPLOY_BYTES} bytes`)
  }
}

apiRoutes.post('/sites/:name/deploys', async c => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ApiError(400, 'invalid_json', 'Body must be JSON')
  }
  checkDeploySize(raw)
  const req = DeployRequestSchema.parse(raw)
  const res = await sites.deploy(c.get('deps'), c.get('user'), c.req.param('name'), req)
  return c.json(DeployResponseSchema.parse(res))
})

apiRoutes.post('/sites/:name/deploys/:versionId/finalize', async c => {
  const res = await sites.finalize(
    c.get('deps'),
    c.get('user'),
    c.req.param('name'),
    c.req.param('versionId')
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
