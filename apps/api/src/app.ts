/** Builds the Hono app from injected deps — no AWS here, so tests run on memory/fs fakes. */
import { Hono } from 'hono'
import { FsBlobs } from './blobs/fs.ts'
import { errorHandler, notFoundHandler, originVerify, securityHeaders } from './middleware.ts'
import { apiRoutes } from './routes/api.ts'
import { authRoutes } from './routes/auth.ts'
import { mcpRoutes } from './routes/mcp.ts'
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
  app.route('/auth', authRoutes)
  app.route('/api', apiRoutes)
  // Remote MCP connector: OAuth AS metadata + endpoints, and the MCP endpoint itself.
  app.route('/', oauthRoutes)
  app.route('/mcp', mcpRoutes)

  // Dev/tests only: the target of FsBlobs' "presigned" PUT URLs.
  const blobs = deps.blobs
  if (blobs instanceof FsBlobs) {
    app.put('/dev-upload/*', async c => {
      const key = decodeURIComponent(c.req.path.slice('/dev-upload/'.length))
      const ok = await blobs.acceptUpload({
        key,
        exp: c.req.query('exp'),
        sig: c.req.query('sig'),
        contentType: c.req.header('content-type') ?? '',
        cacheControl: c.req.header('cache-control') ?? '',
        checksum: c.req.header('x-amz-checksum-sha256') ?? '',
        body: new Uint8Array(await c.req.arrayBuffer()),
      })
      if (!ok) {
        return c.json({ error: { code: 'forbidden', message: 'Bad signature or checksum' } }, 403)
      }
      return c.body(null, 200)
    })
  }

  return app
}

export type App = ReturnType<typeof createApp>
