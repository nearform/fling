import type { Comment, CommentList } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { runComment, runComments, runResolve, runUncomment } from '../src/commands/comments.ts'
import { createMcpServer } from '../src/mcp.ts'
import { commentsEnabled } from '../src/sites.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  parentId: null,
  path: '/',
  versionId: 'v2',
  anchor: null,
  body: `body ${id}`,
  author: { kind: 'user', email: 'bob@example.test' },
  createdAt: '2026-10-01T10:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  canDelete: true,
  ...over,
})

const LIST: CommentList = {
  site: { name: 'deck', url: 'https://deck.sites.example.test/', currentVersionId: 'v2' },
  comments: [
    comment('t1', { path: '/docs/', versionId: 'v1', body: 'Typo here' }),
    comment('t2', { resolvedAt: '2026-10-02T10:00:00.000Z' }),
    comment('r1', { parentId: 't1', body: 'Fixed', author: { kind: 'user', email: 'a@x.test' } }),
  ],
  can: { create: true, resolve: true, deleteAny: false },
}

const body = (init: RequestInit) => JSON.parse(String(init.body))

describe('fling comments / comment / resolve / uncomment', () => {
  it('lists open threads by page, with replies, the version and the review page', async () => {
    const store = await loggedInStore()
    const m = mockFetch({ 'GET /api/sites/deck/comments': () => jsonResponse(LIST) })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runComments(ctx, 'deck', {})
    const text = out.content()
    expect(text).toContain('/docs/')
    expect(text).toContain('t1')
    expect(text).toContain('(on version v1)')
    expect(text).toContain('  Typo here')
    expect(text).toContain('↳')
    expect(text).toContain('    Fixed')
    expect(text).not.toContain('t2')
    expect(text).toContain('1 open thread (1 resolved')
    expect(text).toContain(`review: ${SERVER}/review/deck`)

    await runComments(ctx, 'deck', { all: true, path: '/docs/' })
    expect(m.calls.at(-1)?.url.searchParams.get('path')).toBe('/docs/')
    expect(out.content()).toContain('t2')
  })

  it('--json prints the list with the review URL', async () => {
    const store = await loggedInStore()
    const m = mockFetch({ 'GET /api/sites/deck/comments': () => jsonResponse(LIST) })
    const { ctx, out } = await testContext({ store, fetch: m.fetch, json: true })
    await runComments(ctx, 'deck', {})
    expect(JSON.parse(out.content())).toEqual({ ...LIST, reviewUrl: `${SERVER}/review/deck` })
  })

  it('adds a comment on a page, or a reply', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'POST /api/sites/deck/comments': (_url, init) =>
        jsonResponse(comment('n1', { path: '/docs/', parentId: body(init).parentId ?? null }), 201),
    })
    const { ctx, out, log } = await testContext({ store, fetch: m.fetch })
    await runComment(ctx, 'deck', 'Looks good', { path: '/docs/' })
    expect(body(m.calls[0]?.init ?? {})).toEqual({ body: 'Looks good', path: '/docs/' })
    expect(out.content()).toContain(`${SERVER}/review/deck?path=%2Fdocs%2F`)
    expect(log.lines.join('\n')).toMatch(/Comment added on deck \/docs\//)
    await runComment(ctx, 'deck', 'Agreed', { reply: 't1' })
    expect(body(m.calls[1]?.init ?? {})).toEqual({ body: 'Agreed', parentId: 't1' })
    expect(log.lines.join('\n')).toMatch(/Replied to t1/)
    expect((await captureError(runComment(ctx, 'deck', '  ', {}))).message).toBe(
      'The comment is empty'
    )
  })

  it('resolves, reopens and deletes (with confirmation)', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'PATCH /api/sites/deck/comments/t1': () => jsonResponse(comment('t1')),
      'DELETE /api/sites/deck/comments/t1': () => new Response(null, { status: 204 }),
    })
    const { ctx, log } = await testContext({ store, fetch: m.fetch })
    await runResolve(ctx, 'deck', 't1', {})
    await runResolve(ctx, 'deck', 't1', { reopen: true })
    expect(m.calls.map(c => body(c.init))).toEqual([{ resolved: true }, { resolved: false }])
    expect(log.lines.join('\n')).toMatch(/Thread t1 resolved[\s\S]*Thread t1 reopened/)
    expect((await captureError(runUncomment(ctx, 'deck', 't1', {}))).message).toMatch(
      /without confirmation/
    )
    await runUncomment(ctx, 'deck', 't1', { yes: true })
    expect(m.calls.at(-1)?.method).toBe('DELETE')
  })

  it('says so when the instance has comments turned off', async () => {
    const { store } = await tempStore()
    await store.putServer(SERVER, {
      apiKey: TEST_KEY,
      instance: { ...INSTANCE, capabilities: { comments: false } },
    })
    const { ctx } = await testContext({ store })
    expect((await captureError(runComments(ctx, 'deck', {}))).message).toBe(
      'Example Fling has comments turned off'
    )
  })

  it('commentsEnabled: the capability; a copy from before the flag defers to the server', () => {
    expect(commentsEnabled({ capabilities: { comments: true } })).toBe(true)
    expect(commentsEnabled({ capabilities: { comments: false } })).toBe(false)
    expect(commentsEnabled({ capabilities: {} })).toBe(true)
    expect(commentsEnabled(null)).toBe(false)
  })
})

describe('MCP comment tools', () => {
  async function connect(instance: typeof INSTANCE | null, fetchImpl = mockFetch({}).fetch) {
    const store = await loggedInStore()
    const servers = instance ? [{ url: SERVER, instance, current: true, signedIn: true }] : []
    const server = createMcpServer({ store, fetch: fetchImpl, servers })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return client
  }
  const names = async (client: Client) =>
    (await client.listTools()).tools.map(t => t.name).filter(n => n.includes('comment'))
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''

  it('are offered only when the instance has comments', async () => {
    const on = { ...INSTANCE, capabilities: { comments: true } }
    expect((await names(await connect(on))).sort()).toEqual([
      'fling_comment_add',
      'fling_comment_delete',
      'fling_comment_resolve',
      'fling_comments_list',
    ])
    const on2 = await connect(on)
    expect(on2.getInstructions()).toContain('fling_comments_list')
    expect(await names(await connect({ ...INSTANCE, capabilities: { comments: false } }))).toEqual(
      []
    )
    expect(await names(await connect(null))).toEqual([])
  })

  it('list and add go to the API and name the review page', async () => {
    const m = mockFetch({
      'GET /api/sites/deck/comments': () => jsonResponse(LIST),
      'POST /api/sites/deck/comments': () => jsonResponse(comment('n1', { parentId: 't1' }), 201),
      'PATCH /api/sites/deck/comments/t1': () => jsonResponse(comment('t1')),
    })
    const client = await connect({ ...INSTANCE, capabilities: { comments: true } }, m.fetch)
    const listed = await client.callTool({
      name: 'fling_comments_list',
      arguments: { name: 'deck' },
    })
    expect(text(listed)).toMatch(
      /^1 open thread on deck \(1 resolved not shown\)\. Review page: http:\/\/server\.test\/review\/deck/
    )
    const added = await client.callTool({
      name: 'fling_comment_add',
      arguments: { name: 'deck', body: 'Agreed', replyTo: 't1' },
    })
    expect(text(added)).toMatch(/^Replied to thread t1 on deck/)
    expect(body(m.calls[1]?.init ?? {})).toEqual({ body: 'Agreed', parentId: 't1' })
    const resolved = await client.callTool({
      name: 'fling_comment_resolve',
      arguments: { name: 'deck', id: 't1' },
    })
    expect(text(resolved)).toMatch(/^Thread t1 on deck resolved/)
  })
})
