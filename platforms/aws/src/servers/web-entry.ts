/**
 * The entry of a site server's Lambda Web Function: `index.mjs` at the root of the revision's zip
 * (AWS_LAMBDA_NODEJS_ENTRYPOINT), bundled by scripts/server-entry.mjs with the core's entry.mjs and
 * helper.mjs beside it. CloudFront sends an invoke straight to the Web Function, so the shell the
 * other platforms run in their sites host (servers/shell.ts `runInvoke`) runs here instead, around
 * the author's server:
 *
 *   - it listens where Lambda sends requests (AWS_LAMBDA_HTTP_ENDPOINT) at once, then loads the
 *     bundle through entry.mjs on a loopback PORT of its own: a fetch handler is served there by
 *     entry.mjs, a Node server listens there itself; either way requests are passed on to it;
 *   - the author's process sees only its declared secrets, PORT, HOST and FLING_*: the rest of the
 *     environment (the execution role's credentials among it) is removed before the bundle loads;
 *   - each response goes out with serverCacheControl's Cache-Control, private unless
 *     SERVER_SITE_HEADER says the site is public;
 *   - a server's 403 or 404 goes out as SERVER_STAND_IN_STATUS with SERVER_STATUS_HEADER naming
 *     it (@fling/shared/route-keys), which the /api/* behaviour's viewer-response function puts
 *     back, so the sites distribution's error page never takes its place; the request line has
 *     the real status. A server can't set SERVER_STATUS_HEADER itself;
 *   - the wall time (FLING_TIMEOUT_SECONDS, streams included: 504 before the headers, the stream
 *     cut after) and the request body (FLING_BODY_BYTES: 413) are enforced here, to the second and
 *     the byte, whatever Lambda's own timeout steps are;
 *   - every request gets Fling's request line, printed to stdout as one JSON line
 *     (entry-contract.ts `requestLogText`), which CloudWatch keeps beside the server's output and
 *     server-logs.ts reads back. `ms` is the time to the response headers, as the core's shell
 *     measures it;
 *   - when the bundle threw while loading, or nothing listens on PORT within START_WAIT_MS, it
 *     answers 502 with SERVER_ERROR_HEADER, which the start probe counts as no answer.
 */
import {
  createServer,
  request as forward,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { createConnection, createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CLI_PACKAGE } from '@fling/shared/distribution'
import {
  isStoodInStatus,
  SERVER_SITE_HEADER,
  SERVER_STAND_IN_STATUS,
  SERVER_STATUS_HEADER,
  VIEWER_HEADER,
} from '@fling/shared/route-keys'
import {
  parseServerSiteHeader,
  parseViewerHeader,
  SERVER_HELPER_SUFFIX,
  serverCacheControl,
} from '@fling/shared/site-server'
import {
  ENTRY_BUNDLE,
  ENTRY_ENV,
  ENTRY_FILES_DIR,
  requestLogText,
  SERVER_ERROR_HEADER,
} from './entry-contract.ts'

/** How long a server has to listen on PORT after it starts: Lambda's own start window. */
const START_WAIT_MS = 10_000
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const [publicHost, publicPort] = hostPort(env.AWS_LAMBDA_HTTP_ENDPOINT ?? '0.0.0.0:3000')
const versionId = env[ENTRY_ENV.version] ?? ''
const timeoutMs = Number(env[ENTRY_ENV.timeoutSeconds] ?? 30) * 1000
const bodyBytes = Number(env[ENTRY_ENV.bodyBytes] ?? 10 * 1024 * 1024)
const secretNames = (env[ENTRY_ENV.secretNames] ?? '').split(',').filter(Boolean)

function hostPort(value: string): [string, number] {
  const i = value.lastIndexOf(':')
  return [value.slice(0, i) || '0.0.0.0', Number(value.slice(i + 1))]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A free loopback port for the author's server. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => res(port))
    })
  })
}

const connects = (port: number) =>
  new Promise<boolean>(res => {
    const c = createConnection({ port, host: '127.0.0.1' })
    c.once('connect', () => {
      c.destroy()
      res(true)
    })
    c.once('error', () => res(false))
  })

let innerPort = 0
let failed: string | null = null
let listening = false
const started = Date.now()

/** null once the author's server listens; else why it doesn't. */
async function ready(): Promise<string | null> {
  while (!listening) {
    if (failed) return failed
    if (Date.now() - started > START_WAIT_MS) {
      return `not listening on PORT within ${START_WAIT_MS / 1000} s`
    }
    if (innerPort && (await connects(innerPort))) listening = true
    else await sleep(25)
  }
  return null
}

function errorAnswer(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  marker?: string
) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    ...(marker ? { [SERVER_ERROR_HEADER]: marker } : {}),
  })
  res.end(JSON.stringify({ error: { code, message } }))
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function outgoingHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...req.headers }
  for (const h of HOP_BY_HOP) delete headers[h]
  headers['x-forwarded-host'] ??= req.headers.host
  headers['x-forwarded-proto'] ??= 'https'
  return headers
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const begun = performance.now()
  const site = parseServerSiteHeader(first(req.headers[SERVER_SITE_HEADER]))
  const viewer = parseViewerHeader(first(req.headers[VIEWER_HEADER]))
  const path = new URL(req.url ?? '/', 'http://x').pathname
  let logged = false
  const log = (status: number) => {
    if (logged) return
    logged = true
    console.log(
      requestLogText({
        at: new Date().toISOString(),
        versionId,
        kind: 'request',
        method: req.method ?? 'GET',
        path,
        status,
        ms: Math.round(performance.now() - begun),
        viewer: viewer?.id ?? null,
      })
    )
  }
  res.on('close', () => log(res.statusCode))

  const timer = setTimeout(() => {
    errorAnswer(res, 504, 'server_timeout', `No answer within ${timeoutMs / 1000} s`)
    upstream?.destroy()
  }, timeoutMs)
  res.on('close', () => clearTimeout(timer))
  let upstream: ReturnType<typeof forward> | undefined

  if (Number(req.headers['content-length'] ?? 0) > bodyBytes) {
    errorAnswer(res, 413, 'too_large', 'Request body too large')
    return
  }
  const notReady = await ready()
  if (notReady) {
    errorAnswer(
      res,
      502,
      'server_failed',
      `The site's server isn't running (${notReady})`,
      failed ? 'crashed' : 'not-listening'
    )
    return
  }
  upstream = forward(
    {
      host: '127.0.0.1',
      port: innerPort,
      method: req.method,
      path: req.url,
      headers: outgoingHeaders(req),
    },
    answer => {
      const headers: OutgoingHttpHeaders = { ...answer.headers }
      for (const h of HOP_BY_HOP) delete headers[h]
      headers['cache-control'] = serverCacheControl(
        first(answer.headers['cache-control']),
        site?.private ?? true
      )
      const status = answer.statusCode ?? 502
      delete headers[SERVER_STATUS_HEADER]
      if (isStoodInStatus(status)) {
        headers[SERVER_STATUS_HEADER] = String(status)
        res.writeHead(SERVER_STAND_IN_STATUS, headers)
      } else {
        res.writeHead(status, answer.statusMessage, headers)
      }
      log(status)
      answer.pipe(res)
      answer.on('error', () => res.destroy())
    }
  )
  upstream.on('error', () => errorAnswer(res, 502, 'server_failed', "The site's server failed"))
  let received = 0
  req.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > bodyBytes) {
      upstream?.destroy()
      errorAnswer(res, 413, 'too_large', 'Request body too large')
    }
  })
  req.pipe(upstream)
}

/** Only what the author's server may see: its secrets, PORT, HOST and Fling's own values. */
function scrubEnvironment(port: number) {
  const keep = new Set([...secretNames, ...Object.values(ENTRY_ENV), 'PATH', 'TZ', 'LANG'])
  for (const name of Object.keys(env)) if (!keep.has(name)) delete env[name]
  env.PORT = String(port)
  env.HOST = '127.0.0.1'
  env.FLING_FILES_DIR = join(here, ENTRY_FILES_DIR)
}

createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err)
    errorAnswer(res, 502, 'server_failed', "The site's server failed")
  })
}).listen(publicPort, publicHost)

innerPort = await freePort()
scrubEnvironment(innerPort)
process.argv = [
  process.argv[0] ?? 'node',
  join(here, 'entry.mjs'),
  join(here, ENTRY_BUNDLE),
  `${CLI_PACKAGE}${SERVER_HELPER_SUFFIX}`,
  pathToFileURL(join(here, 'helper.mjs')).href,
]
try {
  await import(pathToFileURL(join(here, 'entry.mjs')).href)
} catch (err) {
  console.error(err)
  failed = `the server threw while loading: ${err instanceof Error ? err.message : String(err)}`
}
