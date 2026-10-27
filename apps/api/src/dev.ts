/**
 * Local dev: the API on :47101 (Records on a memory table, fs blobs under `.fling-dev/` or
 * FS_ROOT, memory route table; pending data migrations run first, as a deploy runs them) and the
 * sites on :47102 — `http://<label>.fling.lvh.me:47102/…` runs the real CloudFront Function
 * (edge/build.mjs, via the @fling/edge harness) against the same in-memory route table, then
 * serves the rewritten object from the blobs. Missing objects get apps/web/dist-404/404.html with
 * a 404 (its `__APP_ORIGIN__` filled in, as the deploy does), and /_fling/review.html is
 * apps/web/dist-review/review-shell.html, filled in the same way. Live rooms run in this process
 * (MemoryLiveHub): the API server also accepts `GET /api/live?ticket=` WebSocket upgrades, and
 * LIVE_URL points straight at it (the UI dev server needn't proxy sockets). The e2e
 * (packages/e2e) runs it as the AWS-flavoured local runtime.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSiteRouter, isResponse, toCloudFrontEvent } from '@fling/edge'
import { MISSING_KEY, REVIEW_SHELL_PATH, SITE_HMAC_KVS_KEY } from '@fling/shared'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { createApp } from './app.ts'
import { type Config, loadBaseConfig, secretsFromEnv } from './config.ts'
import { buildDeps } from './deps.ts'
import { contentTypeFor } from './lib/mime.ts'
import { admitTicket } from './live.ts'
import { MemoryLiveHub } from './live-memory.ts'
import { MIGRATIONS, runMigrations } from './migrations/index.ts'
import { MemoryRouteTable } from './route-table/memory.ts'
import { Records } from './store/records.ts'
import { MemoryTable } from './table/memory.ts'

const API_PORT = Number(process.env.PORT ?? 47101)
const SITES_PORT = Number(process.env.SITES_PORT ?? 47102)
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fsRoot = resolve(repoRoot, process.env.FS_ROOT ?? '.fling-dev')
const notFoundPage = resolve(repoRoot, 'apps/web/dist-404/404.html')
const reviewShell = resolve(repoRoot, 'apps/web/dist-review/review-shell.html')

const devSecret = () => randomBytes(32).toString('base64url')
const appOrigin = `http://fling.lvh.me:${process.env.UI_PORT ?? 47100}`
const env = {
  APP_ENV: 'development',
  DEV_LOGIN: '1',
  // lvh.me (and every subdomain) resolves to 127.0.0.1. Browsers won't share a
  // `Domain=localhost` cookie with `*.localhost`, so private sites need a real-looking domain.
  // The UI dev server (vite, :47100 by default) proxies /api, /auth, /mcp, /oauth to this API.
  APP_ORIGIN: appOrigin,
  LIVE_URL: `ws://${new URL(process.env.APP_ORIGIN ?? appOrigin).hostname}:${API_PORT}/api/live`,
  SITES_DOMAIN: `fling.lvh.me:${SITES_PORT}`,
  SITE_SCHEME: 'http',
  SITE_COOKIE_DOMAIN: 'fling.lvh.me',
  ...process.env,
  // Fresh per process is fine: the memory store forgets every session on restart anyway.
  SESSION_SECRET: process.env.SESSION_SECRET ?? devSecret(),
  SITE_HMAC_KEY: process.env.SITE_HMAC_KEY ?? devSecret(),
}

const base = loadBaseConfig(env)
const config: Config = { ...base, secrets: secretsFromEnv(env) }
const routeTable = new MemoryRouteTable()
const table = new MemoryTable()
const migrated = await runMigrations(table, { migrations: MIGRATIONS })
console.log(
  `fling migrations: ${migrated.migrations.map(m => `${m.id} ${m.status}`).join(', ') || 'none'}`
)
const live = new MemoryLiveHub()
const deps = buildDeps(config, {
  live,
  fsRoot,
  apiBaseUrl: `http://localhost:${API_PORT}`,
  routeTable,
  store: new Records(table),
})
await routeTable.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)

const apiServer = serve({ fetch: createApp(deps).fetch, port: API_PORT }, info =>
  console.log(`fling api   http://localhost:${info.port}  (app origin ${config.appOrigin})`)
)

// Live rooms: a ticket admits the socket, then MemoryLiveHub keeps it in its room.
const sockets = new WebSocketServer({ noServer: true })
apiServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const admission =
    url.pathname === '/api/live' && config.live
      ? admitTicket(config.secrets.sessionSecret, url.searchParams.get('ticket'), deps.clock.now())
      : null
  if (!admission) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  sockets.handleUpgrade(req, socket, head, ws => {
    // Listen at once: the client says hello as soon as it is open.
    const conn = live.connect(admission, ws)
    ws.on('message', (data, binary) => {
      const raw = binary ? new Uint8Array(data as Buffer) : (data as Buffer).toString('utf8')
      conn.then(c => c.message(raw)).catch(() => {})
    })
    ws.on('close', () => {
      conn.then(c => c.close()).catch(() => {})
    })
  })
})

const router = createSiteRouter({
  kvs: routeTable,
  appOrigin: config.appOrigin,
  siteScheme: 'http',
  now: () => deps.clock.now().getTime(),
})
const sites = new Hono()

sites.all('*', async c => {
  const url = new URL(c.req.url)
  const event = toCloudFrontEvent({
    method: c.req.method,
    host: c.req.header('host') ?? url.host,
    path: url.pathname,
    query: url.search.slice(1),
    cookieHeader: c.req.header('cookie'),
  })
  const result = await router(event)
  if (isResponse(result)) {
    const headers = new Headers()
    for (const [name, v] of Object.entries(result.headers ?? {})) headers.set(name, v.value)
    for (const [name, v] of Object.entries(result.cookies ?? {})) {
      headers.append('set-cookie', `${name}=${v.value}${v.attributes ? `; ${v.attributes}` : ''}`)
    }
    return new Response(null, { status: result.statusCode, headers })
  }
  if (result.uri === REVIEW_SHELL_PATH) {
    // The review shell, filled in as the deploy does; no frame-blocking headers.
    c.header('cache-control', 'no-cache')
    try {
      const page = await readFile(reviewShell, 'utf8')
      return c.html(page.replaceAll('__APP_ORIGIN__', config.appOrigin))
    } catch {
      return c.text('Not found (build apps/web for the review shell)', 404)
    }
  }
  const file = resolve(fsRoot, `.${decodeURIComponent(result.uri)}`)
  if (result.uri !== MISSING_KEY && file.startsWith(fsRoot + sep)) {
    try {
      const body = await readFile(file)
      const type = contentTypeFor(file)
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      // fall through to the 404 page
    }
  }
  // Like the deployed 404 page: never cached, so it doesn't outlive a site that appears later.
  c.header('cache-control', 'no-store')
  try {
    const page = await readFile(notFoundPage, 'utf8')
    return c.html(page.replaceAll('__APP_ORIGIN__', config.appOrigin), 404)
  } catch {
    return c.text('Not found (build apps/web for the real 404 page)', 404)
  }
})

serve({ fetch: sites.fetch, port: SITES_PORT }, info =>
  console.log(`fling sites http://<name>.fling.lvh.me:${info.port}`)
)
