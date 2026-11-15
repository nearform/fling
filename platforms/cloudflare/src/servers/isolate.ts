/**
 * The modules of a site server's isolate besides the version's bundle: Fling's main module, which
 * runs the bundle, and Fling's helpers (SERVER_HELPER_MODULE, `<CLI package>/server`) as the
 * Workers implementation of FlingServerHelpers. Both are source text the Worker Loader is given
 * with the bundle (runtime.ts); they import only what the Workers runtime has.
 *
 * The main module imports the bundle on the first request, not at load: its top level runs once,
 * whatever it prints is kept, and a throw there is an answer (502, and the start probe's error)
 * rather than an isolate that never loads. A bundle whose default export has `fetch` is a fetch
 * handler; any other is a plain Node server, which listens on PORT (SERVER_PORT, in its env) and
 * is reached through `httpServerHandler` from `cloudflare:node`. What the top level prints is
 * replayed by the first request, because the runtime's tail sees only what an invocation prints.
 *
 * `FlingProbe` (PROBE_ENTRYPOINT) is the start probe's way in: one request to the server, and the
 * first lines it printed, over RPC, so no request the server answers can pose as the probe's.
 */
import { SERVER_START_LOG_LINES } from '@fling/shared'
import { VIEWER_HEADER } from '@fling/shared/route-keys'

/** The port a plain Node server listens on: `process.env.PORT` in its isolate. */
export const SERVER_PORT = 8080
/** Fling's main module, and the bundle's name beside it. */
export const MAIN_MODULE = 'fling-main.js'
export const BUNDLE_MODULE = 'server.js'
/** The main module's entrypoint the start probe calls. */
export const PROBE_ENTRYPOINT = 'FlingProbe'
/** How many top-level lines are kept for the replay (the probe reports the first few). */
const KEPT_LINES = 200

/** The start probe's answer from inside the isolate (ProbeResult, from the main module). */
export type IsolateProbe =
  | { ok: true; status: number; logs: string[] }
  | { ok: false; error: string; logs: string[] }

export interface ProbeEntrypoint {
  probe(url: string, headers: Record<string, string>, timeoutMs: number): Promise<IsolateProbe>
}

export const mainModule = () => `
import { WorkerEntrypoint } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'

const LEVELS = ['debug', 'log', 'info', 'warn', 'error']
const started = []
const original = {}
let loading
let replayed = false

const json = value => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
const text = args =>
  args
    .map(a => (typeof a === 'string' ? a : a instanceof Error ? a.stack || String(a) : json(a)))
    .join(' ')
const errorText = err => (err instanceof Error ? err.name + ': ' + err.message : String(err))

function start() {
  if (loading) return loading
  for (const level of LEVELS) {
    original[level] = console[level]
    console[level] = (...args) => {
      if (started.length < ${KEPT_LINES}) started.push([level, text(args)])
    }
  }
  loading = import('./${BUNDLE_MODULE}')
    .then(
      mod => {
        const handler = mod.default
        if (handler && typeof handler.fetch === 'function') return { handler, node: false }
        return { handler: httpServerHandler({ port: ${SERVER_PORT} }), node: true }
      },
      error => {
        started.push(['error', 'The server threw as it started: ' + errorText(error)])
        return { error }
      }
    )
    .then(result => {
      for (const level of LEVELS) console[level] = original[level]
      return result
    })
  return loading
}

function replay() {
  if (replayed) return
  replayed = true
  for (const [level, line] of started) console[level](line)
}

const notListening = err => /server with port \\d+ not found/i.test(String(err && err.message))

export class ${PROBE_ENTRYPOINT} extends WorkerEntrypoint {
  async probe(url, headers, timeoutMs) {
    const s = await start()
    replay()
    const logs = () => started.slice(0, ${SERVER_START_LOG_LINES}).map(entry => entry[1])
    if (s.error) return { ok: false, error: 'it threw as it started: ' + errorText(s.error), logs: logs() }
    let timer
    const late = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      const res = await Promise.race([s.handler.fetch(new Request(url, { headers }), this.env, this.ctx), late])
      if (!res) return { ok: false, error: 'no answer within ' + timeoutMs / 1000 + ' s', logs: logs() }
      await res.body?.cancel()
      return { ok: true, status: res.status, logs: logs() }
    } catch (err) {
      const error = s.node && notListening(err) ? 'not listening on PORT' : 'it threw: ' + errorText(err)
      return { ok: false, error, logs: logs() }
    } finally {
      clearTimeout(timer)
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const s = await start()
    replay()
    if (s.error) {
      return Response.json(
        { error: { code: 'server_failed', message: "The site's server failed to start" } },
        { status: 502, headers: { 'cache-control': 'private, no-store' } }
      )
    }
    try {
      return await s.handler.fetch(request, env, ctx)
    } catch (err) {
      if (s.node && notListening(err)) throw new Error("The server isn't listening on PORT (process.env.PORT)")
      throw err
    }
  },
}
`

/** Fling's helpers in the isolate: the version's declared secret names are written in. */
export const helperModule = (secretNames: readonly string[]) => `
import { env } from 'cloudflare:workers'

const VIEWER_HEADER = ${JSON.stringify(VIEWER_HEADER)}
const SECRETS = new Set(${JSON.stringify([...secretNames])})

function headerOf(request) {
  const headers = request && request.headers
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(VIEWER_HEADER)
  const raw = headers[VIEWER_HEADER]
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
}

export function viewer(request) {
  const raw = headerOf(request)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.id !== 'string' || typeof v?.email !== 'string') return null
    return { id: v.id, email: v.email, guest: v.guest === true }
  } catch {
    return null
  }
}

function filePath(path) {
  const p = String(path).replace(/^\\/+/, '')
  if (!p || p.split('/').some(s => s === '' || s.startsWith('.'))) return null
  if (p.startsWith('_fling/')) return null
  return p
}

export async function file(path) {
  const p = filePath(path)
  if (p === null || !env.FILES) return new Response('Not found', { status: 404 })
  return env.FILES.fetch('https://files.invalid/' + p.split('/').map(encodeURIComponent).join('/'))
}

export function secret(name) {
  const value = SECRETS.has(name) ? env[name] : undefined
  if (typeof value !== 'string') {
    throw new Error(
      'The site secret ' + name + " isn't set: declare it in fling.json and set it (fling secrets set)"
    )
  }
  return value
}

export default { viewer, file, secret }
`
