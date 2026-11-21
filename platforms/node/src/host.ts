/**
 * The Node host: all of a Fling instance in one Node HTTP server, the way the Cloudflare Worker is
 * all of one in a Worker. It routes by the request's host:
 *
 * - **The app host** (APP_ORIGIN's): the API core (createApp: /api, /auth, /mcp, /oauth,
 *   /.well-known, /healthz, and the fs store's signed routes), the host's upload and download
 *   routes for a store that can't bind uploads (`uploads`, @fling/api/blobs/host-uploads), the
 *   tick and migrate endpoints, and the web UI from its build (`uiDir`; index.html for client-side
 *   routes, with the cache and security headers of the AWS app distribution). `GET /api/live`
 *   WebSocket upgrades go to the in-process live hub (`listen`, @fling/api/live-ws), which a
 *   fan-out spreads across processes.
 * - **The sites host** (`*.<SITES_DOMAIN>`): the core's sites host (@fling/api/sites-host: the
 *   shared routing decision over the route table), with site files from the Blobs store, Fling's
 *   pages from the web build (`pages`) and site servers through the core's shell.
 *
 * Ticks and migrations are endpoints a scheduler or the deploy calls, `POST /ticks/notify` (every
 * minute, with mail), `POST /ticks/maintain` (hourly) and `POST /ticks/migrate` (the deploy, until
 * it reports `done`), behind a caller check the platform supplies (`ticks.authorize`): by default a
 * shared secret (`sharedSecretTicks`, TICK_SECRET); a cloud plugs in its scheduler's identity.
 * Without a check they answer 404.
 *
 * Every adapter is passed in (`deps`), so a cloud platform on Node supplies its own Table, Blobs and
 * mailer and keeps the rest.
 *
 * Request bodies: at most `maxBodyBytes` (default 32 MiB: a file at its limit, MAX_FILE_BYTES,
 * through the upload routes, with room to spare; Lambda takes 6 MB, Workers 100 MB). A declared
 * Content-Length over it is a 413 before anything runs; a body without one is cut off as it passes
 * the limit, and the route reading it answers 413 `too_large`; so does the host, when the read
 * that failed was a site server's (an ApiError anywhere in the error's causes).
 *
 * Hosts are matched by name, the port aside (one server listens on one port, and a client may
 * name the default one).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { createApp } from '@fling/api/app'
import { isApiPath, MCPB_PATH, uiHeaders } from '@fling/api/app-host'
import type { Blobs } from '@fling/api/blobs'
import type { HostUploads } from '@fling/api/blobs/host-uploads'
import { ApiError } from '@fling/api/errors'
import { contentTypeFor } from '@fling/api/lib/mime'
import type { MemoryLiveHub } from '@fling/api/live-memory'
import { acceptLiveSockets } from '@fling/api/live-ws'
import { MIGRATIONS, runMigrations } from '@fling/api/migrations'
import type { RouteTable } from '@fling/api/route-table'
import { handleSiteRequest, invokeSiteServer, type SitesPage } from '@fling/api/sites-host'
import type { Table } from '@fling/api/table'
import type { Deps } from '@fling/api/types'
import { cacheControlFor } from '@fling/shared'
import { NOT_FOUND_PAGE, REVIEW_SHELL, ROBOTS_TXT } from '@fling/shared/route-keys'
import { serve } from '@hono/node-server'
import { drain, maintain } from './ticks.ts'

/** Decides whether a request to a tick or migrate endpoint comes from the instance's scheduler. */
export type TickAuthorizer = (request: Request) => boolean | Promise<boolean>

/** The default check: `Authorization: Bearer <secret>` (TICK_SECRET). */
export function sharedSecretTicks(secret: string): TickAuthorizer {
  const expected = Buffer.from(`Bearer ${secret}`)
  return request => {
    const given = Buffer.from(request.headers.get('authorization') ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

export const TICK_PATHS = {
  notify: '/ticks/notify',
  maintain: '/ticks/maintain',
  migrate: '/ticks/migrate',
} as const

/** Where Fling's pages are in the web build (apps/web): the files a deploy ships to the host. */
export interface PageFiles {
  notFound: string
  reviewShell: string
  robots: string
}

export interface NodeHostOptions {
  deps: Deps
  /** the Table, for migrations (`/ticks/migrate`) and the purge of expired items */
  table: Table & { purgeExpired?: () => Promise<number> }
  /** the route table the sites host reads (default: deps.routeTable) */
  siteRoutes?: RouteTable
  /** the web UI's build (apps/web/dist); absent, the app host answers the API only */
  uiDir?: string
  /** Fling's pages on the sites hosts; absent or missing, a plain 404 */
  pages?: Partial<PageFiles>
  /** the live hub the sockets join (with live rooms on) */
  live?: MemoryLiveHub
  /** the host's upload and download routes, for a store that can't bind uploads itself */
  uploads?: HostUploads
  /** the largest request body taken, in bytes (default DEFAULT_MAX_BODY_BYTES) */
  maxBodyBytes?: number
  ticks?: {
    authorize: TickAuthorizer
    /** how long a tick or a migrate call may run before it returns (default 50 s) */
    budgetMs?: number
    /** more hourly work (the platform's own), after maintenance */
    maintain?: () => Promise<unknown>
  }
}

/** The largest request body the Node host takes by default: 32 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

const tooLarge = (max: number) =>
  new ApiError(413, 'too_large', `The request is too large (at most ${max} bytes)`)

/**
 * The request with its body held to `max` bytes, or a 413 when it says it is larger. A body
 * without a Content-Length errors as it passes `max`, with the 413 the API's error handler answers.
 */
function capped(request: Request, max: number): Request | Response {
  if (!request.body) return request
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (declared > max) {
    const err = tooLarge(max)
    return json({ error: { code: err.code, message: err.message } }, 413)
  }
  let size = 0
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength
      if (size > max) controller.error(tooLarge(max))
      else controller.enqueue(chunk)
    },
  })
  return new Request(request, {
    body: request.body.pipeThrough(limit),
    duplex: 'half',
  } as RequestInit)
}

/** The ApiError among `err` and its causes (undici wraps a body's error in a TypeError). */
function apiErrorIn(err: unknown): ApiError | null {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof ApiError) return e
    e = (e as { cause?: unknown }).cause
  }
  return null
}

/** A Host header's name, without its port. */
const hostName = (host: string) => host.toLowerCase().replace(/:\d+$/, '')

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })

/**
 * A site file from Blobs. Object keys never change content (a version's files live under its
 * id; a rendered page's name is its hash), so the key is the ETag. The type and Cache-Control are
 * those the upload set, made again from the name: a rendered Paths listing is never cached.
 */
async function blobObject(blobs: Blobs, request: Request, key: string) {
  const head = await blobs.head(key)
  if (!head) return null
  const etag = `"${createHash('sha256').update(key).digest('base64url').slice(0, 27)}"`
  const headers = new Headers({
    'content-type': contentTypeFor(key),
    'cache-control':
      key.includes('/_rendered/') && key.endsWith('.json') ? 'no-cache' : cacheControlFor(key),
    etag,
  })
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers })
  }
  headers.set('content-length', String(head.size))
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const body = await blobs.get(key)
  if (!body) return null
  return new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers })
}

/** Fling's pages, read once and filled in for this instance. */
function pageReader(files: Partial<PageFiles>, appOrigin: string) {
  const fileOf: Record<SitesPage, string | undefined> = {
    [NOT_FOUND_PAGE]: files.notFound,
    [REVIEW_SHELL]: files.reviewShell,
    [ROBOTS_TXT]: files.robots,
  }
  const cache = new Map<SitesPage, Promise<string | null>>()
  return (page: SitesPage) => {
    let text = cache.get(page)
    if (!text) {
      const file = fileOf[page]
      text = file
        ? readFile(file, 'utf8')
            .then(t => t.replaceAll('__APP_ORIGIN__', appOrigin))
            .catch(() => null)
        : Promise.resolve(null)
      cache.set(page, text)
    }
    return text
  }
}

/** The web UI from its build directory: a file, or index.html for a client-side route. */
async function serveUi(uiDir: string, request: Request, https: boolean): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()
  const path = new URL(request.url).pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return notFound()
  }
  const root = resolve(uiDir)
  const file = resolve(root, `.${decoded}`)
  const inside = file.startsWith(root + sep)
  let body: Buffer | null = null
  let name = file
  if (inside && extname(file)) body = await readFile(file).catch(() => null)
  if (!body) {
    // An asset that isn't there is a 404, never the app; the extension likewise.
    if (path.startsWith('/assets/') || path === MCPB_PATH) return notFound()
    name = resolve(root, 'index.html')
    body = await readFile(name).catch(() => null)
    if (!body) return notFound()
  }
  const headers = uiHeaders(path, contentTypeFor(name), https)
  if (!headers.has('content-type')) headers.set('content-type', contentTypeFor(name))
  return new Response(request.method === 'HEAD' ? null : (body as Uint8Array<ArrayBuffer>), {
    headers,
  })
}

export interface NodeHost {
  /** one request, whatever its host */
  fetch(request: Request): Promise<Response>
  /** serve on `port` (0: any free one), WebSocket upgrades included */
  listen(
    port: number,
    hostname?: string
  ): Promise<{ server: Server; port: number; close(): Promise<void> }>
}

export function createNodeHost(opts: NodeHostOptions): NodeHost {
  const { deps } = opts
  const { config } = deps
  const app = createApp(deps)
  const appHost = new URL(config.appOrigin).host.toLowerCase()
  const appName = hostName(appHost)
  const sitesSuffix = `.${hostName(config.sitesDomain)}`
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (!Number.isInteger(maxBody) || maxBody < 1) {
    throw new Error('maxBodyBytes (MAX_REQUEST_BYTES) must be a positive whole number of bytes')
  }
  const https = config.appOrigin.startsWith('https:')
  const page = pageReader(opts.pages ?? {}, config.appOrigin)
  const budget = () => Date.now() + (opts.ticks?.budgetMs ?? 50_000)
  const routes = opts.siteRoutes ?? deps.routeTable

  async function tick(request: Request, path: string): Promise<Response> {
    if (!opts.ticks || request.method !== 'POST') return notFound()
    if (!(await opts.ticks.authorize(request))) return notFound()
    if (path === TICK_PATHS.notify) return json((await drain(deps, budget())) ?? { mail: false })
    if (path === TICK_PATHS.maintain) {
      const result = await maintain(deps, opts.table, budget())
      await opts.ticks.maintain?.()
      return json(result)
    }
    const url = new URL(request.url)
    const only = url.searchParams.getAll('only')
    return json(
      await runMigrations(opts.table, {
        migrations: MIGRATIONS,
        ...(only.length ? { only } : {}),
        dryRun: url.searchParams.get('dryRun') === 'true',
        deadline: budget(),
      })
    )
  }

  async function fetch(incoming: Request): Promise<Response> {
    try {
      return await route(incoming)
    } catch (err) {
      const known = apiErrorIn(err)
      if (!known) throw err
      return json({ error: { code: known.code, message: known.message } }, known.status)
    }
  }

  async function route(incoming: Request): Promise<Response> {
    const request = capped(incoming, maxBody)
    if (request instanceof Response) return request
    const url = new URL(request.url)
    const host = hostName(request.headers.get('host') ?? url.host)
    if (host === appName) {
      const path = url.pathname
      if (path.startsWith('/ticks/')) {
        return Object.values(TICK_PATHS).includes(path as never) ? tick(request, path) : notFound()
      }
      if (opts.uploads?.owns(path)) return opts.uploads.handle(request)
      if (isApiPath(path) || !opts.uiDir) return app.fetch(request)
      // The fs store's signed routes are the API's too.
      if (path.startsWith('/dev-upload/') || path.startsWith('/dev-download/')) {
        return app.fetch(request)
      }
      return serveUi(opts.uiDir, request, https)
    }
    if (host.endsWith(sitesSuffix)) {
      const servers = deps.servers
      return handleSiteRequest(request, {
        appOrigin: config.appOrigin,
        siteScheme: config.siteScheme,
        cookieKey: config.secrets.siteHmacKey,
        routes,
        page,
        object: (req, key) => blobObject(deps.blobs, req, key),
        ...(servers
          ? {
              invoke: (req, decision) =>
                invokeSiteServer(
                  { servers, serverLogs: deps.serverLogs, clock: deps.clock },
                  req,
                  decision
                ),
            }
          : {}),
        now: () => deps.clock.now().getTime(),
      })
    }
    return notFound()
  }

  return {
    fetch,
    listen(port, hostname) {
      return new Promise(resolveListen => {
        const server = serve({ fetch, port, ...(hostname ? { hostname } : {}) }, info => {
          const closeSockets = opts.live
            ? acceptLiveSockets(server as Server, {
                hub: opts.live,
                secret: config.secrets.sessionSecret,
                live: config.live,
                now: () => deps.clock.now(),
                host: appHost,
              })
            : () => {}
          resolveListen({
            server: server as Server,
            port: info.port,
            close: () =>
              new Promise<void>(done => {
                closeSockets()
                server.close(() => done())
              }),
          })
        }) as unknown as Server
      })
    },
  }
}
