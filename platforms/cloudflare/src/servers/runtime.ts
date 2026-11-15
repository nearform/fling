/**
 * Site servers on the Worker Loader: the Cloudflare SiteServers. Each version's server runs in an
 * isolate of its own, named `site:<siteId>:<versionId>:<run>` and loaded the first time it is
 * asked for: the bundle read from R2, Fling's main module and helpers beside it (isolate.ts),
 * `nodejs_compat`, its declared site secrets, `PORT` and `FILES` (SiteFiles, the version's own
 * files) as its env and nothing else of the Worker's; no outbound network unless SERVERS_EGRESS is
 * `open`; at most SERVER_CPU_MS of CPU per request; what it prints to ServerTail (entrypoints.ts).
 *
 * `<run>` names what the version runs with: a keyed hash of its options (the secrets' values, the
 * egress, the limits), so a changed secret or limit is a new isolate and the old one idles out.
 * activate and reconfigure seal those options into R2 (`sites/<siteId>/_servers/<v>/<run>.json`,
 * AES-256-GCM under a key from SITE_SECRETS_KEY) and return the run as the target, which the core
 * keeps in the route value (`t`): the sites host reads the route, so every isolate of the Worker
 * finds the options of the run the route names, whichever isolate activated it.
 *
 * Enforced here, around each request: the wall time (SERVER_TIMEOUT_SECONDS, streams included:
 * 504 before the answer starts, the stream cut after), the request body (SERVER_BODY_BYTES: 413)
 * and requests per site (the SERVER_RATE_LIMIT binding: 429). The route value's `x` (an admin's
 * kill switch) is the sites host's routing decision; setEnabled stops a site in this isolate too.
 * There are no environments to cap: SERVER_ENVIRONMENTS applies to AWS only.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import type {
  Fetcher,
  R2Bucket,
  RateLimit,
  WorkerLoader,
  WorkerLoaderWorkerCode,
  WorkerStub,
} from '@cloudflare/workers-types'
import type {
  ProbeRequest,
  ProbeResult,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '@fling/api/servers/types'
import { SERVER_HELPER_MODULE, sitePrefix } from '@fling/shared'
import { SERVER_SITE_HEADER } from '@fling/shared/route-keys'
import {
  BUNDLE_MODULE,
  helperModule,
  MAIN_MODULE,
  mainModule,
  PROBE_ENTRYPOINT,
  type ProbeEntrypoint,
  SERVER_PORT,
} from './isolate.ts'

/** The workerd release wrangler runs supports dates up to this one (wrangler.jsonc). */
export const SERVER_COMPATIBILITY_DATE = '2026-10-19'

/** What a server's isolate is handed of the Fling Worker: its entrypoints, with props. */
export interface ServerBindings {
  /** SiteFiles scoped to a version's files (`sites/<siteId>/<v>/`) */
  files(prefix: string): Fetcher
  /** ServerTail for one version's output */
  tail(props: { siteId: string; versionId: string }): Fetcher
}

export interface CloudflareSiteServersOptions {
  loader: WorkerLoader
  /** the bucket of site files: bundles, and the sealed options of each run */
  bucket: R2Bucket
  bindings: ServerBindings
  /** SITE_SECRETS_KEY: seals each run's options and keys its name */
  key: string
  /** SERVER_RATE_LIMIT: counts each site's requests (absent: not limited) */
  rateLimit?: RateLimit
  /** the requests per second the rate-limit binding allows one key (the instance's SERVER_RPS) */
  baseRps: number
  compatibilityDate?: string
}

interface Run {
  name: string
  options: ServerOptions
}

/** How many runs' options one Worker isolate keeps opened. */
const KEPT_RUNS = 500
/** How much longer than its own timeout the Worker waits for a probe's answer. */
const PROBE_GRACE_MS = 2000
const SEAL_LABEL = 'fling:cloudflare-server-run:v1'
const NAME_LABEL = 'fling:cloudflare-server-run-name:v1'

const runsPrefix = (siteId: string, versionId: string) =>
  `${sitePrefix(siteId)}_servers/${versionId}/`
const runKey = (siteId: string, versionId: string, run: string) =>
  `${runsPrefix(siteId, versionId)}${run}.json`

const failure = (status: number, code: string, message: string, headers?: HeadersInit) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'private, no-store', ...headers } }
  )

/** Options as one string whatever order their keys came in. */
function canonical(options: ServerOptions): string {
  const sorted = (o: object) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify({
    secrets: sorted(options.secrets),
    egress: options.egress,
    limits: sorted(options.limits),
  })
}

export class CloudflareSiteServers implements SiteServers {
  /** the run each version was last activated or reconfigured with, in this isolate */
  private readonly current = new Map<string, Run>()
  /** runs' options as opened, by `<siteId>/<v>/<run>`, least recently used first */
  private readonly opened = new Map<string, ServerOptions>()
  private readonly disabled = new Set<string>()
  private readonly retired = new Set<string>()
  private readonly sealKey: Buffer
  private readonly nameKey: Buffer

  constructor(private readonly opts: CloudflareSiteServersOptions) {
    const raw = opts.key.trim()
    if (!raw) throw new Error('Site servers need SITE_SECRETS_KEY')
    this.sealKey = Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), SEAL_LABEL, 32))
    this.nameKey = Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), NAME_LABEL, 32))
  }

  private key = (site: ServerSite, version: ServerVersion) => `${site.id}/${version.id}`

  /** The run's name: the options' keyed hash, 16 hex characters. */
  runOf(options: ServerOptions): string {
    return createHmac('sha256', this.nameKey).update(canonical(options)).digest('hex').slice(0, 16)
  }

  async activate(site: ServerSite, version: ServerVersion, options: ServerOptions) {
    const run = this.runOf(options)
    const k = this.key(site, version)
    const known = this.opened.has(`${k}/${run}`)
    this.retired.delete(k)
    this.retired.delete(site.id)
    this.current.set(k, { name: run, options })
    this.remember(`${k}/${run}`, options)
    if (!known || !(await this.opts.bucket.head(runKey(site.id, version.id, run)))) {
      await this.opts.bucket.put(
        runKey(site.id, version.id, run),
        this.seal(site, version, run, options),
        {
          httpMetadata: { contentType: 'application/octet-stream' },
        }
      )
    }
    return { target: run }
  }

  async probe(
    site: ServerSite,
    version: ServerVersion,
    request: ProbeRequest
  ): Promise<ProbeResult> {
    const run = this.current.get(this.key(site, version))
    if (!run) return { ok: false, error: 'not activated', logs: [] }
    const entry = this.stub(site, version, run.name, run.options).getEntrypoint(
      PROBE_ENTRYPOINT
    ) as unknown as ProbeEntrypoint
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), request.timeoutMs + PROBE_GRACE_MS)
    })
    try {
      const answer = await Promise.race([
        entry.probe(
          `https://${site.name || site.id}.probe.invalid${request.path}`,
          { [SERVER_SITE_HEADER]: `${site.id}/${version.id}` },
          request.timeoutMs
        ),
        late,
      ])
      if (!answer)
        return { ok: false, error: `no answer within ${request.timeoutMs / 1000} s`, logs: [] }
      return answer.ok
        ? { ok: true, status: answer.status, logs: [...answer.logs] }
        : { ok: false, error: answer.error, logs: [...answer.logs] }
    } catch (err) {
      return { ok: false, error: `it didn't load (${errorText(err)})`, logs: [] }
    } finally {
      clearTimeout(timer)
    }
  }

  reconfigure(site: ServerSite, version: ServerVersion, options: ServerOptions) {
    return this.activate(site, version, options)
  }

  async setEnabled(site: ServerSite, enabled: boolean) {
    if (enabled) this.disabled.delete(site.id)
    else this.disabled.add(site.id)
  }

  /**
   * A version's runs are forgotten and their sealed options deleted; a whole site's go with its
   * files (`sites/<siteId>/`, which the core deletes). Idle isolates are the runtime's to drop.
   */
  async retire(site: ServerSite, version?: ServerVersion) {
    if (!version) {
      this.retired.add(site.id)
      for (const k of [...this.current.keys()])
        if (k.startsWith(`${site.id}/`)) this.current.delete(k)
      return
    }
    const k = this.key(site, version)
    this.retired.add(k)
    this.current.delete(k)
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${k}/`)) this.opened.delete(key)
    const prefix = runsPrefix(site.id, version.id)
    let cursor: string | undefined
    do {
      const page = await this.opts.bucket.list({ prefix, cursor })
      if (page.objects.length) await this.opts.bucket.delete(page.objects.map(o => o.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }

  invoke(site: ServerSite, version: ServerVersion, request: Request): Promise<Response> {
    return this.serve(site, version, request)
  }

  /**
   * Run a request through a version's server. `run` is the route value's target (the sites
   * host); without one, the run this isolate last activated.
   */
  async serve(
    site: ServerSite,
    version: ServerVersion,
    request: Request,
    run?: string | null
  ): Promise<Response> {
    const k = this.key(site, version)
    if (this.disabled.has(site.id)) return failure(503, 'server_stopped', 'Server stopped')
    if (this.retired.has(k) || this.retired.has(site.id)) {
      return failure(404, 'not_found', 'No such server')
    }
    let found: Run | null
    try {
      found = await this.find(site, version, run)
    } catch {
      found = null
    }
    if (!found) return failure(502, 'server_failed', "The site's server isn't ready")
    const { limits } = found.options
    if (!(await this.admit(site, limits.rps))) {
      return failure(429, 'rate_limited', 'Too many requests to this server', {
        'retry-after': '10',
      })
    }
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > limits.bodyBytes) return failure(413, 'too_large', 'Request body too large')
    const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
    const body = hasBody
      ? capped(request.body as ReadableStream<Uint8Array>, limits.bodyBytes)
      : null
    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: body?.stream ?? null,
      redirect: 'manual',
    })
    const timeoutMs = limits.timeoutSeconds * 1000
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      const stub = this.stub(site, version, found.name, found.options)
      const res = (await Promise.race([
        stub.getEntrypoint().fetch(forwarded as never) as unknown as Promise<Response>,
        late,
      ])) as Response | null
      if (!res) return failure(504, 'server_timeout', `No answer within ${limits.timeoutSeconds} s`)
      if (body?.over()) {
        await res.body?.cancel()
        return failure(413, 'too_large', 'Request body too large')
      }
      return withDeadline(res, timeoutMs - (Date.now() - started))
    } catch (err) {
      if (body?.over()) return failure(413, 'too_large', 'Request body too large')
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'site server failed',
          site: site.id,
          err: errorText(err),
        })
      )
      return failure(502, 'server_failed', "The site's server failed")
    } finally {
      clearTimeout(timer)
    }
  }

  /** The run's options: this isolate's, or opened from R2 (the route names a run made elsewhere). */
  private async find(
    site: ServerSite,
    version: ServerVersion,
    run?: string | null
  ): Promise<Run | null> {
    const k = this.key(site, version)
    if (!run) return this.current.get(k) ?? null
    const kept = this.opened.get(`${k}/${run}`)
    if (kept) {
      this.remember(`${k}/${run}`, kept)
      return { name: run, options: kept }
    }
    const object = await this.opts.bucket.get(runKey(site.id, version.id, run))
    if (!object) return null
    const options = this.open(site, version, run, new Uint8Array(await object.arrayBuffer()))
    if (!options) return null
    this.remember(`${k}/${run}`, options)
    return { name: run, options }
  }

  /**
   * One of the site's requests counted: false once it is over the limit. The binding allows each
   * key the instance's SERVER_RPS; a site an admin raised is counted across as many keys as that
   * multiplies it by.
   */
  private async admit(site: ServerSite, rps: number): Promise<boolean> {
    const limiter = this.opts.rateLimit
    if (!limiter) return true
    const shards = Math.max(1, Math.round(rps / Math.max(1, this.opts.baseRps)))
    const key = shards === 1 ? site.id : `${site.id}:${Math.floor(Math.random() * shards)}`
    try {
      return (await limiter.limit({ key })).success
    } catch {
      return true
    }
  }

  private stub(site: ServerSite, version: ServerVersion, run: string, options: ServerOptions) {
    const { bucket, bindings, loader } = this.opts
    return loader.get(`site:${site.id}:${version.id}:${run}`, async () => {
      const object = await bucket.get(version.bundle)
      if (!object) throw new Error(`no bundle at ${version.bundle}`)
      const code: WorkerLoaderWorkerCode = {
        compatibilityDate: this.opts.compatibilityDate ?? SERVER_COMPATIBILITY_DATE,
        compatibilityFlags: ['nodejs_compat'],
        mainModule: MAIN_MODULE,
        modules: {
          [MAIN_MODULE]: { js: mainModule() },
          [BUNDLE_MODULE]: { js: await object.text() },
          [SERVER_HELPER_MODULE]: { js: helperModule(Object.keys(options.secrets)) },
        },
        // Fling's two after the secrets: a secret can't take their place.
        env: {
          ...options.secrets,
          PORT: String(SERVER_PORT),
          FILES: bindings.files(version.files),
        },
        limits: { cpuMs: options.limits.cpuMs },
        tails: [bindings.tail({ siteId: site.id, versionId: version.id })],
      }
      if (options.egress === 'none') code.globalOutbound = null
      return code
    }) as WorkerStub
  }

  private remember(key: string, options: ServerOptions) {
    this.opened.delete(key)
    this.opened.set(key, options)
    while (this.opened.size > KEPT_RUNS) {
      const oldest = this.opened.keys().next().value
      if (oldest === undefined) break
      this.opened.delete(oldest)
    }
  }

  private aad = (site: ServerSite, version: ServerVersion, run: string) =>
    Buffer.from(`${site.id}\n${version.id}\n${run}`)

  private seal(site: ServerSite, version: ServerVersion, run: string, options: ServerOptions) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv)
    cipher.setAAD(this.aad(site, version, run))
    const body = Buffer.concat([cipher.update(JSON.stringify(options), 'utf8'), cipher.final()])
    return new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()]))
  }

  private open(
    site: ServerSite,
    version: ServerVersion,
    run: string,
    sealed: Uint8Array
  ): ServerOptions | null {
    try {
      const bytes = Buffer.from(sealed)
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, bytes.subarray(0, 12))
      decipher.setAAD(this.aad(site, version, run))
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      const text = Buffer.concat([
        decipher.update(bytes.subarray(12, bytes.length - 16)),
        decipher.final(),
      ]).toString('utf8')
      return JSON.parse(text) as ServerOptions
    } catch {
      return null
    }
  }
}

/**
 * A request body that stops once it passes `max` bytes (one sent without a length, or longer than
 * it said), and says so: the server's answer to a cut body is not passed on.
 */
function capped(body: ReadableStream<Uint8Array>, max: number) {
  let seen = 0
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > max) controller.error(new Error('Request body too large'))
        else controller.enqueue(chunk)
      },
    })
  )
  return { stream, over: () => seen > max }
}

/** The response as it came, its body cut off when the request's wall time runs out. */
function withDeadline(res: Response, remainingMs: number): Response {
  if (!res.body) return res
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), Math.max(remainingMs, 0))
  res.body
    .pipeTo(writable, { signal: stop.signal })
    .catch(() => {})
    .finally(() => clearTimeout(timer))
  return new Response(readable, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
