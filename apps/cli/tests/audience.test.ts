import type { SiteDetail } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { runAccess, runInfo } from '../src/commands/sites.ts'
import { createMcpServer } from '../src/mcp.ts'
import { audiencesEnabled } from '../src/sites.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  site,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const MEMBERS = 'anyone signed in to Example Fling (@example.test accounts)'

const detail = (emails: { email: string; known: boolean }[], over: Partial<SiteDetail> = {}) =>
  ({
    ...site({ restricted: emails.length > 0, audienceSize: emails.length }),
    versions: [],
    audience: { emails, groups: [] },
    ...over,
  }) as SiteDetail

/** A server holding one site's audience: GET returns it, PATCH replaces it. */
function server(start: SiteDetail) {
  let current = start
  const patches: unknown[] = []
  const m = mockFetch({
    'GET /api/sites/my-app': () => jsonResponse(current),
    'PATCH /api/sites/my-app': (_url, init) => {
      const body = JSON.parse(String(init.body))
      patches.push(body)
      const emails = body.audience.emails.map((email: string) => ({
        email,
        known: email !== 'new@example.test',
      }))
      current = {
        ...current,
        audience: { emails, groups: body.audience.groups },
        audienceSize: emails.length,
        restricted: current.visibility === 'private' && emails.length > 0,
      }
      const { versions: _v, ...rest } = current
      return jsonResponse(rest)
    },
  })
  return { ...m, patches }
}

describe('fling access --only-me | --members | --public', () => {
  async function withLevels(response: object) {
    const store = await loggedInStore()
    await store.putServer(SERVER, {
      instance: { ...INSTANCE, capabilities: { ...INSTANCE.capabilities, accessLevels: true } },
    })
    const patches: unknown[] = []
    const m = mockFetch({
      'PATCH /api/sites/my-app': (_url, init) => {
        patches.push(JSON.parse(String(init.body)))
        return jsonResponse({ ...site(), audience: { emails: [], groups: [] }, ...response })
      },
    })
    return { ...(await testContext({ store, fetch: m.fetch })), patches }
  }

  it('sets the level', async () => {
    const mine = await withLevels({ access: 'only_me', restricted: true })
    await runAccess(mine.ctx, 'my-app', { onlyMe: true })
    expect(mine.patches).toEqual([{ access: 'only_me' }])
    expect(mine.out.content()).toBe('Only you: nobody else can open it.\n')
    const all = await withLevels({ access: 'members' })
    await runAccess(all.ctx, 'my-app', { members: true })
    expect(all.patches).toEqual([{ access: 'members' }])
    expect(all.out.content()).toBe(`Private: ${MEMBERS} can open it.\n`)
  })

  it('refuses a level with people, or two levels', async () => {
    const { ctx, patches } = await withLevels({})
    expect(
      (await captureError(runAccess(ctx, 'my-app', { onlyMe: true, add: ['bob@example.test'] })))
        .message
    ).toMatch(/lets no one else in/)
    expect(
      (await captureError(runAccess(ctx, 'my-app', { onlyMe: true, public: true }))).message
    ).toMatch(/one of/)
    expect(patches).toEqual([])
  })

  it('refuses on a Fling without access levels (it would ignore the change)', async () => {
    const store = await loggedInStore()
    const m = mockFetch({ 'GET /.well-known/fling': () => jsonResponse(INSTANCE) })
    const { ctx } = await testContext({ store, fetch: m.fetch })
    expect((await captureError(runAccess(ctx, 'my-app', { onlyMe: true }))).message).toMatch(
      /has no access levels yet/
    )
  })
})

describe('fling access', () => {
  it('shows who can open the site', async () => {
    const store = await loggedInStore()
    const s = server(detail([]))
    const { ctx, out } = await testContext({ store, fetch: s.fetch })
    await runAccess(ctx, 'my-app', {})
    expect(out.content()).toBe(`Private: ${MEMBERS} can open it.\n`)
    expect(s.patches).toEqual([])
  })

  it('adds (comma-separated or repeated), removes and clears, keeping the groups', async () => {
    const store = await loggedInStore()
    const s = server(detail([{ email: 'bob@example.test', known: true }]))
    const { ctx, out } = await testContext({ store, fetch: s.fetch })
    await runAccess(ctx, 'my-app', { add: ['New@example.test,carol@example.test'] })
    expect(s.patches.at(-1)).toEqual({
      audience: {
        emails: ['bob@example.test', 'new@example.test', 'carol@example.test'],
        groups: [],
      },
    })
    expect(out.content()).toBe(
      "Restricted: only you and 3 people can open it: bob@example.test, new@example.test (hasn't signed in yet), carol@example.test.\n"
    )
    await runAccess(ctx, 'my-app', { remove: ['bob@example.test', 'carol@example.test'] })
    expect(s.patches.at(-1)).toEqual({ audience: { emails: ['new@example.test'], groups: [] } })
    await runAccess(ctx, 'my-app', { clear: true })
    expect(s.patches.at(-1)).toEqual({ audience: { emails: [], groups: [] } })
  })

  it('--json prints the site with its audience and warnings: a share link on a restricted site', async () => {
    const store = await loggedInStore()
    const shareUrl = 'https://s--abc.sites.example.test/'
    const s = server(detail([], { shareUrl }))
    const { ctx, out, log } = await testContext({ store, fetch: s.fetch, json: true })
    await runAccess(ctx, 'my-app', { add: ['bob@example.test'] })
    const json = JSON.parse(out.content())
    expect(json).toMatchObject({
      name: 'my-app',
      restricted: true,
      audienceSize: 1,
      shareUrl,
      audience: { emails: [{ email: 'bob@example.test', known: true }], groups: [] },
    })
    expect(json.warnings).toEqual([
      'my-app has a share link: anyone with it can still open the site',
    ])
    expect(log.lines.join('\n')).toContain('anyone with it can still open the site')
  })

  it('warns that an audience does not apply while the site is public', async () => {
    const store = await loggedInStore()
    const s = server(detail([], { visibility: 'public' }))
    const { ctx, log } = await testContext({ store, fetch: s.fetch })
    await runAccess(ctx, 'my-app', { add: ['bob@example.test'] })
    expect(log.lines.join('\n')).toContain('fling visibility my-app private')
  })

  it("refuses on an instance without audiences, and on a server that doesn't report one", async () => {
    const off = await loggedInStore()
    await off.putServer(SERVER, {
      instance: { ...INSTANCE, capabilities: { audiences: false } },
    })
    const { ctx } = await testContext({ store: off, fetch: server(detail([])).fetch })
    expect((await captureError(runAccess(ctx, 'my-app', {}))).message).toBe(
      "Example Fling can't limit a site to listed people"
    )

    const store = await loggedInStore()
    const { audience: _a, ...old } = detail([])
    const m = mockFetch({ 'GET /api/sites/my-app': () => jsonResponse(old) })
    const { ctx: ctx2 } = await testContext({ store, fetch: m.fetch })
    expect((await captureError(runAccess(ctx2, 'my-app', {}))).message).toMatch(
      /does not support limiting a site/
    )
  })

  it('fling info shows the access line', async () => {
    const store = await loggedInStore()
    const s = server(detail([{ email: 'bob@example.test', known: true }]))
    const { ctx, out } = await testContext({ store, fetch: s.fetch })
    await runInfo(ctx, 'my-app')
    expect(out.content()).toContain(
      'Restricted: only you and 1 person can open it: bob@example.test.'
    )
  })

  it('audiencesEnabled: the capability; a copy from before the flag defers to the server', () => {
    expect(audiencesEnabled({ capabilities: { audiences: true } })).toBe(true)
    expect(audiencesEnabled({ capabilities: { audiences: false } })).toBe(false)
    expect(audiencesEnabled({ capabilities: {} })).toBe(true)
    expect(audiencesEnabled(null)).toBe(false)
  })
})

describe('MCP fling_set_audience', () => {
  async function connect(instance: typeof INSTANCE | null, fetchImpl = mockFetch({}).fetch) {
    const store = await loggedInStore()
    const servers = instance ? [{ url: SERVER, instance, current: true, signedIn: true }] : []
    const mcp = createMcpServer({ store, fetch: fetchImpl, servers })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([mcp.connect(serverT), client.connect(clientT)])
    return client
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
  const offered = async (client: Client) =>
    (await client.listTools()).tools.some(t => t.name === 'fling_set_audience')

  it('is offered only where the instance has audiences', async () => {
    expect(await offered(await connect({ ...INSTANCE, capabilities: { audiences: true } }))).toBe(
      true
    )
    expect(await offered(await connect({ ...INSTANCE, capabilities: { audiences: false } }))).toBe(
      false
    )
    expect(await offered(await connect(null))).toBe(false)
  })

  it('adds, removes and sets, and fling_info shows the audience', async () => {
    const s = server(detail([]))
    const client = await connect({ ...INSTANCE, capabilities: { audiences: true } }, s.fetch)
    const call = (args: object) =>
      client.callTool({ name: 'fling_set_audience', arguments: { name: 'my-app', ...args } })
    const added = await call({ add: ['bob@example.test', 'new@example.test'] })
    expect(text(added)).toMatch(
      /^my-app: Restricted: only you and 2 people can open it: bob@example\.test, new@example\.test \(hasn't signed in yet\)\./
    )
    await call({ remove: ['new@example.test'] })
    expect(s.patches.at(-1)).toEqual({ audience: { emails: ['bob@example.test'], groups: [] } })
    await call({ set: ['carol@example.test'] })
    expect(s.patches.at(-1)).toEqual({ audience: { emails: ['carol@example.test'], groups: [] } })
    const info = await client.callTool({ name: 'fling_info', arguments: { name: 'my-app' } })
    expect(text(info)).toContain('Restricted: only you and 1 person can open it')
    const none = await call({})
    expect(none.isError).toBe(true)
  })
})
