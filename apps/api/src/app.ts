/** Builds the Hono app from injected deps — no AWS here, so tests run on memory/fs fakes. */
import {
  INSTANCE_METADATA_MAX_AGE,
  INSTANCE_METADATA_PATH,
  MAX_FILE_BYTES,
  SERVER_SITE_HEADER,
  SITE_SEEN_PATH,
} from '@fling/shared'
import { Hono } from 'hono'
import { FS_DOWNLOAD_ROUTE, FS_UPLOAD_ROUTE, FsBlobs } from './blobs/fs.ts'
import { keyFromPath } from './blobs/signed-url.ts'
import { instanceMetadata, RELEASE } from './instance.ts'
import { bodyUpTo } from './lib/body.ts'
import {
  errorHandler,
  notFoundHandler,
  originVerify,
  releaseHeader,
  securityHeaders,
} from './middleware.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { devRoutes } from './routes/dev.ts'
import { mcpRoutes } from './routes/mcp.ts'
import { notificationRoutes } from './routes/notifications.ts'
import { oauthRoutes } from './routes/oauth.ts'
import { SLACK_EVENTS_BASE, slackRoutes } from './routes/slack.ts'
import type { AppEnv, Deps } from './types.ts'

export interface AppOptions {
  /**
   * Take the views the site router sends on (POST SITE_SEEN_PATH naming the site in
   * SERVER_SITE_HEADER): only for a platform whose sites distribution sends them to this app, and
   * only behind the origin check (platforms/aws). Everywhere else the sites host counts them.
   */
  viewsFromEdge?: boolean
}

export function createApp(deps: Deps, opts: AppOptions = {}) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.notFound(notFoundHandler)
  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })
  app.use('*', securityHeaders)
  app.use('*', releaseHeader(RELEASE))

  app.get('/healthz', c => c.json({ ok: true }))

  app.use('*', originVerify)
  // A view a page's beacon reported, sent on by the site router (platforms/aws: the sites
  // distribution's SITE_SEEN_PATH behaviour) after its access checks, naming the site in
  // SERVER_SITE_HEADER. Only behind the origin check, so only the router can name a site.
  if (opts.viewsFromEdge && deps.views && deps.config.secrets.originVerifySecret) {
    const views = deps.views
    app.post(SITE_SEEN_PATH, async c => {
      const siteId = (c.req.header(SERVER_SITE_HEADER) ?? '').split('/')[0]
      if (siteId) {
        views.count(siteId)
        await views.flushDue()
      }
      return c.body(null, 204, { 'cache-control': 'no-store' })
    })
  }
  // Public and the same for everyone: cacheable, and readable cross-origin (the sites' 404 page
  // brands itself from it).
  app.get(INSTANCE_METADATA_PATH, c => {
    c.header('Cache-Control', `public, max-age=${INSTANCE_METADATA_MAX_AGE}`)
    c.header('Access-Control-Allow-Origin', '*')
    return c.json(instanceMetadata(c.get('deps').config))
  })
  app.route('/auth', authRoutes)
  // The instance's Slack app's events (link previews): signed by Slack, no session. Under /api/,
  // which every platform's host and edge send to the API, and mounted first, so the API's sign-in
  // check never sees Slack's requests.
  if (deps.slack) app.route(SLACK_EVENTS_BASE, slackRoutes)
  app.route('/api', apiRoutes)
  // Remote MCP connector: OAuth AS metadata + endpoints, and the MCP endpoint itself.
  app.route('/', oauthRoutes)
  app.route('/mcp', mcpRoutes)
  // Email unsubscribe links: a page on the app origin, no session needed.
  app.route('/notifications', notificationRoutes)
  // Local only: drain the notifications outbox on demand, read the mail sent.
  if (deps.config.devLogin) app.route('/dev', devRoutes)

  // Dev/tests only: the targets of FsBlobs' "presigned" PUT and GET URLs.
  const blobs = deps.blobs
  if (blobs instanceof FsBlobs) {
    const forbidden = (message: string) => ({ error: { code: 'forbidden', message } })
    app.put(`${FS_UPLOAD_ROUTE}/*`, async c => {
      const key = keyFromPath(c.req.path, FS_UPLOAD_ROUTE)
      if (key === null) return c.json(forbidden('Bad signature or checksum'), 403)
      const signed = {
        key,
        exp: c.req.query('exp'),
        sig: c.req.query('sig'),
        contentType: c.req.header('content-type') ?? '',
        cacheControl: c.req.header('cache-control') ?? '',
        checksum: c.req.header('x-amz-checksum-sha256') ?? '',
      }
      // The signature first, so no unsigned request has its body read; then at most a file's bytes.
      if (!blobs.verifiesUpload(signed)) return c.json(forbidden('Bad signature or checksum'), 403)
      const body = await bodyUpTo(c.req.raw, MAX_FILE_BYTES)
      if (!body) {
        return c.json({ error: { code: 'too_large', message: 'The file is too large' } }, 413)
      }
      if (!(await blobs.acceptUpload({ ...signed, body }))) {
        return c.json(forbidden('Bad signature or checksum'), 403)
      }
      return c.body(null, 200)
    })
    app.get(`${FS_DOWNLOAD_ROUTE}/*`, async c => {
      const key = keyFromPath(c.req.path, FS_DOWNLOAD_ROUTE)
      const body =
        key === null
          ? null
          : await blobs.serveDownload({ key, exp: c.req.query('exp'), sig: c.req.query('sig') })
      if (!body) return c.json(forbidden('Bad signature, or no such object'), 403)
      return c.body(body as Uint8Array<ArrayBuffer>, 200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'private, no-store',
      })
    })
  }

  return app
}

export type App = ReturnType<typeof createApp>
