/**
 * Site servers in the core: admission, the server mark and the route flag, the start probe, site
 * secrets, the request log and viewer ids, the kill switch, and policy. The platform is a fake
 * SiteServers that records what it was asked; the adapters' own behaviour is in
 * packages/conformance.
 */
import { SITE_SECRETS_MAX, siteKvsKey } from '@fling/shared'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import { publishBytes } from '../src/publication.ts'
import { logInvoke, viewerIdFor } from '../src/servers/logs.ts'
import { MemoryServerLogs } from '../src/servers/memory-logs.ts'
import { openSecret, sealSecret } from '../src/servers/secrets.ts'
import type {
  ProbeRequest,
  ProbeResult,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '../src/servers/types.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const BOSS = 'boss@example.test'

class FakeServers implements SiteServers {
  calls: string[] = []
  probes: ProbeRequest[] = []
  options = new Map<string, ServerOptions>()
  answer: ProbeResult = { ok: true, status: 200, logs: [] }
  async activate(_site: ServerSite, v: ServerVersion, opts: ServerOptions) {
    this.calls.push(`activate ${v.id}`)
    this.options.set(v.id, opts)
    return { target: 'fn-1.servers.example.test' }
  }
  async probe(_site: ServerSite, v: ServerVersion, request: ProbeRequest) {
    this.calls.push(`probe ${v.id}`)
    this.probes.push(request)
    return this.answer
  }
  async reconfigure(_site: ServerSite, v: ServerVersion, opts: ServerOptions) {
    this.calls.push(`reconfigure ${v.id}`)
    this.options.set(v.id, opts)
    return { target: 'fn-1.servers.example.test' }
  }
  async setEnabled(site: ServerSite, enabled: boolean) {
    this.calls.push(`enabled ${site.name} ${enabled}`)
  }
  async retire(site: ServerSite, v?: ServerVersion) {
    this.calls.push(`retire ${site.name}${v ? ` ${v.id}` : ''}`)
  }
  async invoke() {
    return new Response('ok')
  }
}

const FETCH_SERVER =
  'import{createHash as h}from"node:crypto";export default{fetch(r){return new Response(h("sha256").update("x").digest("hex"))}}'

let env: Env
let servers: FakeServers
let info: MockInstance

function start(
  overrides: Partial<Config> = {},
  publish: Config['servers']['publish'] = { kind: 'members' }
) {
  env = setup({ adminEmails: [BOSS], ...overrides })
  env.config.servers = { ...env.config.servers, publish, ...overrides.servers }
  servers = new FakeServers()
  env.deps.servers = servers
  env.deps.serverLogs = new MemoryServerLogs(() => env.deps.clock.now())
}

beforeEach(() => {
  start()
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => info.mockRestore())

type Files = ReturnType<typeof file>[]
const site = (server = FETCH_SERVER, extra: Files = []): Files => [
  file('index.html', '<h1>hi</h1>'),
  file('_fling/server.mjs', server, 'text/javascript'),
  ...extra,
]

/** Stage, upload and finalize: the finalize response (or the stage's, when it refuses). */
async function deploy(key: string, name: string, files: Files, body: Record<string, unknown> = {}) {
  const staged = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...body,
  })
  const res = await json(staged.clone())
  if (staged.status !== 200 || res.status !== 'upload') return staged
  await upload(env, res.uploads, files)
  return api(env, key, 'POST', `/api/sites/${name}/deploys/${res.versionId}/finalize`)
}

const route = async (name: string) =>
  JSON.parse((await env.routeTable.get(siteKvsKey(name))) ?? 'null')

describe('the capability', () => {
  it('is off by default, and on with SERVERS', async () => {
    const off = setup()
    const meta = await json(await off.app.request('/.well-known/fling'))
    expect(meta.capabilities.servers).toBe(false)
    expect(meta.capabilities.serversEgress).toBe(false)
    const on = await json(await env.app.request('/.well-known/fling'))
    expect(on.capabilities.servers).toBe(true)
    expect(on.capabilities.serversEgress).toBe(false)
  })

  it('refuses a server where the instance runs none, and the routes are not there', async () => {
    env = setup()
    const alice = await createUser(env, ALICE)
    const res = await deploy(alice.key, 'srv', site())
    expect(res.status).toBe(403)
    expect((await json(res)).error.code).toBe('servers_not_allowed')
    expect((await api(env, alice.key, 'GET', '/api/sites/srv/secrets')).status).toBe(404)
  })
})

describe('who may publish one', () => {
  it('admins only: a member is refused, an admin publishes', async () => {
    start({}, { kind: 'admins' })
    const alice = await createUser(env, ALICE)
    expect((await json(await deploy(alice.key, 'srv', site()))).error.code).toBe(
      'servers_not_allowed'
    )
    const boss = await createUser(env, BOSS)
    expect((await deploy(boss.key, 'boss-srv', site())).status).toBe(200)
  })

  it('members of the groups SERVERS names', async () => {
    start({}, { kind: 'groups', slugs: ['builders'] })
    const alice = await createUser(env, ALICE)
    const bob = await createUser(env, BOB)
    await api(env, alice.key, 'POST', '/api/groups', {
      name: 'Builders',
      slug: 'builders',
      members: [ALICE],
    })
    expect((await json(await deploy(bob.key, 'bob-srv', site()))).error.code).toBe(
      'servers_not_allowed'
    )
    const res = await deploy(alice.key, 'alice-srv', site())
    expect(res.status, await res.clone().text()).toBe(200)
  })
})

describe('admission', () => {
  it('marks the version, flags the route, starts the server and audits it', async () => {
    const alice = await createUser(env, ALICE)
    const res = await deploy(alice.key, 'srv', site())
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.site.hasServer).toBe(true)
    expect(await route('srv')).toMatchObject({ f: 1, t: 'fn-1.servers.example.test' })
    expect(servers.calls).toEqual([`activate ${body.versionId}`, `probe ${body.versionId}`])
    expect(servers.probes[0]).toMatchObject({ method: 'GET', path: '/api/' })
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/srv'))
    expect(detail.versions[0].server).toBe(true)
    const audit = await env.store.listAuditEntries(10)
    expect(audit.find(e => e.action === 'site.server_published')).toMatchObject({
      actor: ALICE,
      target: 'srv',
      change: body.versionId,
    })
  })

  it('leaves /api/ an ordinary folder on a site without a server', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'plain', [file('index.html', 'x'), file('api/data.json', '{}')])
    const value = await route('plain')
    expect(value.f).toBeUndefined()
    expect(servers.calls).toEqual([])
  })

  it('refuses a bundle with imports it should have inlined: 400 server_not_bundled', async () => {
    const alice = await createUser(env, ALICE)
    const res = await deploy(
      alice.key,
      'srv',
      site('import{Hono}from"hono";export default new Hono()')
    )
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error.code).toBe('server_not_bundled')
    expect(body.error.imports).toEqual(['hono'])
    expect(await route('srv')).toBeNull()
  })

  it('refuses a server inline before anything is written, too', async () => {
    const alice = await createUser(env, ALICE)
    const user = (await env.store.getUser(ALICE)) as NonNullable<
      Awaited<ReturnType<typeof env.store.getUser>>
    >
    const enc = (s: string) => new TextEncoder().encode(s)
    await expect(
      publishBytes(
        env.deps,
        user,
        'inline',
        [
          { path: 'index.html', bytes: enc('x') },
          { path: '_fling/server.mjs', bytes: enc('import x from "lodash"') },
        ],
        { principal: { email: ALICE, admin: false, via: 'api_key', guest: false } }
      )
    ).rejects.toMatchObject({ code: 'server_not_bundled' })
    expect(await env.store.findSite('inline')).toBeNull()
    void alice
  })

  it('refuses a bundle over 5 MB: 413', async () => {
    const alice = await createUser(env, ALICE)
    const big = {
      ...file('_fling/server.mjs', 'x'),
      meta: { ...file('_fling/server.mjs', 'x').meta, size: 6 * 1024 * 1024 },
    }
    const res = await deploy(alice.key, 'srv', [file('index.html', 'x'), big])
    expect(res.status).toBe(413)
  })

  it('refuses _fling/ in a Path publish: 400 server_on_path', async () => {
    const alice = await createUser(env, ALICE)
    const res = await deploy(
      alice.key,
      'team',
      [file('PAY/index.html', 'x'), file('PAY/_fling/server.mjs', FETCH_SERVER)],
      {
        path: 'PAY',
      }
    )
    expect(res.status).toBe(400)
    expect((await json(res)).error.code).toBe('server_on_path')
  })

  it('keeps api for the server: no server beside an api Path, no api Path beside a server', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'team', [file('api/index.html', 'x')], { path: 'api' })
    const res = await deploy(alice.key, 'team', site())
    expect((await json(res)).error.code).toBe('path_conflict')

    await deploy(alice.key, 'srv', site())
    const path = await deploy(alice.key, 'srv', [file('api/index.html', 'x')], { path: 'api' })
    expect((await json(path)).error.code).toBe('path_conflict')
  })

  it('asks before a server goes live on a public site: 409 public_server, then confirmPublicServer', async () => {
    const alice = await createUser(env, ALICE)
    const refused = await deploy(alice.key, 'srv', site(), { access: 'public' })
    expect(refused.status).toBe(409)
    expect((await json(refused)).error.code).toBe('public_server')
    const ok = await deploy(alice.key, 'srv', site(), {
      access: 'public',
      confirmPublicServer: true,
    })
    expect(ok.status).toBe(200)
    // A public site whose live version has a server already needs no new confirmation.
    const again = await deploy(alice.key, 'srv', site(`${FETCH_SERVER}//2`))
    expect(again.status).toBe(200)
  })

  it('asks before a site with a live server is made public', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'srv', site())
    const refused = await api(env, alice.key, 'PATCH', '/api/sites/srv', { access: 'public' })
    expect((await json(refused)).error.code).toBe('public_server')
    const ok = await api(env, alice.key, 'PATCH', '/api/sites/srv', {
      access: 'public',
      confirmPublicServer: true,
    })
    expect(ok.status).toBe(200)
  })

  it('caps the sites with a server at SERVERS_MAX_SITES', async () => {
    env.config.servers.maxSites = 1
    const alice = await createUser(env, ALICE)
    expect((await deploy(alice.key, 'one', site())).status).toBe(200)
    // The site that has one may publish it again.
    expect((await deploy(alice.key, 'one', site(`${FETCH_SERVER}//2`))).status).toBe(200)
    const res = await deploy(alice.key, 'two', site())
    expect((await json(res)).error.code).toBe('too_many_servers')
    // A version without a server frees the room.
    await deploy(alice.key, 'one', [file('index.html', 'static now')])
    expect((await deploy(alice.key, 'two', site())).status).toBe(200)
  })
})

describe('the start probe', () => {
  it("needs a 2xx from fling.json's health path, else 422 with the server's log", async () => {
    const alice = await createUser(env, ALICE)
    servers.answer = { ok: true, status: 503, logs: ['booting', 'SLACK_WEBHOOK_URL is wrong'] }
    const res = await deploy(alice.key, 'srv', site(), { server: { health: '/api/health' } })
    expect(res.status).toBe(422)
    const body = await json(res)
    expect(body.error.code).toBe('server_failed_to_start')
    expect(body.error.logs).toEqual(['booting', 'SLACK_WEBHOOK_URL is wrong'])
    expect(body.error.message).toContain('SLACK_WEBHOOK_URL is wrong')
    expect(servers.probes[0]?.path).toBe('/api/health')
    expect(await route('srv')).toBeNull()
    // The version stays pending: finalizing again, once the server answers, makes it live.
    servers.answer = { ok: true, status: 200, logs: [] }
    const versionId = body.error.message.match(/version (\w+)/)[1]
    const again = await api(env, alice.key, 'POST', `/api/sites/srv/deploys/${versionId}/finalize`)
    expect(again.status).toBe(200)
  })

  it('takes any answer without a health path, and none at all as a failure', async () => {
    const alice = await createUser(env, ALICE)
    servers.answer = { ok: true, status: 404, logs: [] }
    expect((await deploy(alice.key, 'srv', site())).status).toBe(200)
    servers.answer = { ok: false, error: 'no answer in 10 s', logs: [] }
    const res = await deploy(alice.key, 'srv', site(`${FETCH_SERVER}//2`))
    expect(res.status).toBe(422)
    expect(await route('srv')).toMatchObject({ f: 1 })
  })
})

describe('site secrets', () => {
  it('are refused until set, reach the server, and are never returned', async () => {
    const alice = await createUser(env, ALICE)
    const fling = { server: { secrets: ['SLACK_WEBHOOK_URL'] } }
    const missing = await deploy(alice.key, 'srv', site(), fling)
    expect(missing.status).toBe(409)
    expect(await json(missing)).toMatchObject({
      error: { code: 'secrets_missing', secrets: ['SLACK_WEBHOOK_URL'] },
    })
    // Not live yet, but its owner may set them.
    const set = await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/SLACK_WEBHOOK_URL', {
      value: 'https://hooks.slack.com/services/T/B/X',
    })
    expect(set.status).toBe(200)
    expect(await json(set)).toEqual({
      name: 'SLACK_WEBHOOK_URL',
      setBy: ALICE,
      setAt: env.deps.clock.now().toISOString(),
    })
    const live = await json(await deploy(alice.key, 'srv', site(), fling))
    expect(servers.options.get(live.versionId)?.secrets).toEqual({
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
    })
    const listed = await api(env, alice.key, 'GET', '/api/sites/srv/secrets')
    const text = await listed.text()
    expect(text).not.toContain('hooks.slack.com')
    expect(JSON.parse(text)).toMatchObject({
      secrets: [{ name: 'SLACK_WEBHOOK_URL', setBy: ALICE }],
      declared: ['SLACK_WEBHOOK_URL'],
      missing: [],
    })
  })

  it('only those the version declares reach it, and a change reconfigures the live one', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'srv', [file('index.html', 'static')])
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/OTHER', { value: 'o' })
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/KEY', { value: 'one' })
    const live = await json(
      await deploy(alice.key, 'srv', site(), { server: { secrets: ['KEY'] } })
    )
    expect(servers.options.get(live.versionId)?.secrets).toEqual({ KEY: 'one' })
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/KEY', { value: 'two' })
    expect(servers.calls).toContain(`reconfigure ${live.versionId}`)
    expect(servers.options.get(live.versionId)?.secrets).toEqual({ KEY: 'two' })
  })

  it('a rollback to a version whose secrets are not set is 409 secrets_missing', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'srv', [file('index.html', 'static')])
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/KEY', { value: 'k' })
    const first = await json(
      await deploy(alice.key, 'srv', site(), { server: { secrets: ['KEY'] } })
    )
    await deploy(alice.key, 'srv', [file('index.html', 'static')])
    expect((await route('srv')).f).toBeUndefined()
    await api(env, alice.key, 'DELETE', '/api/sites/srv/secrets/KEY')
    const res = await api(env, alice.key, 'POST', '/api/sites/srv/current', {
      versionId: first.versionId,
    })
    expect(res.status, await res.clone().text()).toBe(409)
    expect((await json(res)).error.code).toBe('secrets_missing')
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/KEY', { value: 'k2' })
    const ok = await api(env, alice.key, 'POST', '/api/sites/srv/current', {
      versionId: first.versionId,
    })
    expect(ok.status).toBe(200)
    expect((await json(ok)).hasServer).toBe(true)
    expect(await route('srv')).toMatchObject({ f: 1 })
  })

  it('checks names, sizes and the count', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'srv', site())
    const bad = await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/lower', { value: 'x' })
    expect((await json(bad)).error.code).toBe('invalid_secret_name')
    const big = await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/BIG', {
      value: 'x'.repeat(8 * 1024 + 1),
    })
    expect(big.status).toBe(413)
    for (let i = 0; i < SITE_SECRETS_MAX; i++) {
      const res = await api(env, alice.key, 'PUT', `/api/sites/srv/secrets/S${i}`, { value: 'v' })
      expect(res.status).toBe(200)
    }
    const over = await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/ONE_MORE', { value: 'v' })
    expect((await json(over)).error.code).toBe('too_many_secrets')
    // Replacing one is not a new one.
    expect(
      (await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/S0', { value: 'w' })).status
    ).toBe(200)
    expect((await api(env, alice.key, 'DELETE', '/api/sites/srv/secrets/NOPE')).status).toBe(404)
  })

  it("are the owners' and publishers', not a member's nor a Path publisher's", async () => {
    const alice = await createUser(env, ALICE)
    const bob = await createUser(env, BOB)
    const carol = await createUser(env, 'carol@example.test')
    await deploy(alice.key, 'srv', site())
    await api(env, alice.key, 'PATCH', '/api/sites/srv', { access: 'members' })
    expect((await api(env, bob.key, 'GET', '/api/sites/srv/secrets')).status).toBe(404)
    await api(env, alice.key, 'PATCH', '/api/sites/srv', { publishers: { emails: [BOB] } })
    expect((await api(env, bob.key, 'GET', '/api/sites/srv/secrets')).status).toBe(200)
    // Carol publishes a Path of her own on the site: she holds no role on the site itself.
    await api(env, alice.key, 'PATCH', '/api/sites/srv', {
      publishers: { emails: [BOB, 'carol@example.test'] },
    })
    await deploy(carol.key, 'srv', [file('PAY/index.html', 'x')], { path: 'PAY' })
    await api(env, alice.key, 'PATCH', '/api/sites/srv', { publishers: { emails: [BOB] } })
    expect((await api(env, carol.key, 'GET', '/api/sites/srv/secrets')).status).toBe(404)
  })

  it('are sealed for one site and name', () => {
    const sealed = sealSecret(env.deps, 'S1', 'KEY', 'value')
    expect(sealed).not.toContain('value')
    expect(openSecret(env.deps, 'S1', 'KEY', sealed)).toBe('value')
    expect(openSecret(env.deps, 'S2', 'KEY', sealed)).toBeNull()
    expect(openSecret(env.deps, 'S1', 'OTHER', sealed)).toBeNull()
    const other = {
      config: { ...env.config, secrets: { ...env.config.secrets, sessionSecret: 'z'.repeat(40) } },
    }
    expect(openSecret(other, 'S1', 'KEY', sealed)).toBeNull()
  })
})

describe('logs and viewer ids', () => {
  it("read the request log by the site's owners, by viewer id", async () => {
    const alice = await createUser(env, ALICE)
    const bob = await createUser(env, BOB)
    const { versionId } = await json(await deploy(alice.key, 'srv', site()))
    const record = await env.store.findSite('srv')
    const id = viewerIdFor(env.deps, record?.id as string, BOB)
    await logInvoke(env.deps.serverLogs ?? undefined, env.deps.clock.now(), {
      siteId: record?.id as string,
      versionId,
      method: 'POST',
      path: '/api/request',
      status: 200,
      ms: 41,
      viewer: { id, email: BOB, guest: false },
    })
    const res = await json(await api(env, alice.key, 'GET', '/api/sites/srv/logs?since=1h'))
    expect(res.lines).toEqual([
      expect.objectContaining({ kind: 'request', path: '/api/request', viewer: id, versionId }),
    ])
    expect(JSON.stringify(res)).not.toContain(BOB)
    expect((await api(env, bob.key, 'GET', '/api/sites/srv/logs')).status).toBe(404)
  })

  it('an admin resolves a viewer id, on the record', async () => {
    const alice = await createUser(env, ALICE)
    await createUser(env, BOB)
    const boss = await createUser(env, BOSS)
    await deploy(alice.key, 'srv', site())
    const record = await env.store.findSite('srv')
    const id = viewerIdFor(env.deps, record?.id as string, BOB)
    const res = await api(env, boss.key, 'POST', '/api/admin/sites/srv/viewers/resolve', { id })
    expect(await json(res)).toEqual({ id, email: BOB })
    const audit = await env.store.listAuditEntries(10)
    expect(audit.find(e => e.action === 'viewer.resolved')).toMatchObject({
      actor: BOSS,
      target: 'srv',
      change: id,
    })
    const refused = await api(env, alice.key, 'POST', '/api/admin/sites/srv/viewers/resolve', {
      id,
    })
    expect(refused.status).toBe(404)
  })
})

describe('the kill switch', () => {
  const browser = (session: string, method: string, path: string, body: unknown) =>
    env.app.request(path, {
      method,
      headers: {
        cookie: `${SESSION}=${session}`,
        origin: APP_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  it("stops a site's server from an admin's browser session: the route says x", async () => {
    const alice = await createUser(env, ALICE)
    const boss = await createUser(env, BOSS)
    await deploy(alice.key, 'srv', site())
    expect(
      (await api(env, boss.key, 'PUT', '/api/admin/sites/srv/server', { stopped: true })).status
    ).toBe(404)
    expect(
      (await api(env, alice.key, 'PUT', '/api/admin/sites/srv/server', { stopped: true })).status
    ).toBe(404)
    const res = await browser(boss.session, 'PUT', '/api/admin/sites/srv/server', {
      stopped: true,
      limits: { timeoutSeconds: 120 },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ stopped: true, limits: { timeoutSeconds: 120 } })
    expect(await route('srv')).toMatchObject({ f: 1, x: 1 })
    expect(servers.calls).toContain('enabled srv false')
    const audit = await env.store.listAuditEntries(10)
    expect(audit.find(e => e.action === 'site.change')).toMatchObject({ change: 'site.server' })
    await browser(boss.session, 'PUT', '/api/admin/sites/srv/server', { stopped: false })
    expect((await route('srv')).x).toBeUndefined()
  })

  it('archiving takes the server dark, deleting retires it', async () => {
    const alice = await createUser(env, ALICE)
    await deploy(alice.key, 'srv', site())
    await api(env, alice.key, 'POST', '/api/sites/srv/archive')
    expect(servers.calls).toContain('enabled srv false')
    await api(env, alice.key, 'POST', '/api/sites/srv/unarchive')
    expect(servers.calls).toContain('enabled srv true')
    await api(env, alice.key, 'DELETE', '/api/sites/srv')
    expect(servers.calls).toContain('retire srv')
    expect((await env.store.serverSites('')).count).toBe(0)
  })
})
