/**
 * Lambda Web Functions, CloudWatch Logs and the server zip bucket, faked locally for the site
 * servers adapter: there is no emulator for Web Functions. Each revision runs as Lambda runs it, as
 * far as Fling can tell: its zip unpacked, `node index.mjs` with the revision's environment plus
 * what Lambda adds (AWS_LAMBDA_HTTP_ENDPOINT, credentials, HOME), requests sent to the endpoint's
 * domain going to the revision its weights name, `lambda-web-logstream` on every answer, rateLimit
 * 0 answering 503 EndpointDisabled, and what the process prints written to its log group as JSON
 * events in a `YYYY/MM/DD/<fn>[<revisionId>]…` stream. Signing, quotas beyond the vCPU one, and
 * timing are not faked.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { heldBody } from '@fling/api/servers/body'
import { unzipSync } from 'fflate'
import type { LogEvent, LogEventsApi } from '../src/servers/server-logs.ts'
import type {
  EndpointState,
  RevisionSpec,
  RevisionState,
  RevisionWeight,
  WebFunctionsApi,
} from '../src/servers/web-functions.ts'
import type { ServerZips } from '../src/servers/zips.ts'

export class MemoryZips implements ServerZips {
  readonly bucket = 'fake-server-zips'
  readonly objects = new Map<string, { versionId: string; body: Uint8Array }[]>()
  private n = 0

  async find(key: string) {
    return this.objects.get(key)?.at(-1)?.versionId ?? null
  }

  async put(key: string, body: Uint8Array) {
    const versionId = `ov${++this.n}`
    this.objects.set(key, [...(this.objects.get(key) ?? []), { versionId, body }])
    return versionId
  }

  async deletePrefix(prefix: string) {
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key)
  }

  get(key: string, versionId: string) {
    return this.objects.get(key)?.find(o => o.versionId === versionId)?.body ?? null
  }
}

export class FakeLogEvents implements LogEventsApi {
  readonly groupsByName = new Map<string, LogEvent[]>()
  readonly retention = new Map<string, number>()

  add(group: string, event: LogEvent) {
    const events = this.groupsByName.get(group) ?? []
    events.push(event)
    this.groupsByName.set(group, events)
  }

  async events(group: string, opts: { startTime: number; limit: number; nextToken?: string }) {
    const all = (this.groupsByName.get(group) ?? [])
      .filter(e => e.timestamp >= opts.startTime)
      .sort((a, b) => a.timestamp - b.timestamp)
    const from = Number(opts.nextToken ?? 0)
    const events = all.slice(from, from + opts.limit)
    const next = from + opts.limit
    return { events, ...(next < all.length ? { nextToken: String(next) } : {}) }
  }

  async retain(group: string, days: number) {
    if (!this.groupsByName.has(group)) this.groupsByName.set(group, [])
    this.retention.set(group, days)
  }

  async deleteGroup(group: string) {
    this.groupsByName.delete(group)
    this.retention.delete(group)
  }

  async groups(prefix: string) {
    return [...this.groupsByName.keys()].filter(g => g.startsWith(prefix))
  }
}

interface FakeRevision extends RevisionState {
  spec: RevisionSpec
}

interface FakeEndpoint extends EndpointState {}

interface FakeFunction {
  name: string
  arn: string
  tags: Record<string, string>
  policy?: string
  revisions: Map<string, FakeRevision>
  endpoints: Map<string, FakeEndpoint>
}

interface Running {
  proc: ChildProcess
  port: number
  exited: boolean
}

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      s.close(() => res(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })

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

export class FakeWebFunctions implements WebFunctionsApi {
  readonly functions = new Map<string, FakeFunction>()
  readonly calls: string[] = []
  vcpus = 800
  private readonly running = new Map<string, Running>()
  private n = 0

  constructor(
    private readonly zips: MemoryZips,
    private readonly logs: FakeLogEvents,
    private readonly workDir: string,
    private readonly entry = 'index.mjs'
  ) {}

  private fn(name: string) {
    const f = this.functions.get(name)
    if (!f) throw Object.assign(new Error(`no function ${name}`), { name: 'ResourceNotFound' })
    return f
  }

  private revision(f: FakeFunction, spec: RevisionSpec): FakeRevision {
    const revisionId = `rev-${++this.n}`
    const r: FakeRevision = {
      revisionId,
      description: spec.description,
      state: 'Active',
      createdAt: new Date(Date.now() + this.n),
      spec,
    }
    f.revisions.set(revisionId, r)
    return r
  }

  async createFunction(input: Parameters<WebFunctionsApi['createFunction']>[0]) {
    this.calls.push('createFunction')
    const f: FakeFunction = {
      name: input.name,
      arn: `arn:aws:lambda:eu-west-1:123456789012:web-function/${input.name}`,
      tags: { ...input.tags },
      revisions: new Map(),
      endpoints: new Map(),
    }
    this.functions.set(input.name, f)
    const r = this.revision(f, input.revision)
    const domainName = `${input.name}-${input.endpoint.name}.lambda-web.fake`
    f.endpoints.set(input.endpoint.name, {
      domainName,
      weights: [{ revisionId: r.revisionId, weight: 100 }],
      rateLimit: input.endpoint.rateLimit,
      maxEnvironments: input.endpoint.maxEnvironments,
      state: 'Active',
      updating: false,
    })
    return { arn: f.arn, revisionId: r.revisionId, domainName }
  }

  async getFunction(name: string) {
    const f = this.functions.get(name)
    return f ? { arn: f.arn } : null
  }

  async listFunctions(prefix: string) {
    return [...this.functions.values()]
      .filter(f => f.name.startsWith(prefix))
      .map(f => ({ name: f.name, arn: f.arn }))
  }

  async deleteFunction(name: string) {
    this.calls.push('deleteFunction')
    const f = this.functions.get(name)
    if (!f) return
    for (const id of f.revisions.keys()) this.stop(id)
    this.functions.delete(name)
  }

  private byArn(arn: string) {
    const f = [...this.functions.values()].find(x => x.arn === arn)
    if (!f) throw new Error(`no function ${arn}`)
    return f
  }

  async tags(arn: string) {
    return { ...this.byArn(arn).tags }
  }

  async tag(arn: string, tags: Record<string, string>) {
    Object.assign(this.byArn(arn).tags, tags)
  }

  async createRevision(name: string, spec: RevisionSpec) {
    this.calls.push('createRevision')
    return this.revision(this.fn(name), spec).revisionId
  }

  async getRevision(name: string, revisionId: string) {
    const r = this.functions.get(name)?.revisions.get(revisionId)
    return r ? { ...r } : null
  }

  async listRevisions(name: string) {
    return [...(this.functions.get(name)?.revisions.values() ?? [])].map(r => ({ ...r }))
  }

  async deleteRevision(name: string, revisionId: string) {
    this.calls.push('deleteRevision')
    const f = this.functions.get(name)
    if (!f) return
    for (const e of f.endpoints.values()) {
      if (e.weights.some(w => w.revisionId === revisionId && w.weight > 0)) {
        throw new Error(`revision ${revisionId} is routed to`)
      }
    }
    this.stop(revisionId)
    f.revisions.delete(revisionId)
  }

  async createEndpoint(name: string, e: Parameters<WebFunctionsApi['createEndpoint']>[1]) {
    const f = this.fn(name)
    const domainName = `${name}-${e.name}.lambda-web.fake`
    f.endpoints.set(e.name, {
      domainName,
      weights: e.weights,
      rateLimit: e.rateLimit,
      maxEnvironments: e.maxEnvironments,
      state: 'Active',
      updating: false,
    })
    return { domainName }
  }

  async getEndpoint(name: string, endpoint: string) {
    const e = this.functions.get(name)?.endpoints.get(endpoint)
    return e ? { ...e, weights: e.weights.map(w => ({ ...w })) } : null
  }

  async updateEndpoint(
    name: string,
    endpoint: string,
    change: Parameters<WebFunctionsApi['updateEndpoint']>[2]
  ) {
    this.calls.push(`updateEndpoint:${endpoint}`)
    const e = this.fn(name).endpoints.get(endpoint)
    if (!e) throw new Error(`no endpoint ${endpoint}`)
    if (change.weights) e.weights = change.weights.map((w: RevisionWeight) => ({ ...w }))
    if (change.rateLimit !== undefined) e.rateLimit = change.rateLimit
    if (change.maxEnvironments !== undefined) e.maxEnvironments = change.maxEnvironments
  }

  async putResourcePolicy(arn: string, policy: string) {
    this.byArn(arn).policy = policy
  }

  async maxArmVCpus() {
    return this.vcpus
  }

  async fetch(domainName: string, request: Request, signal?: AbortSignal) {
    const found = [...this.functions.values()].flatMap(f =>
      [...f.endpoints.values()].filter(e => e.domainName === domainName).map(e => ({ f, e }))
    )[0]
    if (!found) throw new TypeError(`fetch failed: ${domainName}`)
    const { f, e } = found
    if (e.rateLimit === 0) {
      return Response.json(
        { message: 'Endpoint disabled' },
        { status: 503, headers: { 'lambda-web-error-type': 'Platform.EndpointDisabled' } }
      )
    }
    const revisionId = e.weights.find(w => w.weight > 0)?.revisionId
    const revision = revisionId ? f.revisions.get(revisionId) : undefined
    if (!revision) {
      return Response.json(
        { message: 'No revision' },
        { status: 502, headers: { 'lambda-web-error-type': 'Platform.RevisionNotActive' } }
      )
    }
    const stream = `${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/${f.name}[${revision.revisionId}]fake`
    const run = await this.start(f, revision, stream)
    const until = Date.now() + 10_000
    while (!(await connects(run.port))) {
      if (run.exited || Date.now() > until) {
        return Response.json(
          { message: 'Runtime exited' },
          {
            status: 502,
            headers: {
              'lambda-web-error-type': 'Runtime.ExitError',
              'lambda-web-logstream': stream,
            },
          }
        )
      }
      await sleep(20)
    }
    const url = new URL(request.url)
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const res = await fetch(`http://127.0.0.1:${run.port}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : null,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
      ...(hasBody ? { duplex: 'half' } : {}),
    } as RequestInit)
    const headers = new Headers(res.headers)
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.set('lambda-web-logstream', stream)
    headers.set('lambda-web-request-id', `req-${++this.n}`)
    return new Response(heldBody(res), { status: res.status, headers })
  }

  private async start(f: FakeFunction, revision: FakeRevision, stream: string) {
    const running = this.running.get(revision.revisionId)
    if (running && !running.exited) return running
    const dir = join(this.workDir, revision.revisionId)
    rmSync(dir, { recursive: true, force: true })
    const { zip } = revision.spec
    const body = this.zips.get(zip.key, zip.versionId)
    if (!body) throw new Error(`no zip ${zip.key}@${zip.versionId}`)
    for (const [path, bytes] of Object.entries(unzipSync(body))) {
      const to = join(dir, path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, bytes)
    }
    const port = await freePort()
    const proc = spawn(process.execPath, [join(dir, this.entry)], {
      cwd: dir,
      env: {
        ...revision.spec.environment,
        AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`,
        AWS_LAMBDA_NODEJS_ENTRYPOINT: this.entry,
        AWS_ACCESS_KEY_ID: 'ASIAFAKE',
        AWS_SECRET_ACCESS_KEY: 'fake',
        HOME: '/home/sbx_user1051',
        PATH: process.env.PATH ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const run: Running = { proc, port, exited: false }
    proc.on('exit', () => {
      run.exited = true
    })
    const group = `/aws/lambda/web/${f.name}`
    for (const [out, level] of [
      [proc.stdout, 'INFO'],
      [proc.stderr, 'ERROR'],
    ] as const) {
      let rest = ''
      out?.setEncoding('utf8')
      out?.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop() ?? ''
        for (const message of parts.filter(Boolean)) {
          const timestamp = Date.now()
          this.logs.add(group, {
            timestamp,
            stream,
            message: JSON.stringify({
              timestamp: new Date(timestamp).toISOString(),
              level,
              message,
            }),
          })
        }
      })
    }
    this.logs.add(group, {
      timestamp: Date.now(),
      stream,
      message: JSON.stringify({ time: new Date().toISOString(), type: 'platform.initStart' }),
    })
    this.running.set(revision.revisionId, run)
    return run
  }

  private stop(revisionId: string) {
    const run = this.running.get(revisionId)
    if (run && !run.exited) run.proc.kill('SIGKILL')
    this.running.delete(revisionId)
  }

  async close() {
    for (const id of [...this.running.keys()]) this.stop(id)
  }
}
