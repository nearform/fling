/**
 * `fling dev` (and the local MCP's fling_dev): a folder served the way the sites host serves it,
 * with its site server running beside it, rebuilt when a file changes.
 *
 * Nothing here decides anything a site does: each request goes through the sites' own routing
 * decision (`routeSiteRequest`, packages/shared site-routing.ts) for a public site whose version is
 * the folder, so trailing slashes, dotfiles, `/_fling/`, the GET/HEAD rule, `/api/*` and the
 * cross-origin rule are exactly the edge's. A rewrite is served from the files a deploy would
 * publish (build inputs and what is never flung left out); a missing one gets a 404 page. An invoke
 * goes through the core's shell (`runInvoke`: the request as the server gets it, the Cache-Control
 * rule, the request line) to the core's local runtime (`NodeSiteServers`: a child process behind
 * the core's Node entry, with only the declared secrets in its environment).
 *
 * The viewer: none (a public site's), or with `as` a signed-in one, `{ id, email, guest }`, its
 * viewer id made as the edge makes one. Secrets come from `.env` and `.env.local` (dotenv.ts),
 * only those `fling.json` declares. The server is bundled with deploy's settings
 * (server-build.ts); a bundle that fails to build keeps the last one running.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ServerLimits } from '@fling/api/config'
import { serverVersion } from '@fling/api/servers'
import { NodeSiteServers } from '@fling/api/servers/node'
import { runInvoke } from '@fling/api/servers/shell'
import type { ServerLogLine, ServerLogs, ServerSite } from '@fling/api/servers/types'
import {
  NOT_FOUND_PAGE,
  ROBOTS_TXT,
  SERVER_BUNDLE,
  SERVER_PROBE_DEFAULT_PATH,
  SERVER_PROBE_TIMEOUT_MS,
  type SiteViewer,
} from '@fling/shared'
import { normalizeQuery, routeSiteRequest, viewerIdOf } from '@fling/shared/site-routing'
import { localSecrets } from './dotenv.ts'
import { CliError } from './errors.ts'
import { buildManifest, contentTypeFor } from './manifest.ts'
import { bundleServer, findServer, isBuildInput, type ServerSource } from './server-build.ts'

/** The port `fling dev` asks for first. */
export const DEV_PORT = 47180

/** The limits a server runs with locally: the instance defaults (config.ts). */
const DEV_LIMITS: ServerLimits = {
  timeoutSeconds: 30,
  cpuMs: 1000,
  rps: 100,
  environments: 2,
  bodyBytes: 10 * 1024 * 1024,
}

const NOT_FOUND_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title>' +
  '<body style="font:1rem/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh">' +
  '<main><h1>Not found</h1><p>This site has no page here.</p></main>'

export interface DevServerOptions {
  dir: string
  /** a port to listen on; taken, the start fails. Omitted: DEV_PORT, else any free one */
  port?: number
  /** the viewer's email: requests arrive as this signed-in viewer */
  as?: string
  /** with `as`: a guest (invited from outside as a reviewer) */
  guest?: boolean
  /** serve index.html for unknown paths, as a single-page app */
  spa?: boolean
  /** rebuild on save (default true) */
  watch?: boolean
  /** every line the server prints and every request line, as it comes */
  onLog?: (line: ServerLogLine) => void
  /** what the dev server has to say (a rebuild, a build failure, a missing secret) */
  onNote?: (note: { level: 'info' | 'warn' | 'error'; text: string }) => void
}

export interface DevStatus {
  url: string
  dir: string
  /** the server's entry, `_fling/server.mjs` as it is, or null: static files only */
  server: string | null
  secrets: { name: string; from: string }[]
  /** declared secrets in neither .env file */
  missing: string[]
  viewer: SiteViewer | null
  /** the last build: ok, or why not */
  build: { ok: true; version: string } | { ok: false; error: string } | null
  /** the start probe after the last build: what the server answered, or why it didn't */
  probe: { path: string; status?: number; error?: string; logs: string[] } | null
}

export interface DevServer {
  status(): DevStatus
  /** the last lines the server printed and requests it took (at most 200) */
  recentLogs(): ServerLogLine[]
  rebuild(): Promise<DevStatus>
  close(): Promise<void>
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}

const hmac = (key: string, data: string) =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(data).digest('base64url')

/** A Node request as a fetch Request. */
function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x)
    else if (v !== undefined) headers.set(k, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit)
}

async function send(res: ServerResponse, response: Response, head: boolean) {
  const headers: Record<string, string[]> = {}
  response.headers.forEach((value, name) => {
    headers[name] = [...(headers[name] ?? []), value]
  })
  for (const cookie of response.headers.getSetCookie()) headers['set-cookie'] = [cookie]
  res.writeHead(response.status, headers)
  if (head || !response.body) {
    await response.body?.cancel()
    res.end()
    return
  }
  for await (const chunk of response.body) res.write(chunk)
  res.end()
}

export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const dir = opts.dir
  const note = opts.onNote ?? (() => {})
  const name = basename(dir) || 'site'
  const site: ServerSite = { id: 'dev', name }
  const key = randomBytes(32).toString('base64url')
  const viewer: SiteViewer | null = opts.as
    ? {
        id: viewerIdOf(key, site.id, opts.as.toLowerCase(), hmac),
        email: opts.as.toLowerCase(),
        guest: opts.guest === true,
      }
    : null
  const recent: ServerLogLine[] = []
  const logs: ServerLogs = {
    async append(_siteId, lines) {
      for (const line of lines) {
        recent.push(line)
        opts.onLog?.(line)
      }
      if (recent.length > 200) recent.splice(0, recent.length - 200)
    },
    async read() {
      return [...recent]
    },
  }
  const bundles = new Map<string, Uint8Array>()
  const workDir = await mkdtemp(join(tmpdir(), 'fling-dev-'))
  const servers = new NodeSiteServers({
    blobs: { get: async k => bundles.get(k) ?? null },
    workDir,
    filesDir: () => dir,
    logs,
  })

  let source: ServerSource | null = null
  let files = new Set<string>()
  let generation = 0
  let live: string | null = null
  let liveKey = ''
  let status: DevStatus = {
    url: '',
    dir,
    server: null,
    secrets: [],
    missing: [],
    viewer,
    build: null,
    probe: null,
  }

  /** The files a deploy would publish, by path. */
  async function scanFiles() {
    try {
      const current = source
      const local = await buildManifest(dir, {
        exclude: current ? (p, isDir) => isBuildInput(current, p, isDir) : undefined,
      })
      files = new Set(local.files.map(f => f.path))
    } catch (error) {
      note({ level: 'error', text: (error as Error).message })
    }
  }

  async function build(): Promise<void> {
    try {
      source = await findServer(dir)
    } catch (error) {
      status = { ...status, build: { ok: false, error: (error as Error).message } }
      note({ level: 'error', text: (error as Error).message })
      return
    }
    await scanFiles()
    if (!source) {
      if (live) await servers.retire(site)
      live = null
      status = { ...status, server: null, secrets: [], missing: [], build: null, probe: null }
      return
    }
    const declared = source.config.secrets
    const env = await localSecrets(dir, declared)
    const secrets = declared
      .filter(n => env.values[n] !== undefined)
      .map(n => ({ name: n, from: env.from[n] as string }))
    status = {
      ...status,
      server: source.entry ?? SERVER_BUNDLE,
      secrets,
      missing: env.missing,
    }
    let bytes: Uint8Array
    try {
      bytes = source.entry
        ? (await bundleServer(dir, source.entry)).bytes
        : new Uint8Array(await readFile(join(dir, SERVER_BUNDLE)))
    } catch (error) {
      const text = (error as Error).message
      status = { ...status, build: { ok: false, error: text } }
      note({ level: 'error', text: live ? `${text}\n(the last build keeps running)` : text })
      return
    }
    // The same bundle with the same secrets runs as it is.
    const runKey = createHash('sha256')
      .update(bytes)
      .update(JSON.stringify(env.values))
      .digest('hex')
    if (runKey === liveKey && live) return
    const v = `dev-${++generation}`
    const version = serverVersion(site.id, v)
    bundles.set(version.bundle, bytes)
    const previous = live
    await servers.activate(site, version, {
      secrets: env.values,
      egress: 'open',
      limits: DEV_LIMITS,
    })
    const path = source.config.health ?? SERVER_PROBE_DEFAULT_PATH
    const probe = await servers.probe(site, version, {
      method: 'GET',
      path,
      timeoutMs: SERVER_PROBE_TIMEOUT_MS,
    })
    live = v
    liveKey = runKey
    if (previous) {
      await servers.retire(site, serverVersion(site.id, previous))
      bundles.delete(serverVersion(site.id, previous).bundle)
    }
    status = {
      ...status,
      build: { ok: true, version: v },
      probe: probe.ok
        ? { path, status: probe.status, logs: probe.logs }
        : { path, error: probe.error, logs: probe.logs },
    }
    if (!probe.ok) {
      note({
        level: 'error',
        text: `The server didn't start (${probe.error})${probe.logs.length ? `:\n${probe.logs.join('\n')}` : ''}`,
      })
    } else if (source.config.health && (probe.status < 200 || probe.status > 299)) {
      note({ level: 'warn', text: `GET ${path} answered ${probe.status}: a deploy needs 2xx` })
    } else if (generation > 1) note({ level: 'info', text: `rebuilt ${status.server}` })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host ?? `localhost:${port}`
    const origin = `http://${host}`
    const url = new URL(req.url ?? '/', origin)
    const route = {
      id: site.id,
      v: live ?? 'static',
      vis: 'public',
      ...(live ? { f: 1 } : {}),
      ...(opts.spa ? { spa: true } : {}),
    }
    const header = (n: string) => {
      const v = req.headers[n]
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
    }
    const decision = await routeSiteRequest(
      {
        method: req.method ?? 'GET',
        host,
        uri: url.pathname,
        query: normalizeQuery(url.search),
        cookie: null,
        pass: null,
        fetchSite: header('sec-fetch-site'),
        origin: header('origin'),
      },
      {
        appOrigin: origin,
        siteScheme: 'http',
        nowSeconds: Math.floor(Date.now() / 1000),
        getRoute: async (k: string) => (k.startsWith('site:') ? JSON.stringify(route) : null),
        getCookieKey: async () => key,
        getRevocation: async () => null,
        hmac,
      }
    )
    const head = req.method === 'HEAD'
    if (decision.action === 'invoke') {
      const response = await runInvoke(
        { servers, serverLogs: logs, clock: { now: () => new Date() } },
        toRequest(req, origin),
        { site, v: decision.v, private: viewer !== null, viewer }
      )
      return send(res, response, head)
    }
    if (decision.action === 'respond') {
      return send(
        res,
        new Response(decision.body ?? null, {
          status: decision.status,
          headers: decision.headers,
        }),
        head
      )
    }
    const extra = decision.headers
    const prefix = `/sites/${site.id}/${route.v}/`
    if (decision.uri === ROBOTS_TXT) {
      return send(res, new Response('User-agent: *\nDisallow: /\n', { headers: extra }), head)
    }
    let path: string | null = null
    if (decision.uri.startsWith(prefix)) {
      try {
        path = decodeURIComponent(decision.uri.slice(prefix.length))
      } catch {
        path = null
      }
    }
    if (path !== null && files.has(path)) {
      const body = await readFile(join(dir, path)).catch(() => null)
      if (body) {
        return send(
          res,
          new Response(body, {
            headers: {
              ...extra,
              'content-type': contentTypeFor(path),
              'cache-control': 'no-cache',
            },
          }),
          head
        )
      }
    }
    return send(
      res,
      new Response(NOT_FOUND_HTML, {
        status: decision.uri === NOT_FOUND_PAGE ? 200 : 404,
        headers: {
          ...extra,
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
      head
    )
  }

  const http = createServer((req, res) => {
    handle(req, res).catch(error => {
      note({ level: 'error', text: String(error) })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  let port: number
  try {
    port =
      opts.port !== undefined
        ? await listen(http, opts.port)
        : await listen(http, DEV_PORT).catch(() => listen(http, 0))
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw new CliError(`Port ${opts.port} is taken: ${(error as Error).message}`, {
      hint: 'Pick another with --port, or leave it out for a free one.',
    })
  }
  status.url = `http://localhost:${port}`
  await build()

  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let building: Promise<void> = Promise.resolve()
  if (opts.watch !== false) {
    watcher = watch(dir, { recursive: true }, (_event, file) => {
      const changed = String(file ?? '')
      if (/(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(changed)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        building = building.then(build)
      }, 150)
    })
  }

  return {
    status: () => status,
    recentLogs: () => [...recent],
    async rebuild() {
      building = building.then(build)
      await building
      return status
    },
    async close() {
      if (timer) clearTimeout(timer)
      watcher?.close()
      const closed = new Promise<void>(r => http.close(() => r()))
      http.closeAllConnections()
      await closed
      await servers.close()
      await rm(workDir, { recursive: true, force: true })
    },
  }
}
