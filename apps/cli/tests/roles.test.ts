import type { SiteDetail } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { runInfo, runList, runRoles } from '../src/commands/sites.ts'
import { createMcpServer } from '../src/mcp.ts'
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

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

const members = (emails: string[], groups: string[] = []) => ({
  emails: emails.map(email => ({ email, known: true })),
  groups: groups.map(slug => ({ slug, name: slug, size: 2 })),
})

const detail = (over: Partial<SiteDetail> = {}) =>
  ({
    ...site(),
    versions: [],
    audience: { emails: [], groups: [] },
    role: 'owner',
    owners: members([ALICE]),
    publishers: members([]),
    ...over,
  }) as SiteDetail

/** A Fling with site roles holding one site: GET returns it, PATCH replaces a list. */
async function server(start: SiteDetail, capabilities: object = { siteRoles: true }, json = false) {
  let current = start
  const patches: unknown[] = []
  const m = mockFetch({
    'GET /.well-known/fling': () =>
      jsonResponse({ ...INSTANCE, capabilities: { ...INSTANCE.capabilities, ...capabilities } }),
    'GET /api/sites/my-app': () => jsonResponse(current),
    'PATCH /api/sites/my-app': (_url, init) => {
      const body = JSON.parse(String(init.body))
      patches.push(body)
      for (const which of ['owners', 'publishers'] as const) {
        if (body[which])
          current = { ...current, [which]: members(body[which].emails, body[which].groups) }
      }
      const { versions: _v, ...rest } = current
      return jsonResponse(rest)
    },
  })
  const store = await loggedInStore()
  await store.putServer(SERVER, {
    instance: { ...INSTANCE, capabilities: { ...INSTANCE.capabilities, ...capabilities } },
  })
  return { ...(await testContext({ store, fetch: m.fetch, json })), store, fetch: m.fetch, patches }
}

describe('fling owners | publishers', () => {
  it('shows both lists and the caller’s role', async () => {
    const { ctx, out, patches } = await server(detail({ publishers: members([BOB], ['design']) }))
    await runRoles(ctx, 'owners', 'my-app', {})
    expect(out.content()).toBe(
      `Owners: ${ALICE}. Publishers: ${BOB}, the group design (2 people). You are an owner.\n`
    )
    expect(patches).toEqual([])
  })

  it('sends the whole new list, keeping the other one', async () => {
    const { ctx, out, patches } = await server(detail())
    await runRoles(ctx, 'publishers', 'my-app', {
      add: [`${BOB}, carol@example.test`],
      group: ['design'],
    })
    expect(patches).toEqual([
      { publishers: { emails: [BOB, 'carol@example.test'], groups: ['design'] } },
    ])
    await runRoles(ctx, 'owners', 'my-app', { set: [BOB] })
    expect(patches.at(-1)).toEqual({ owners: { emails: [BOB], groups: [] } })
    await runRoles(ctx, 'publishers', 'my-app', { remove: [BOB], removeGroup: ['design'] })
    expect(patches.at(-1)).toEqual({ publishers: { emails: ['carol@example.test'], groups: [] } })
    expect(out.content()).toContain('Owners: bob@example.test.')
  })

  it('reports the JSON lists with --json', async () => {
    const { ctx, out } = await server(detail(), { siteRoles: true }, true)
    await runRoles(ctx, 'owners', 'my-app', {})
    expect(JSON.parse(out.content())).toMatchObject({
      name: 'my-app',
      role: 'owner',
      owners: { emails: [{ email: ALICE }] },
      publishers: { emails: [] },
    })
  })

  it('refuses on a Fling without site roles', async () => {
    const { ctx, patches } = await server(detail(), { siteRoles: false })
    expect((await captureError(runRoles(ctx, 'owners', 'my-app', { add: [BOB] }))).message).toMatch(
      /no site owners and publishers/
    )
    expect(patches).toEqual([])
  })
})

describe('roles in ls and info', () => {
  it('ls shows a ROLE column when the server reports roles', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/sites': () => jsonResponse({ sites: [site({ role: 'publisher' })] }),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runList(ctx, {})
    expect(out.content()).toMatch(/ROLE/)
    expect(out.content()).toMatch(/publisher/)
  })

  it('info shows the owners, the publishers and the caller’s role', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/sites/my-app': () =>
        jsonResponse(detail({ role: 'publisher', publishers: members([BOB]) })),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runInfo(ctx, 'my-app')
    expect(out.content()).toMatch(new RegExp(`Owners:\\s+${ALICE}`))
    expect(out.content()).toMatch(new RegExp(`Publishers:\\s+${BOB}`))
    expect(out.content()).toMatch(/You:\s+publisher/)
  })
})

describe('MCP fling_set_owners and fling_set_publishers', () => {
  async function connect(capabilities: object = { siteRoles: true }) {
    const fling = await server(detail(), capabilities)
    const instance = { ...INSTANCE, capabilities: { ...INSTANCE.capabilities, ...capabilities } }
    const mcp = createMcpServer({
      store: fling.store,
      fetch: fling.fetch,
      servers: [{ url: SERVER, instance, current: true, signedIn: true }],
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([mcp.connect(serverT), client.connect(clientT)])
    return { client, patches: fling.patches }
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''

  it('edit one list, and fling_info shows both', async () => {
    const { client, patches } = await connect()
    const added = await client.callTool({
      name: 'fling_set_publishers',
      arguments: { name: 'my-app', add: [BOB], addGroups: ['design'] },
    })
    expect(text(added)).toMatch(
      new RegExp(`^my-app: Owners: ${ALICE}\\. Publishers: ${BOB}, the group design`)
    )
    expect(patches).toEqual([{ publishers: { emails: [BOB], groups: ['design'] } }])
    await client.callTool({ name: 'fling_set_owners', arguments: { name: 'my-app', add: [BOB] } })
    expect(patches.at(-1)).toEqual({ owners: { emails: [ALICE, BOB], groups: [] } })
    const info = await client.callTool({ name: 'fling_info', arguments: { name: 'my-app' } })
    expect(text(info)).toContain('You are an owner.')
    expect(
      (await client.callTool({ name: 'fling_set_owners', arguments: { name: 'my-app' } })).isError
    ).toBe(true)
  })

  it('refuse on a Fling without site roles', async () => {
    const { client, patches } = await connect({ siteRoles: false })
    const res = await client.callTool({
      name: 'fling_set_owners',
      arguments: { name: 'my-app', add: [BOB] },
    })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/no site owners and publishers/)
    expect(patches).toEqual([])
  })
})
