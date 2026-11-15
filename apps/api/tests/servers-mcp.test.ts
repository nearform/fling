// The remote MCP's site server tools: fling_publish with a dependency-free `_fling/server.mjs`
// and its fling.json (a file among the others, or `siteServer`), the refusals said as what to do
// next, fling_server_template and fling_logs.
import { PULLED_SERVER_NOTE, SERVER_TEMPLATE } from '@fling/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { logInvoke } from '../src/servers/logs.ts'
import { MemoryServerLogs } from '../src/servers/memory-logs.ts'
import type {
  ProbeRequest,
  ProbeResult,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '../src/servers/types.ts'
import { createUser, type Env, setup } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

class FakeServers implements SiteServers {
  probes: ProbeRequest[] = []
  answer: ProbeResult = { ok: true, status: 200, logs: [] }
  async activate(_s: ServerSite, _v: ServerVersion, _o: ServerOptions) {
    return { target: null }
  }
  async probe(_s: ServerSite, _v: ServerVersion, request: ProbeRequest) {
    this.probes.push(request)
    return this.answer
  }
  async reconfigure() {
    return { target: null }
  }
  async setEnabled() {}
  async retire() {}
  async invoke() {
    return new Response('ok')
  }
}

let env: Env
let servers: FakeServers
let bearer: string

beforeEach(async () => {
  env = setup()
  env.config.servers = { ...env.config.servers, publish: { kind: 'members' } }
  servers = new FakeServers()
  env.deps.servers = servers
  env.deps.serverLogs = new MemoryServerLogs(() => env.deps.clock.now())
  await createUser(env, 'alice@example.test')
  bearer = (await connect(env, 'alice@example.test')).accessToken
})

const page = { path: 'index.html', content: '<h1>hi</h1>' }
const bundle = (content = SERVER_TEMPLATE) => ({ path: '_fling/server.mjs', content })

describe('fling_publish with a site server', () => {
  it('takes a dependency-free bundle with its fling.json as a file, never published', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'tz-now',
      access: 'members',
      files: [page, bundle(), { path: 'fling.json', content: '{"health":"/api/health"}' }],
    })
    expect(r.isError).toBeFalsy()
    expect(servers.probes.map(p => p.path)).toEqual(['/api/health'])
    expect(r.content[0]?.text).toMatch(/Its server answers \/api\/\*/)
    expect(r.content[0]?.text).toContain('fling_logs')
    const files = await callTool(env, bearer, 'fling_files', { name: 'tz-now' })
    expect(files.content[0]?.text).not.toContain('fling.json')
  })

  it('takes fling.json as `siteServer`, and refuses both at once', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'tz-two',
      access: 'members',
      files: [page, bundle()],
      siteServer: { secrets: [], health: '/api/health' },
    })
    expect(r.isError).toBeFalsy()
    const both = await callTool(env, bearer, 'fling_publish', {
      name: 'tz-two',
      files: [page, bundle(), { path: 'fling.json', content: '{}' }],
      siteServer: { secrets: [] },
    })
    expect(both.isError).toBe(true)
  })

  it('server_not_bundled points at fling_server_template', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'hono-site',
      access: 'members',
      files: [page, bundle("import { Hono } from 'hono'\nexport default new Hono()")],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/server_not_bundled[\s\S]*fling_server_template/)
  })

  it('a public site asks first, and confirmPublicServer publishes it', async () => {
    const args = { name: 'open-api', access: 'public', files: [page, bundle()] }
    const ask = await callTool(env, bearer, 'fling_publish', args)
    expect(ask.isError).toBe(true)
    expect(ask.content[0]?.text).toMatch(/public_server[\s\S]*confirmPublicServer: true/)
    const ok = await callTool(env, bearer, 'fling_publish', { ...args, confirmPublicServer: true })
    expect(ok.isError).toBeFalsy()
  })

  it('a start that failed returns the server log', async () => {
    servers.answer = { ok: false, error: 'exited with code 1', logs: ['ReferenceError: nope'] }
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'broken',
      access: 'members',
      files: [page, bundle()],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/server_failed_to_start[\s\S]*ReferenceError: nope/)
  })

  it('secrets_missing asks the user to set them, never for the value', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'needs-key',
      access: 'members',
      files: [page, bundle(), { path: 'fling.json', content: '{"secrets":["API_KEY"]}' }],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/secrets_missing[\s\S]*fling secrets set needs-key/)
  })
})

describe('fling_read_files and fling_publish with `base` on a site with a server', () => {
  it("returns the server's fling.json, says the bundle is not the source, and a page change keeps it", async () => {
    await callTool(env, bearer, 'fling_publish', {
      name: 'tz-base',
      access: 'members',
      files: [page, bundle()],
      siteServer: { secrets: [], health: '/api/health' },
    })
    const read = await callTool(env, bearer, 'fling_read_files', { name: 'tz-base' })
    expect(read.structuredContent.server).toEqual({ secrets: [], health: '/api/health' })
    expect(read.structuredContent.files.map((f: { path: string }) => f.path)).not.toContain(
      'fling.json'
    )
    expect(read.content[0]?.text).toContain(PULLED_SERVER_NOTE)
    expect(read.content[0]?.text).toContain('not a published file')
    servers.probes = []
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'tz-base',
      base: read.structuredContent.versionId,
      files: [{ path: 'index.html', content: '<h1>changed</h1>' }],
    })
    expect(r.isError).toBeFalsy()
    expect(servers.probes.map(p => p.path)).toEqual(['/api/health'])
  })
})

describe('fling_server_template and fling_logs', () => {
  it('are there only where servers run', async () => {
    const tools = async () => {
      const r = await callTool(env, bearer, 'fling_server_template', {})
      return r
    }
    expect((await tools()).content[0]?.text).toContain(SERVER_TEMPLATE)
    env.config.servers = { ...env.config.servers, publish: { kind: 'off' } }
    expect((await tools()).isError).toBe(true)
  })

  it('fling_logs reads the request lines', async () => {
    await callTool(env, bearer, 'fling_publish', {
      name: 'logged',
      access: 'members',
      files: [page, bundle()],
    })
    const site = await env.deps.store.findSite('logged')
    await logInvoke(env.deps.serverLogs, env.deps.clock.now(), {
      siteId: site?.id as string,
      versionId: site?.currentVersionId as string,
      method: 'GET',
      path: '/api/me',
      status: 200,
      ms: 3,
      viewer: null,
    })
    const r = await callTool(env, bearer, 'fling_logs', { name: 'logged' })
    expect(r.content[0]?.text).toMatch(/GET \/api\/me {2}200 {2}3 ms/)
  })
})
