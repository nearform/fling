/**
 * The archive policy from the CLI and the local MCP against a mocked Fling: `fling keep` (and who
 * may), what `fling info` and fling_info say of a site, `fling admin archive-policy` and
 * fling_admin_archive_policy (admins only, read only, ending with the link to switch it).
 */
import type { ArchivePolicyStatus, InstanceMetadata, SiteDetail } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import { runAdminArchivePolicy } from '../src/commands/admin.ts'
import { runInfo, runKeep } from '../src/commands/sites.ts'
import { EXIT_FORBIDDEN } from '../src/errors.ts'
import { createMcpServer } from '../src/mcp.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  mockFetch,
  runCleanups,
  SERVER,
  site,
  TEST_KEY,
  tempDir,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const WITH_POLICY: InstanceMetadata = {
  ...INSTANCE,
  capabilities: { ...INSTANCE.capabilities, archivePolicy: true },
}

async function storeFor(instance = WITH_POLICY) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: TEST_KEY })
  return store
}

const detail = (over: Partial<SiteDetail> = {}): SiteDetail => ({
  ...site(),
  versions: [],
  ...over,
})

const forbidden = () => jsonResponse({ error: { code: 'forbidden', message: 'Forbidden' } }, 403)
const missing = (message = 'No site named "my-app"') =>
  jsonResponse({ error: { code: 'not_found', message } }, 404)

const STATUS: ArchivePolicyStatus = {
  settings: { inactiveDays: 90, warnDays: 14, deleteArchivedDays: 30, purgeDeletedDays: 60 },
  on: true,
  live: false,
  mail: true,
  siteDelete: 'soft',
  paused: null,
  countingSince: '2026-08-01T00:00:00.000Z',
  preview: {
    from: '2026-11-25T12:00:00.000Z',
    to: '2026-12-02T12:00:00.000Z',
    sites: [
      {
        name: 'old-deck',
        owner: 'ada@example.test',
        action: 'archive',
        at: '2026-11-25T12:00:00.000Z',
        since: '2026-08-20T09:00:00.000Z',
      },
      {
        name: 'quiet',
        owner: 'bob@example.test',
        action: 'warn_archive',
        at: '2026-11-28T12:00:00.000Z',
        since: '2026-09-10T09:00:00.000Z',
      },
    ],
    purge: [
      {
        kind: 'site',
        siteId: 's_1',
        name: 'gone',
        deletedAt: '2026-09-27T10:00:00.000Z',
        at: '2026-11-26T10:00:00.000Z',
      },
    ],
    more: false,
  },
  recent: [{ at: '2026-11-20T03:00:00.000Z', action: 'site.archive', target: 'stale' }],
}

describe('fling keep', () => {
  it('keeps a site, and --off stops keeping it', async () => {
    const bodies: unknown[] = []
    const m = mockFetch({
      'PUT /api/sites/my-app/keep': (_url, init) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return jsonResponse(site({ ...(body.keep ? { keep: true } : {}) }))
      },
    })
    const store = await storeFor()
    const on = await testContext({ store, fetch: m.fetch })
    await runKeep(on.ctx, 'my-app', {})
    expect(on.log.lines.join('\n')).toMatch(
      /my-app is kept: the archive policy never archives it for disuse \(undo with `fling keep my-app --off`\)/
    )
    const off = await testContext({ store, fetch: m.fetch, json: true })
    await runKeep(off.ctx, 'my-app', { off: true })
    expect(bodies).toEqual([{ keep: true }, { keep: false }])
    expect(JSON.parse(off.out.content())).toMatchObject({ name: 'my-app' })
    expect(off.log.lines.join('\n')).toMatch(/my-app is no longer kept/)
  })

  it('refuses on a Fling without the policy, asking nothing of the site', async () => {
    const m = mockFetch({ 'GET /.well-known/fling': () => jsonResponse(INSTANCE) })
    const { ctx } = await testContext({ store: await storeFor(INSTANCE), fetch: m.fetch })
    const error = await captureError(runKeep(ctx, 'my-app', {}))
    expect(error.message).toBe(
      'Example Fling has no archive policy: it never archives sites for disuse, so there is nothing to keep them from'
    )
    expect(m.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('tells an admin to use their browser session, and a publisher to ask an owner', async () => {
    for (const [role, message, hint] of [
      [
        'admin',
        `As an admin you can keep my-app only from your browser session: open its page in the web app (${SERVER}/sites/my-app)`,
        undefined,
      ],
      ['publisher', 'Only the owners of my-app can keep it', /ada@example\.test/],
    ] as const) {
      const m = mockFetch({
        'PUT /api/sites/my-app/keep': () => missing(),
        'GET /api/sites/my-app': () =>
          jsonResponse(
            detail({
              role,
              owners: { emails: [{ email: 'ada@example.test', known: true }], groups: [] },
              publishers: { emails: [], groups: [] },
            })
          ),
      })
      const { ctx } = await testContext({ store: await storeFor(), fetch: m.fetch })
      const error = await captureError(runKeep(ctx, 'my-app', {}))
      expect(error.message).toBe(message)
      expect(error.exitCode).toBe(EXIT_FORBIDDEN)
      if (hint) expect(error.hint).toMatch(hint)
    }
  })

  it("passes on the server's own 404: a missing site, or no policy there", async () => {
    const m = mockFetch({
      'PUT /api/sites/my-app/keep': () => missing('This Fling has no archive policy'),
      'GET /api/sites/my-app': () => jsonResponse(detail({ role: 'owner' })),
    })
    const { ctx } = await testContext({ store: await storeFor(), fetch: m.fetch })
    expect((await captureError(runKeep(ctx, 'my-app', {}))).message).toBe(
      'This Fling has no archive policy'
    )
  })
})

describe('fling info', () => {
  it('says the site is kept, archived by the policy, or when it falls due', async () => {
    const show = async (over: Partial<SiteDetail>) => {
      const m = mockFetch({ 'GET /api/sites/my-app': () => jsonResponse(detail(over)) })
      const { ctx, out } = await testContext({ store: await storeFor(), fetch: m.fetch })
      await runInfo(ctx, 'my-app')
      return out.content()
    }
    expect(await show({ keep: true })).toMatch(
      /Archiving:\s+Kept: the archive policy never warns of, archives or deletes it/
    )
    expect(
      await show({ archived: true, archivedBy: 'policy', archivedAt: '2026-11-20T12:00:00.000Z' })
    ).toMatch(
      /Archived by the archive policy on 2026-11-2\d \d\d:\d\d: unarchiving or publishing it brings it back/
    )
    expect(
      await show({
        archiveDue: { action: 'archive', at: '2026-12-10T12:00:00.000Z', warned: true },
      })
    ).toMatch(
      /Will be archived on 2026-12-1\d \d\d:\d\d, unless someone views or publishes it first, or an owner keeps it \(its owners have been told\)/
    )
    expect(
      await show({
        archiveDue: { action: 'delete', at: '2026-12-10T12:00:00.000Z', warned: false },
      })
    ).toMatch(/Will be deleted on 2026-12-1\d \d\d:\d\d at the earliest, unless it is unarchived/)
    expect(await show({})).not.toMatch(/Archiving:/)
  })
})

describe('fling admin archive-policy', () => {
  it('shows the settings, the preview and what it did, then where to switch it', async () => {
    const m = mockFetch({ 'GET /api/admin/archive-policy': () => jsonResponse(STATUS) })
    const { ctx, out } = await testContext({ store: await storeFor(), fetch: m.fetch })
    await runAdminArchivePolicy(ctx)
    const text = out.content()
    expect(text).toContain('Dry run: it works out what it would do, and does and sends nothing.')
    expect(text).toContain(
      'Archives a site nobody has viewed or published for 90 days, after telling its owners 14 days before.'
    )
    expect(text).toContain('Deletes a site it archived 30 days after, warning its owners first')
    expect(text).toContain('What it would do in the next 7 days')
    expect(text).toMatch(/now\s+archive\s+old-deck\s+ada@example\.test/)
    expect(text).toMatch(/warn its owners it will be archived\s+quiet/)
    expect(text).toMatch(/DELETES FOR GOOD[\s\S]*gone/)
    expect(text).toMatch(/What it did lately[\s\S]*archived\s+stale/)
    expect(text.trim().split('\n').at(-1)).toBe(
      `Turn it live or back to dry run at Admin → Archive policy: ${SERVER}/admin/archive-policy (an admin's browser session; no command or tool does)`
    )
  })

  it('says why it is paused, and prints JSON with --json', async () => {
    const paused = {
      ...STATUS,
      live: true,
      paused: { reason: 'counting_off' as const },
      preview: { ...STATUS.preview, sites: [], purge: [] },
    }
    const m = mockFetch({ 'GET /api/admin/archive-policy': () => jsonResponse(paused) })
    const human = await testContext({ store: await storeFor(), fetch: m.fetch })
    await runAdminArchivePolicy(human.ctx)
    expect(human.out.content()).toMatch(/Paused: .*view counting is turned off \(Admin → Usage\)/)
    expect(human.out.content()).toMatch(/What it will do in the next 7 days\nNothing\./)
    const json = await testContext({ store: await storeFor(), fetch: m.fetch, json: true })
    await runAdminArchivePolicy(json.ctx)
    expect(JSON.parse(json.out.content())).toEqual(paused)
  })

  it.each([403, 404])('tells a non-admin it is for admins (%i)', async status => {
    const m = mockFetch({
      'GET /api/admin/archive-policy': () =>
        jsonResponse({ error: { code: 'forbidden', message: 'Forbidden' } }, status),
    })
    const { ctx } = await testContext({ store: await storeFor(), fetch: m.fetch })
    const error = await captureError(runAdminArchivePolicy(ctx))
    expect(error.message).toBe('Only an admin of Example Fling can see its archive policy')
    expect(error.exitCode).toBe(EXIT_FORBIDDEN)
  })
})

describe('the local MCP server', () => {
  async function connect(fetchImpl: FetchLike, instance = WITH_POLICY) {
    const home = await tempDir()
    const server = createMcpServer({
      store: await storeFor(instance),
      fetch: fetchImpl,
      servers: [{ url: SERVER, instance, current: true, signedIn: true }],
      locate: { cwd: home, home, platform: process.platform, env: {} },
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return client
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
  const names = async (client: Client) => (await client.listTools()).tools.map(t => t.name)

  it('offers the status where a Fling has the policy in any form, fling_keep where it archives', async () => {
    const without = await connect(mockFetch({}).fetch, INSTANCE)
    expect(await names(without)).not.toContain('fling_keep')
    expect(await names(without)).not.toContain('fling_admin_archive_policy')
    const withIt = await connect(mockFetch({}).fetch)
    expect(await names(withIt)).toEqual(
      expect.arrayContaining(['fling_keep', 'fling_admin_archive_policy'])
    )
    // Purging deleted sites only: the status, but nothing to keep sites from.
    const purgeOnly = await connect(mockFetch({}).fetch, {
      ...INSTANCE,
      capabilities: { ...INSTANCE.capabilities, purgeDeleted: true },
    })
    expect(await names(purgeOnly)).toContain('fling_admin_archive_policy')
    expect(await names(purgeOnly)).not.toContain('fling_keep')
  })

  it('fling_keep keeps a site; a publisher is told to ask an owner', async () => {
    const m = mockFetch({
      'PUT /api/sites/my-app/keep': () => jsonResponse(site({ keep: true })),
    })
    const client = await connect(m.fetch)
    const ok = await client.callTool({
      name: 'fling_keep',
      arguments: { name: 'my-app', keep: true },
    })
    expect(ok.isError).toBeFalsy()
    expect(text(ok)).toMatch(/^my-app is kept: the archive policy never archives it for disuse/)
    expect(JSON.parse(String(m.calls.at(-1)?.init.body))).toEqual({ keep: true })

    const refused = await connect(
      mockFetch({
        'PUT /api/sites/my-app/keep': () => missing(),
        'GET /api/sites/my-app': () => jsonResponse(detail({ role: 'publisher' })),
      }).fetch
    )
    const no = await refused.callTool({
      name: 'fling_keep',
      arguments: { name: 'my-app', keep: true },
    })
    expect(no.isError).toBe(true)
    expect(text(no)).toMatch(/Only the owners of my-app can keep it/)
  })

  it('fling_info says when the site falls due', async () => {
    const m = mockFetch({
      'GET /api/sites/my-app': () =>
        jsonResponse(
          detail({
            archiveDue: { action: 'archive', at: '2026-12-10T12:00:00.000Z', warned: false },
          })
        ),
    })
    const client = await connect(m.fetch)
    const r = await client.callTool({ name: 'fling_info', arguments: { name: 'my-app' } })
    expect(text(r)).toContain(
      'Will be archived on 2026-12-10 at the earliest, unless someone views or publishes it first, or an owner keeps it'
    )
  })

  it('fling_admin_archive_policy shows the policy and links to switch it; others are refused', async () => {
    const client = await connect(
      mockFetch({ 'GET /api/admin/archive-policy': () => jsonResponse(STATUS) }).fetch
    )
    const r = await client.callTool({ name: 'fling_admin_archive_policy', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/^The archive policy on Example Fling:\nDry run: /)
    expect(text(r)).toContain(
      '- now: archive old-deck (owner ada@example.test; last viewed or published 2026-08-20)'
    )
    expect(text(r)).toContain('- 2026-11-26: delete for good gone (deleted 2026-09-27)')
    expect(text(r)).toContain('- 2026-11-20: archived stale')
    expect(text(r)).toContain(`Admin → Archive policy: ${SERVER}/admin/archive-policy`)

    const refused = await connect(mockFetch({ 'GET /api/admin/archive-policy': forbidden }).fetch)
    const no = await refused.callTool({ name: 'fling_admin_archive_policy', arguments: {} })
    expect(no.isError).toBe(true)
    expect(text(no)).toMatch(/Only an admin of Example Fling can see its archive policy/)
  })
})
