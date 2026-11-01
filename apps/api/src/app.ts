/** Builds the Hono app from injected deps — no AWS here, so tests run on memory/fs fakes. */
import { INSTANCE_METADATA_MAX_AGE, INSTANCE_METADATA_PATH } from '@fling/shared'
import { Hono } from 'hono'
import { FS_DOWNLOAD_ROUTE, FS_UPLOAD_ROUTE, FsBlobs } from './blobs/fs.ts'
import { keyFromPath } from './blobs/signed-url.ts'
import { instanceMetadata } from './instance.ts'
import { errorHandler, notFoundHandler, originVerify, securityHeaders } from './middleware.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { devRoutes } from './routes/dev.ts'
import { mcpRoutes } from './routes/mcp.ts'
import { notificationRoutes } from './routes/notifications.ts'
import { oauthRoutes } from './routes/oauth.ts'
import type { AppEnv, Deps } from './types.ts'

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.notFound(notFoundHandler)
  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })
  app.use('*', securityHeaders)

  app.get('/healthz', c => c.json({ ok: true }))

  app.use('*', originVerify)
  // Public and the same for everyone: cacheable, and readable cross-origin (the sites' 404 page
  // brands itself from it).
  app.get(INSTANCE_METADATA_PATH, c => {
    c.header('Cache-Control', `public, max-age=${INSTANCE_METADATA_MAX_AGE}`)
    c.header('Access-Control-Allow-Origin', '*')
    return c.json(instanceMetadata(c.get('deps').config))
  })
  app.route('/auth', authRoutes)
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
      const ok =
        key !== null &&
        (await blobs.acceptUpload({
          key,
          exp: c.req.query('exp'),
          sig: c.req.query('sig'),
          contentType: c.req.header('content-type') ?? '',
          cacheControl: c.req.header('cache-control') ?? '',
          checksum: c.req.header('x-amz-checksum-sha256') ?? '',
          body: new Uint8Array(await c.req.arrayBuffer()),
        }))
      if (!ok) return c.json(forbidden('Bad signature or checksum'), 403)
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
