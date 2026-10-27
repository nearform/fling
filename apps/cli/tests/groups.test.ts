import type { GroupDetail, SiteDetail } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runGroupCreate,
  runGroupDelete,
  runGroupMembers,
  runGroupShow,
  runGroups,
} from '../src/commands/groups.ts'
import { runAccess } from '../src/commands/sites.ts'
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

const ME = {
  email: 'me@example.test',
  name: 'Me',
  picture: null,
  userSlug: 'me',
  admin: false,
}

const design = (over: Partial<GroupDetail> = {}): GroupDetail => ({
  slug: 'design',
  name: 'Design team',
  owner: 'bob@example.test',
  size: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  members: [{ email: 'carol@example.test', known: false }],
  canManage: false,
  ...over,
})

/** A server with one group the caller doesn't own, and one site. */
function server() {
  const bodies: { method: string; path: string; body: unknown }[] = []
  const record = (method: string, path: string, init: RequestInit) =>
    bodies.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined })
  let audience: SiteDetail['audience'] = { emails: [], groups: [] }
  const m = mockFetch({
    'GET /api/me': () => jsonResponse(ME),
    'GET /api/groups': () =>
      jsonResponse({
        groups: [
          { ...design(), members: undefined, canManage: undefined },
          {
            ...design({ slug: 'ops', name: 'Ops', owner: ME.email, size: 0 }),
            members: undefined,
          },
        ],
      }),
    'GET /api/groups/design': () => jsonResponse(design()),
    'POST /api/groups': (_url, init) => {
      record('POST', '/api/groups', init)
      const body = JSON.parse(String(init.body))
      return jsonResponse(
        design({
          slug: body.slug,
          name: body.name,
          owner: ME.email,
          canManage: true,
          size: body.members.length,
          members: body.members.map((email: string) => ({ email, known: true })),
        }),
        201
      )
    },
    'POST /api/groups/design/members': (_url, init) => {
      record('POST', '/api/groups/design/members', init)
      return jsonResponse(
        {
          error: {
            code: 'forbidden',
            message: 'Only its owner can change the group (bob@example.test)',
          },
        },
        403
      )
    },
    'DELETE /api/groups/ops': () => new Response(null, { status: 204 }),
    'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [], audience }),
    'PATCH /api/sites/my-app': (_url, init) => {
      record('PATCH', '/api/sites/my-app', init)
      const body = JSON.parse(String(init.body))
      audience = {
        emails: [],
        groups: body.audience.groups.map((slug: string) => ({
          slug,
          name: 'Design team',
          size: 1,
        })),
      }
      return jsonResponse({
        ...site({ restricted: true, audienceSize: 1, audienceGroups: 1 }),
        audience,
      })
    },
  })
  return { ...m, bodies }
}

describe('fling groups', () => {
  it('lists every group, the caller’s own as "you"', async () => {
    const s = server()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch: s.fetch })
    await runGroups(ctx, {})
    expect(out.content()).toMatch(/design\s+Design team\s+1\s+bob@example\.test/)
    expect(out.content()).toMatch(/ops\s+Ops\s+0\s+you/)
  })

  it('shows a group with its members; creates one with members', async () => {
    const s = server()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch: s.fetch })
    await runGroupShow(ctx, 'design')
    expect(out.content()).toContain('owned by bob@example.test (only they can change it)')
    expect(out.content()).toContain("carol@example.test (hasn't signed in yet)")
    await runGroupCreate(ctx, 'team', { add: ['A@example.test, b@example.test'] })
    expect(s.bodies.at(-1)?.body).toEqual({
      slug: 'team',
      name: 'team',
      members: ['a@example.test', 'b@example.test'],
    })
  })

  it("someone else's group: changing members fails with the server's refusal (exit 3)", async () => {
    const s = server()
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: s.fetch })
    const err = await captureError(runGroupMembers(ctx, 'design', ['x@example.test'], 'add'))
    expect(err.message).toContain('Only its owner')
    expect((err as { exitCode?: number }).exitCode).toBe(3)
  })

  it('delete needs --yes without a terminal', async () => {
    const s = server()
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: s.fetch })
    const err = await captureError(runGroupDelete(ctx, 'ops', {}))
    expect(err.message).toContain('without confirmation')
    await runGroupDelete(ctx, 'ops', { yes: true })
  })
})

describe('fling access --group', () => {
  it('adds and removes groups by slug, keeping the addresses', async () => {
    const s = server()
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch: s.fetch })
    await runAccess(ctx, 'my-app', { group: ['Design'] })
    expect(s.bodies.at(-1)?.body).toEqual({ audience: { emails: [], groups: ['design'] } })
    expect(out.content()).toContain(
      'Restricted: only you and the group design (Design team, 1 person) can open it.'
    )
    await runAccess(ctx, 'my-app', { removeGroup: ['design'] })
    expect(s.bodies.at(-1)?.body).toEqual({ audience: { emails: [], groups: [] } })
  })
})

describe('MCP group tools', () => {
  async function connect(capabilities: Record<string, boolean>, fetchImpl = server().fetch) {
    const store = await loggedInStore()
    const servers = [
      { url: SERVER, instance: { ...INSTANCE, capabilities }, current: true, signedIn: true },
    ]
    const mcp = createMcpServer({ store, fetch: fetchImpl, servers })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([mcp.connect(serverT), client.connect(clientT)])
    return client
  }
  const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name)

  it('are offered only where the instance has groups', async () => {
    expect(await names(await connect({ groups: true }))).toContain('fling_group_create')
    expect(await names(await connect({ groups: false }))).not.toContain('fling_groups')
  })

  it('fling_groups lists them and fling_set_audience takes groups', async () => {
    const client = await connect({ groups: true, audiences: true })
    const list = await client.callTool({ name: 'fling_groups', arguments: {} })
    const text = (list as { content: { text: string }[] }).content[0]?.text ?? ''
    expect(text).toContain('design (Design team, 1 person), owned by bob@example.test')
    expect(text).toContain('ops (Ops, 0 people), owned by you')
    const set = await client.callTool({
      name: 'fling_set_audience',
      arguments: { name: 'my-app', addGroups: ['design'] },
    })
    expect(set.isError).toBeFalsy()
  })
})
