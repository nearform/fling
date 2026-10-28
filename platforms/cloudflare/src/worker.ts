/**
 * The Cloudflare Worker: all of a Fling instance in one Worker.
 *
 * - The app origin (APP_ORIGIN's host): the API core (Hono: /api, /auth, /mcp, /oauth,
 *   /.well-known, /healthz), the signed upload route R2Blobs presigns (`PUT /blob-upload/<key>`),
 *   and the web UI from Static Assets (index.html for client-side routes; hashed files immutable).
 * - The live rooms (src/live.ts): `GET /api/live?ticket=` WebSocket upgrades on the app origin go
 *   to the site's `LiveRoom` Durable Object, exported from here for the LIVE_ROOMS binding.
 * - The sites host (`*.<SITES_DOMAIN>`): the shared routing decision over the route table and R2
 *   (sites.ts).
 * - `scheduled` (the crons in wrangler.jsonc): every minute (`* * * * *`) drains the
 *   notifications outbox (@fling/api/notifications); hourly, deletes expired items from D1. Reads
 *   already ignore them; that reclaims the space.
 *
 * Data migrations are not run here: scripts/migrate.ts runs them from the deploy, through a
 * remote binding to the same D1 database, so the Worker has no admin surface (DEPLOY.md).
 *
 * Config is the env: vars for the instance's values, secrets for SESSION_SECRET, SITE_HMAC_KEY
 * and OIDC_CLIENT_SECRET, read by the same @fling/api/config every platform uses. Deps are built
 * once per isolate.
 */
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'
import { createApp } from '@fling/api/app'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { drain, errorName, logNotify } from '@fling/api/notifications'
import type { Deps } from '@fling/api/types'
import { R2Blobs, UPLOAD_ROUTE } from './blobs/r2.ts'
import { buildCloudflareDeps, CLOUDFLARE_DRIVERS } from './deps.ts'
import { type Env, stringVars } from './env.ts'
import { handleLiveUpgrade, LIVE_PATH } from './live.ts'
import { handleSiteRequest } from './sites.ts'
import { D1Table } from './table/d1.ts'

export { LiveRoom } from './live.ts'

/**
 * The app paths the API answers (the rest is the web UI): the AWS module's `api_paths`, plus
 * `/dev/`, which the API mounts only with the dev login on (`wrangler dev`).
 */
export function isApiPath(path: string): boolean {
  return (
    path === '/healthz' ||
    path === '/mcp' ||
    ['/api/', '/auth/', '/mcp/', '/oauth/', '/.well-known/', '/notifications/', '/dev/'].some(p =>
      path.startsWith(p)
    )
  )
}

/** The every-minute cron: the notifications outbox's tick. Any other cron purges expired items. */
const NOTIFY_CRON = '* * * * *'

/** The headers CloudFront's managed SecurityHeadersPolicy adds to the UI on AWS. */
const UI_SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-xss-protection': '1; mode=block',
}

/** The web UI from Static Assets, with the cache headers deploy.yml gives it on AWS. */
async function serveUi(request: Request, env: Env, https: boolean): Promise<Response> {
  const res = await env.ASSETS.fetch(request as never)
  const path = new URL(request.url).pathname
  // A Worker deployed without the extension would answer with index.html (the SPA's fallback).
  if (
    path === '/downloads/fling.mcpb' &&
    (res.headers.get('content-type') ?? '').startsWith('text/html')
  ) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-cache' } })
  }
  const out = new Response(res.body as never, res as never)
  if (res.ok) {
    if ((out.headers.get('content-type') ?? '').startsWith('text/html')) {
      out.headers.set('cache-control', 'no-cache') // index.html (every client-side route)
    } else if (path.startsWith('/assets/')) {
      out.headers.set('cache-control', 'public, max-age=31536000, immutable') // content-hashed
    } else {
      out.headers.set('cache-control', 'public, max-age=300')
    }
    if (path === '/downloads/fling.mcpb') {
      out.headers.set('content-type', 'application/octet-stream')
      out.headers.set('content-disposition', 'attachment; filename="fling.mcpb"')
    }
  }
  for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) {
    if (https || name !== 'strict-transport-security') out.headers.set(name, value)
  }
  return out
}

interface Instance {
  config: Config
  deps: Deps
  app: ReturnType<typeof createApp>
  appHost: string
}

let instance: Instance | undefined

function init(env: Env): Instance {
  const vars = { ...CLOUDFLARE_DRIVERS, ...stringVars(env) }
  const config: Config = { ...loadBaseConfig(vars), secrets: secretsFromEnv(vars) }
  const deps = buildCloudflareDeps(config, env)
  return { config, deps, app: createApp(deps), appHost: new URL(config.appOrigin).host }
}

/** The request's host (port included): in Workers the URL's host is the Host header's. */
function hostOf(request: Request) {
  return new URL(request.url).host.toLowerCase()
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    instance ??= init(env)
    const { config, deps, app, appHost } = instance
    const host = hostOf(request)

    if (host === appHost) {
      const path = new URL(request.url).pathname
      if (path.startsWith(`${UPLOAD_ROUTE}/`) && deps.blobs instanceof R2Blobs) {
        return deps.blobs.handleUpload(request)
      }
      if (path === LIVE_PATH && config.live) {
        return handleLiveUpgrade(
          request,
          env.LIVE_ROOMS,
          config.secrets.sessionSecret,
          deps.clock.now()
        )
      }
      if (isApiPath(path)) return app.fetch(request, env, ctx as never)
      return serveUi(request, env, config.secureCookies)
    }

    if (host.endsWith(`.${config.sitesDomain}`)) {
      return handleSiteRequest(request, {
        appOrigin: config.appOrigin,
        siteScheme: config.siteScheme,
        cookieKey: config.secrets.siteHmacKey,
        routeTable: deps.routeTable,
        bucket: env.BUCKET,
        assets: env.ASSETS,
      })
    }

    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === NOTIFY_CRON) {
      instance ??= init(env)
      const { deps } = instance
      ctx.waitUntil(
        drain(deps)
          .then(result => {
            console.log(JSON.stringify({ level: 'info', msg: 'notify drain', ...result }))
          })
          .catch(err => logNotify('error', 'notify drain failed', { err: errorName(err) }))
      )
      return
    }
    ctx.waitUntil(
      new D1Table(env.DB).purgeExpired().then(n => {
        console.log(JSON.stringify({ level: 'info', msg: 'purged expired items', count: n }))
      })
    )
  },
}
