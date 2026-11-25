/** `fling admin deleted [name]` against a mocked Fling: the listing, the restore link, and a non-admin refused. */
import type { DeletedSite } from '@fling/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdminDeleted } from '../src/commands/admin.ts'
import { EXIT_FORBIDDEN } from '../src/errors.ts'
import {
  captureError,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const deletedSite = (over: Partial<DeletedSite> = {}): DeletedSite => ({
  kind: 'site',
  siteId: 's_0123456789',
  name: 'pitch-deck',
  owner: 'ada@example.test',
  deletedBy: 'bob@example.test',
  deletedAt: '2026-11-20T10:00:00.000Z',
  bytes: 2048,
  paths: [{ folder: 'PAY-1', pathId: 'p_1' }],
  ...over,
})

const DELETED = [
  deletedSite(),
  deletedSite({
    kind: 'path',
    siteId: 's_team',
    name: 'team',
    folder: 'PAY-2',
    pathId: 'p_2',
    paths: undefined,
    deletedAt: '2026-11-19T10:00:00.000Z',
  }),
]

describe('fling admin deleted', () => {
  it('lists deleted sites and Paths, then where to restore them', async () => {
    const m = mockFetch({ 'GET /api/admin/deleted': () => jsonResponse({ deleted: DELETED }) })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runAdminDeleted(ctx, undefined)
    const text = out.content()
    expect(text).toMatch(/DELETED\s+ID\s+OWNER\s+BY\s+WHEN\s+KEPT\s+PATHS/)
    expect(text).toMatch(
      /pitch-deck\s+s_0123456789\s+ada@example\.test\s+bob@example\.test\s+.*2\.0 KB\s+PAY-1\//
    )
    expect(text).toContain('PAY-2/ of team')
    expect(text.trim().split('\n').at(-1)).toBe(
      `Restore or delete for good from Admin → Deleted: ${SERVER}/admin/deleted`
    )
  })

  it('asks for one name, and prints JSON with --json', async () => {
    const m = mockFetch({ 'GET /api/admin/deleted': () => jsonResponse({ deleted: [DELETED[0]] }) })
    const { ctx, out } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      json: true,
    })
    await runAdminDeleted(ctx, 'pitch-deck')
    expect(m.calls.at(-1)?.url.searchParams.get('name')).toBe('pitch-deck')
    expect(JSON.parse(out.content())).toEqual({ deleted: [DELETED[0]] })
  })

  it('says when nothing was deleted', async () => {
    const m = mockFetch({ 'GET /api/admin/deleted': () => jsonResponse({ deleted: [] }) })
    const { ctx, out } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runAdminDeleted(ctx, 'gone')
    expect(out.content()).toMatch(/Nothing named gone was deleted/)
  })

  it.each([403, 404])('tells a non-admin it is for admins (%i)', async status => {
    const m = mockFetch({
      'GET /api/admin/deleted': () =>
        jsonResponse({ error: { code: 'forbidden', message: 'Forbidden' } }, status),
    })
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    const error = await captureError(runAdminDeleted(ctx, undefined))
    expect(error.message).toBe('Only an admin of Example Fling can list its deleted sites')
    expect(error.exitCode).toBe(EXIT_FORBIDDEN)
  })
})
