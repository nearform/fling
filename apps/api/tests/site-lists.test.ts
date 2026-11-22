/**
 * Paging a person's lists (GET /api/sites, GET /api/shared, fling_list): without `limit`, the whole
 * list as every client has always read it; with it, one page in the order asked and an opaque
 * cursor that carries on after the last site listed.
 */
import { SITE_LIST_PAGE_MAX, SITE_SORTS, type SiteSort, sortSites } from '@fling/shared'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { MANY_GROUPS } from '../src/sites.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const page = [file('index.html', '<h1>hi</h1>')]

async function deploy(env: Env, key: string, name: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
  })
  const body = await json(res)
  await upload(env, body.uploads, page)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

type Listed = { name: string; createdAt: string; updatedAt: string }
type ListBody = { sites: Listed[]; cursor?: string | null }

async function get(env: Env, key: string, path: string): Promise<ListBody> {
  const res = await api(env, key, 'GET', path)
  expect(res.status).toBe(200)
  return json(res)
}

/** Every page of `path`, `limit` at a time, following the cursors. */
async function allPages(env: Env, key: string, path: string, limit: number) {
  const names: string[] = []
  let cursor: string | null | undefined
  do {
    const sep = path.includes('?') ? '&' : '?'
    const after = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    const body = await get(env, key, `${path}${sep}limit=${limit}${after}`)
    expect(body.sites.length).toBeLessThanOrEqual(limit)
    names.push(...body.sites.map(s => s.name))
    cursor = body.cursor
  } while (cursor)
  return names
}

/** Alice publishes five sites, created in one order and updated in another. */
async function world() {
  const env = setup()
  const alice = await createUser(env, 'alice@example.test')
  for (const name of ['delta', 'alpha', 'echo', 'charlie', 'bravo']) {
    await deploy(env, alice.key, name)
    env.advance(1000)
  }
  // Updated last: alpha, then delta.
  for (const name of ['delta', 'alpha']) {
    await api(env, alice.key, 'PATCH', `/api/sites/${name}`, { spa: true })
    env.advance(1000)
  }
  return { env, alice }
}

let log: MockInstance<typeof console.log>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => log.mockRestore())

describe('GET /api/sites', () => {
  it('without limit, lists every site and no cursor', async () => {
    const { env, alice } = await world()
    const body = await get(env, alice.key, '/api/sites')
    expect(body.sites).toHaveLength(5)
    expect('cursor' in body).toBe(false)
  })

  it('pages in each order, the pages together the whole sorted list', async () => {
    const { env, alice } = await world()
    const whole = (await get(env, alice.key, '/api/sites')).sites
    for (const sort of SITE_SORTS) {
      const expected = sortSites(whole, sort).map(s => s.name)
      expect(await allPages(env, alice.key, `/api/sites?sort=${sort}`, 2)).toEqual(expected)
      expect((await get(env, alice.key, `/api/sites?sort=${sort}`)).sites.map(s => s.name)).toEqual(
        expected
      )
    }
    // Last updated first by default.
    expect((await get(env, alice.key, '/api/sites?limit=2')).sites.map(s => s.name)).toEqual([
      'alpha',
      'delta',
    ])
  })

  it('carries on after the last site listed, even when it changed or went since', async () => {
    const { env, alice } = await world()
    const first = await get(env, alice.key, '/api/sites?sort=name&limit=2')
    expect(first.sites.map(s => s.name)).toEqual(['alpha', 'bravo'])
    await api(env, alice.key, 'DELETE', '/api/sites/bravo')
    const next = await get(
      env,
      alice.key,
      `/api/sites?sort=name&limit=2&cursor=${encodeURIComponent(first.cursor ?? '')}`
    )
    expect(next.sites.map(s => s.name)).toEqual(['charlie', 'delta'])
    const last = await get(
      env,
      alice.key,
      `/api/sites?sort=name&limit=2&cursor=${encodeURIComponent(next.cursor ?? '')}`
    )
    expect([last.sites.map(s => s.name), last.cursor]).toEqual([['echo'], null])
  })

  it(`holds at most ${SITE_LIST_PAGE_MAX} a page`, async () => {
    const { env, alice } = await world()
    const body = await get(env, alice.key, `/api/sites?limit=${SITE_LIST_PAGE_MAX * 10}`)
    expect([body.sites.length, body.cursor]).toEqual([5, null])
  })

  it('refuses an unknown order, and a cursor from another order', async () => {
    const { env, alice } = await world()
    expect((await api(env, alice.key, 'GET', '/api/sites?sort=size')).status).toBe(400)
    const first = await get(env, alice.key, '/api/sites?sort=name&limit=2')
    const cursor = encodeURIComponent(first.cursor ?? '')
    const res = await api(env, alice.key, 'GET', `/api/sites?sort=created&limit=2&cursor=${cursor}`)
    expect([res.status, (await json(res)).error.code]).toEqual([400, 'bad_cursor'])
    const junk = await api(env, alice.key, 'GET', '/api/sites?limit=2&cursor=nonsense')
    expect(junk.status).toBe(400)
  })

  it('logs, without the person, when they are in many groups', async () => {
    const { env, alice } = await world()
    const now = env.deps.clock.now().toISOString()
    const manyGroups = (line: unknown) => String(line).includes('"many groups"')
    await get(env, alice.key, '/api/sites')
    expect(log.mock.calls.flat().filter(manyGroups)).toEqual([])
    for (let i = 0; i <= MANY_GROUPS; i++) {
      await env.store.createGroup(
        {
          id: `g${i}`,
          slug: `g${i}`,
          name: `G${i}`,
          owner: 'bob@example.test',
          size: 1,
          createdAt: now,
          updatedAt: now,
        },
        ['alice@example.test']
      )
    }
    await get(env, alice.key, '/api/shared')
    const lines = log.mock.calls.flat().filter(manyGroups)
    expect(lines.map(l => JSON.parse(String(l)))).toEqual([
      { level: 'info', msg: 'many groups', groups: MANY_GROUPS + 1 },
    ])
    expect(lines.join()).not.toContain('alice')
  })
})

describe('GET /api/shared', () => {
  it('pages the sites shared with the caller the same way', async () => {
    const { env, alice } = await world()
    const bob = await createUser(env, 'bob@example.test')
    for (const name of ['alpha', 'bravo', 'charlie']) {
      await api(env, alice.key, 'PATCH', `/api/sites/${name}`, {
        audience: { emails: ['bob@example.test'], groups: [] },
      })
    }
    const whole = await get(env, bob.key, '/api/shared')
    expect([whole.sites.length, 'cursor' in whole]).toEqual([3, false])
    for (const sort of SITE_SORTS satisfies readonly SiteSort[]) {
      const expected = sortSites(whole.sites, sort).map(s => s.name)
      expect(await allPages(env, bob.key, `/api/shared?sort=${sort}`, 2)).toEqual(expected)
    }
  })
})

describe('fling_list paging', () => {
  it('lists every site without limit; with it, a page and the cursor for the next', async () => {
    const { env, alice } = await world()
    const { accessToken } = await connect(env, alice.user.email)
    const all = await callTool(env, accessToken, 'fling_list', {})
    expect(all.structuredContent.sites).toHaveLength(5)
    expect(all.content[0]?.text).not.toContain('More sites')
    const first = await callTool(env, accessToken, 'fling_list', { sort: 'name', limit: 3 })
    expect(first.structuredContent.sites.map((s: Listed) => s.name)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
    const cursor = first.structuredContent.cursor
    expect(first.content[0]?.text).toContain(`call fling_list again with cursor: ${cursor}`)
    const rest = await callTool(env, accessToken, 'fling_list', { sort: 'name', limit: 3, cursor })
    expect(rest.structuredContent.sites.map((s: Listed) => s.name)).toEqual(['delta', 'echo'])
    expect(rest.structuredContent.cursor).toBeNull()
    expect(rest.content[0]?.text).not.toContain('More sites')
  })
})
