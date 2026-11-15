/**
 * Site servers run by Node, one child process per version: the local runtime's SiteServers (the
 * dev server's sites host, the conformance suites). Each child runs entry.mjs on the version's
 * bundle, copied out of Blobs to `<workDir>/<siteId>/<versionId>/server.mjs`, listening on a
 * loopback port of its own. Its environment is the version's declared secrets, PORT,
 * FLING_FILES_DIR and FLING_SECRET_NAMES, and nothing of the parent's: no credentials, no paths.
 * What it prints goes to ServerLogs as `output` lines, and the first lines of each start are kept
 * for the start probe.
 *
 * Limits: the wall time (`timeoutSeconds`, streams included) and the request body (`bodyBytes`)
 * are enforced here; CPU, requests per second, environments and egress are not (the platforms
 * enforce them). A server that isn't running when a request comes (the dev server restarted, it
 * crashed) is started again with the options `optionsFor` gives.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SERVER_SITE_HEADER, SERVER_START_LOG_LINES } from '@fling/shared'
import type { Blobs } from '../../blobs/types.ts'
import { SERVER_HELPER_MODULE } from '../index.ts'
import type {
  ProbeRequest,
  ProbeResult,
  ServerLogLine,
  ServerLogs,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '../types.ts'

/** The child entry and the helpers it resolves the bundle's import of them to. */
export const NODE_ENTRY = fileURLToPath(new URL('./entry.mjs', import.meta.url))
export const NODE_HELPER = fileURLToPath(new URL('./helper.mjs', import.meta.url))

export interface NodeSiteServersOptions {
  /** where bundles are read from */
  blobs: Blobs
  /** where bundles are copied to and run from */
  workDir: string
  /** a version's files as a directory, for `file()` (fs blobs: under their root); null: none */
  filesDir?: (version: ServerVersion) => string | null
  /** where output lines go */
  logs?: ServerLogs
  /** the options for a server started again without activate (after a restart) */
  optionsFor?: (site: ServerSite, version: ServerVersion) => Promise<ServerOptions | null>
  /** the node binary (default: this one) */
  node?: string
}

interface Child {
  key: string
  site: ServerSite
  version: ServerVersion
  options: ServerOptions
  port: number
  proc: ChildProcess
  /** the first lines it printed */
  start: string[]
  exited: { code: number | null; signal: string | null } | null
  ready: Promise<void> | null
}

const stopped = () =>
  Response.json(
    { error: { code: 'server_stopped', message: 'Server stopped' } },
    { status: 503, headers: { 'cache-control': 'private, no-store' } }
  )

/** A free loopback port: asked of the OS, then released for the child to listen on. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.unref()
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class NodeSiteServers implements SiteServers {
  private readonly children = new Map<string, Child>()
  private readonly options = new Map<string, ServerOptions>()
  private readonly disabled = new Set<string>()
  private readonly node: string

  constructor(private readonly opts: NodeSiteServersOptions) {
    this.node = opts.node ?? process.execPath
  }

  private key = (site: ServerSite, version: ServerVersion) => `${site.id}/${version.id}`
  private dir = (site: ServerSite, version?: ServerVersion) =>
    resolve(this.opts.workDir, site.id, ...(version ? [version.id] : []))

  async activate(site: ServerSite, version: ServerVersion, opts: ServerOptions) {
    const key = this.key(site, version)
    const same = JSON.stringify(this.options.get(key)) === JSON.stringify(opts)
    this.options.set(key, opts)
    if (!same || !this.running(key)) await this.restart(site, version, opts)
    return { target: null }
  }

  async probe(
    site: ServerSite,
    version: ServerVersion,
    request: ProbeRequest
  ): Promise<ProbeResult> {
    const child = this.children.get(this.key(site, version))
    if (!child) return { ok: false, error: 'not activated', logs: [] }
    const logs = () => child.start.slice(0, SERVER_START_LOG_LINES)
    const deadline = Date.now() + request.timeoutMs
    const failed = await this.waitReady(child, request.timeoutMs)
    if (failed) return { ok: false, error: failed, logs: logs() }
    try {
      const res = await fetch(`http://127.0.0.1:${child.port}${request.path}`, {
        headers: { [SERVER_SITE_HEADER]: `${site.id}/${version.id}` },
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      })
      await res.body?.cancel()
      return { ok: true, status: res.status, logs: logs() }
    } catch (err) {
      const why = child.exited
        ? exitText(child.exited)
        : err instanceof Error && err.name === 'TimeoutError'
          ? `no answer within ${request.timeoutMs / 1000} s`
          : String(err)
      return { ok: false, error: why, logs: logs() }
    }
  }

  async reconfigure(site: ServerSite, version: ServerVersion, opts: ServerOptions) {
    this.options.set(this.key(site, version), opts)
    if (!this.disabled.has(site.id)) await this.restart(site, version, opts)
    return { target: null }
  }

  async setEnabled(site: ServerSite, enabled: boolean) {
    if (enabled) {
      this.disabled.delete(site.id)
      return
    }
    this.disabled.add(site.id)
    for (const child of this.childrenOf(site)) this.stop(child)
  }

  async retire(site: ServerSite, version?: ServerVersion) {
    const children = version
      ? [this.children.get(this.key(site, version))].filter(c => c !== undefined)
      : this.childrenOf(site)
    for (const child of children) this.stop(child)
    if (version) this.options.delete(this.key(site, version))
    else {
      for (const k of [...this.options.keys()])
        if (k.startsWith(`${site.id}/`)) this.options.delete(k)
      this.disabled.delete(site.id)
    }
    await rm(this.dir(site, version), { recursive: true, force: true })
  }

  async invoke(site: ServerSite, version: ServerVersion, request: Request): Promise<Response> {
    if (this.disabled.has(site.id)) return stopped()
    const child = await this.ensure(site, version)
    if (!child) return stopped()
    const { limits } = child.options
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > limits.bodyBytes) {
      return Response.json(
        { error: { code: 'too_large', message: 'Request body too large' } },
        { status: 413 }
      )
    }
    const failed = await this.waitReady(child, limits.timeoutSeconds * 1000)
    if (failed)
      return gatewayError(502, 'server_failed', `The site's server isn't running (${failed})`)
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-host', url.host)
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    try {
      const res = await fetch(`http://127.0.0.1:${child.port}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        redirect: 'manual',
        signal: AbortSignal.timeout(limits.timeoutSeconds * 1000),
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit)
      // fetch decoded the body: what goes on is the decoded bytes.
      const out = new Headers(res.headers)
      out.delete('content-encoding')
      out.delete('content-length')
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return gatewayError(504, 'server_timeout', `No answer within ${limits.timeoutSeconds} s`)
      }
      return gatewayError(502, 'server_failed', "The site's server failed")
    }
  }

  /** Every child stopped: for tests and the dev server's exit. */
  async close() {
    for (const child of this.children.values()) this.stop(child)
  }

  private running(key: string) {
    const c = this.children.get(key)
    return c !== undefined && c.exited === null
  }

  private childrenOf(site: ServerSite) {
    return [...this.children.values()].filter(c => c.site.id === site.id)
  }

  private async ensure(site: ServerSite, version: ServerVersion): Promise<Child | null> {
    const key = this.key(site, version)
    const child = this.children.get(key)
    if (child && child.exited === null) return child
    const opts = this.options.get(key) ?? (await this.opts.optionsFor?.(site, version)) ?? null
    if (!opts) return null
    this.options.set(key, opts)
    return this.restart(site, version, opts)
  }

  private stop(child: Child) {
    if (child.exited === null) child.proc.kill('SIGKILL')
    if (this.children.get(child.key) === child) this.children.delete(child.key)
  }

  private async restart(site: ServerSite, version: ServerVersion, options: ServerOptions) {
    const key = this.key(site, version)
    const old = this.children.get(key)
    if (old) this.stop(old)
    const dir = this.dir(site, version)
    await mkdir(dir, { recursive: true })
    const bundle = await this.opts.blobs.get(version.bundle)
    if (!bundle) throw new Error(`no bundle at ${version.bundle}`)
    const path = join(dir, 'server.mjs')
    await writeFile(path, bundle)
    const port = await freePort()
    const files = this.opts.filesDir?.(version) ?? null
    const env: Record<string, string> = {
      ...options.secrets,
      PORT: String(port),
      FLING_SECRET_NAMES: Object.keys(options.secrets).join(','),
      ...(files ? { FLING_FILES_DIR: files } : {}),
    }
    const proc = spawn(
      this.node,
      [NODE_ENTRY, path, SERVER_HELPER_MODULE, pathToFileURL(NODE_HELPER).href],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const child: Child = {
      key,
      site,
      version,
      options,
      port,
      proc,
      start: [],
      exited: null,
      ready: null,
    }
    proc.on('exit', (code, signal) => {
      child.exited = { code, signal }
    })
    proc.on('error', err => {
      child.exited = { code: null, signal: null }
      child.start.push(String(err))
    })
    this.capture(child, proc.stdout, 'info')
    this.capture(child, proc.stderr, 'error')
    this.children.set(key, child)
    return child
  }

  private capture(child: Child, stream: NodeJS.ReadableStream | null, level: 'info' | 'error') {
    if (!stream) return
    let rest = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      this.lines(child, parts, level)
    })
    stream.on('end', () => {
      if (rest) this.lines(child, [rest], level)
    })
  }

  private lines(child: Child, texts: string[], level: 'info' | 'error') {
    const kept = texts.filter(t => t.length > 0)
    if (kept.length === 0) return
    for (const t of kept) if (child.start.length < SERVER_START_LOG_LINES) child.start.push(t)
    const at = new Date().toISOString()
    const lines: ServerLogLine[] = kept.map(text => ({
      at,
      versionId: child.version.id,
      kind: 'output',
      level,
      text,
    }))
    this.opts.logs?.append?.(child.site.id, lines).catch(() => {})
  }

  /** Wait until the child listens: null once it does, else why not. */
  private async waitReady(child: Child, timeoutMs: number): Promise<string | null> {
    child.ready ??= (async () => {
      while (child.exited === null) {
        if (await connects(child.port)) return
        await sleep(25)
      }
    })()
    const timedOut = Symbol('timeout')
    const r = await Promise.race([
      child.ready.then(() => null),
      sleep(timeoutMs).then(() => timedOut),
    ])
    if (child.exited) return exitText(child.exited)
    if (r === timedOut) return `not listening on PORT within ${timeoutMs / 1000} s`
    return null
  }
}

const exitText = (e: { code: number | null; signal: string | null }) =>
  e.signal ? `stopped by ${e.signal}` : `exited with code ${e.code}`

const gatewayError = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'private, no-store' } }
  )
