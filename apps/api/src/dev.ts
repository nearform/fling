/**
 * Local dev: the API on :47101 (Records on a table kept in `<root>/table.json`, the routes in that
 * table too, fs blobs, all under `.fling-dev/` or FS_ROOT, so restarts keep users, sites, API keys
 * and, with the session secrets in `<root>/dev-secrets.json`, sign-ins; delete the folder to start
 * afresh; pending data migrations run first, as a deploy runs them) and the sites on :47102 —
 * `http://<label>.fling.lvh.me:47102/…` runs the real CloudFront Function (edge/build.mjs, via the
 * @fling/edge harness) against the same route table, then
 * serves the rewritten object from the blobs. Missing objects get apps/web/dist-404/404.html with
 * a 404 (its `__APP_ORIGIN__` filled in, as the deploy does), and /_fling/review.html is
 * apps/web/dist-review/review-shell.html, filled in the same way; /_fling/robots.txt (every sites
 * host's /robots.txt) is apps/web/sites-robots.txt, as the deploy uploads it. Live rooms run in this process
 * (MemoryLiveHub): the API server also accepts `GET /api/live?ticket=` WebSocket upgrades, and
 * LIVE_URL points straight at it (the UI dev server needn't proxy sockets). With a mail driver
 * (MAIL_DRIVER=file, MAIL_FROM), the notifications outbox drains every minute, as the platforms'
 * ticks drain it, and `POST /dev/notify/drain` drains it at once. Site servers (SERVERS, on here
 * for members unless set) run as Node child processes (servers/node/runtime.ts): an invoke from
 * the edge harness goes to the version's server through the core's shell (servers/shell.ts), and
 * their logs are kept in memory. A view a page's beacon reports (SITE_SEEN_PATH, an invoke with no
 * server) is counted in deps.views and written as the API's route writes it (views.ts). The e2e
 * (packages/e2e) runs it as the AWS-flavoured local runtime.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSiteRouter, isInvoke, isResponse, toCloudFrontEvent } from '@fling/edge'
import {
  MISSING_KEY,
  parseServerSiteHeader,
  parseViewerHeader,
  REVIEW_SHELL_PATH,
  ROBOTS_TXT,
  SERVER_SITE_HEADER,
  SITE_HMAC_KVS_KEY,
  SITE_SEEN_PATH,
  VIEWER_HEADER,
} from '@fling/shared'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { FsBlobs } from './blobs/fs.ts'
import { type Config, loadBaseConfig, secretsFromEnv } from './config.ts'
import { buildDeps } from './deps.ts'
import { contentTypeFor } from './lib/mime.ts'
import { MemoryLiveHub } from './live-memory.ts'
import { acceptLiveSockets } from './live-ws.ts'
import { MIGRATIONS, runMigrations } from './migrations/index.ts'
import { drain } from './notifications/drain.ts'
import { TableRouteTable } from './route-table/table.ts'
import { MemoryServerLogs } from './servers/memory-logs.ts'
import { restartOptions } from './servers/node/restart.ts'
import { NodeSiteServers } from './servers/node/runtime.ts'
import { runInvoke } from './servers/shell.ts'
import { seenAnswer } from './sites-host.ts'
import { Records } from './store/records.ts'
import { FileTable } from './table/file.ts'
import type { Deps } from './types.ts'

const API_PORT = Number(process.env.PORT ?? 47101)
const SITES_PORT = Number(process.env.SITES_PORT ?? 47102)
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fsRoot = resolve(repoRoot, process.env.FS_ROOT ?? '.fling-dev')
const notFoundPage = resolve(repoRoot, 'apps/web/dist-404/404.html')
const reviewShell = resolve(repoRoot, 'apps/web/dist-review/review-shell.html')
const robotsTxt = resolve(repoRoot, 'apps/web/sites-robots.txt')

/** The dev secrets, made once per root and kept, so sessions and site passes survive a restart. */
const devSecrets = ((): { session: string; siteHmac: string; siteSecrets: string } => {
  const file = resolve(fsRoot, 'dev-secrets.json')
  let kept: { session?: string; siteHmac?: string; siteSecrets?: string } = {}
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const made = {
    session: kept.session ?? randomBytes(32).toString('base64url'),
    siteHmac: kept.siteHmac ?? randomBytes(32).toString('base64url'),
    siteSecrets: kept.siteSecrets ?? randomBytes(32).toString('hex'),
  }
  if (JSON.stringify(made) !== JSON.stringify(kept)) {
    mkdirSync(fsRoot, { recursive: true })
    writeFileSync(file, JSON.stringify(made), { mode: 0o600 })
  }
  return made
})()
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
  // Site servers run here as Node child processes (NodeSiteServers); SERVERS=off turns them off.
  SERVERS: 'members',
  ...process.env,
  SESSION_SECRET: process.env.SESSION_SECRET ?? devSecrets.session,
  SITE_HMAC_KEY: process.env.SITE_HMAC_KEY ?? devSecrets.siteHmac,
  SITE_SECRETS_KEY: process.env.SITE_SECRETS_KEY ?? devSecrets.siteSecrets,
}

const base = loadBaseConfig(env)
const config: Config = { ...base, secrets: secretsFromEnv(env) }
const table = new FileTable(resolve(fsRoot, 'table.json'))
const routeTable = new TableRouteTable(table)
const migrated = await runMigrations(table, { migrations: MIGRATIONS })
console.log(
  `fling migrations: ${migrated.migrations.map(m => `${m.id} ${m.status}`).join(', ') || 'none'}`
)
const live = new MemoryLiveHub()
const store = new Records(table)
const blobs = new FsBlobs(fsRoot, `http://localhost:${API_PORT}`, config.secrets.sessionSecret)
const serverLogs = new MemoryServerLogs()
// A server started again after a restart runs with its version's options as the core makes them.
let deps: Deps | undefined
const servers = new NodeSiteServers({
  blobs,
  workDir: resolve(fsRoot, 'servers'),
  filesDir: version => resolve(fsRoot, version.files),
  logs: serverLogs,
  optionsFor: restartOptions(() => deps as Deps),
})
deps = buildDeps(config, {
  live,
  fsRoot,
  apiBaseUrl: `http://localhost:${API_PORT}`,
  routeTable,
  store,
  blobs,
  serverLogs,
  ...(config.servers.publish.kind === 'off' ? {} : { servers }),
})
process.on('exit', () => void servers.close())
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void servers.close()
    process.exit(0)
  })
}
await routeTable.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)

// The notifications outbox's tick, every minute as on the platforms (with a mail driver set).
if (deps.mailer) {
  setInterval(() => {
    drain(deps).catch(err => console.error('notify drain failed', err))
  }, 60_000)
}

const apiServer = serve({ fetch: createApp(deps).fetch, port: API_PORT }, info =>
  console.log(`fling api   http://localhost:${info.port}  (app origin ${config.appOrigin})`)
)

// Live rooms: a ticket admits the socket, then MemoryLiveHub keeps it in its room.
acceptLiveSockets(apiServer as Server, {
  hub: live,
  secret: config.secrets.sessionSecret,
  live: config.live,
  now: () => deps.clock.now(),
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
    headers: c.req.header(),
  })
  const result = await router(event)
  const header = (name: string) => (isInvoke(result) && result.headers?.[name]?.value) || null
  if (isInvoke(result) && url.pathname === SITE_SEEN_PATH) {
    // A view the beacon reported, sent here (as AWS sends it to the API's SITE_SEEN_PATH route).
    const site = parseServerSiteHeader(header(SERVER_SITE_HEADER))
    if (site && deps.views && c.req.method === 'POST') {
      deps.views.count(site.siteId)
      await deps.views.flushDue()
    }
    return seenAnswer()
  }
  if (isInvoke(result) && deps.servers) {
    const site = parseServerSiteHeader(header(SERVER_SITE_HEADER))
    if (site) {
      const request = new Request(c.req.raw, { headers: c.req.raw.headers })
      return runInvoke({ ...deps, servers: deps.servers }, request, {
        site: { id: site.siteId, name: (c.req.header('host') ?? url.host).split('.')[0] ?? '' },
        v: site.v,
        private: site.private,
        viewer: parseViewerHeader(header(VIEWER_HEADER)),
      })
    }
  }
  if (isResponse(result)) {
    const headers = new Headers()
    for (const [name, v] of Object.entries(result.headers ?? {})) headers.set(name, v.value)
    for (const [name, v] of Object.entries(result.cookies ?? {})) {
      headers.append('set-cookie', `${name}=${v.value}${v.attributes ? `; ${v.attributes}` : ''}`)
    }
    return new Response(result.body?.data ?? null, { status: result.statusCode, headers })
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
  if (result.uri === ROBOTS_TXT) {
    return new Response(await readFile(robotsTxt), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
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
