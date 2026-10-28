/**
 * Shared with me (GET /api/shared and fling_list `shared`): the restricted sites of others the
 * caller may see, directly or through a group, found from index items that carry each site's
 * listing, so listing reads no site.
 */
import { describe, expect, it, vi } from 'vitest'
import { requireSite } from '../src/sites.ts'
import { encode } from '../src/store/evolution.ts'
import { APP_ORIGIN, api, createUser, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const page = [file('index.html', '<h1>hi</h1>')]
type Env = ReturnType<typeof setup>

async function deploy(env: Env, key: string, name: string, files = page) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
  })
  const body = await json(res)
  await upload(env, body.uploads, files)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

const audience = (env: Env, key: string, name: string, emails: string[], groups: string[] = []) =>
  api(env, key, 'PATCH', `/api/sites/${name}`, { audience: { emails, groups } })

const shared = async (env: Env, key: string) => {
  const res = await api(env, key, 'GET', '/api/shared')
  expect(res.status).toBe(200)
  return (await json(res)).sites as {
    name: string
    owner: string
    via: unknown
    updatedAt: string
  }[]
}
const names = async (env: Env, key: string) => (await shared(env, key)).map(s => s.name)

/** Alice owns `direct` (restricted to Bob) and `team` (restricted to the `design` group, Carol in it). */
async function world() {
  const env = setup()
  const alice = await createUser(env, 'alice@example.test')
  const bob = await createUser(env, 'bob@example.test')
  const carol = await createUser(env, 'carol@example.test')
  await deploy(env, alice.key, 'direct')
  await deploy(env, alice.key, 'team')
  await api(env, bob.key, 'POST', '/api/groups', {
    slug: 'design',
    name: 'Design team',
    members: ['carol@example.test'],
  })
  expect((await audience(env, alice.key, 'direct', ['bob@example.test'])).status).toBe(200)
  env.advance(1000)
  expect((await audience(env, alice.key, 'team', [], ['design'])).status).toBe(200)
  return { env, alice, bob, carol }
}

describe('GET /api/shared', () => {
  it('lists a site shared by address, with what a viewer needs and nothing of the owner’s', async () => {
    const { env, bob } = await world()
    const [site, ...rest] = await shared(env, bob.key)
    expect(rest).toEqual([])
    expect(site).toEqual({
      name: 'direct',
      url: expect.stringContaining('direct.'),
      reviewUrl: `${APP_ORIGIN}/review/direct`,
      owner: 'alice@example.test',
      via: { direct: true, groups: [] },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
  })

  it('lists a site shared through a group, naming the group, newest first', async () => {
    const { env, alice, carol } = await world()
    expect(await shared(env, carol.key)).toMatchObject([
      { name: 'team', owner: 'alice@example.test', via: { direct: false, groups: ['design'] } },
    ])
    env.advance(1000)
    await audience(env, alice.key, 'direct', ['bob@example.test', 'carol@example.test'])
    expect(await names(env, carol.key)).toEqual(['direct', 'team'])
  })

  it('never lists the caller’s own sites, or private sites every member sees anyway', async () => {
    const { env, alice, bob } = await world()
    await deploy(env, bob.key, 'open')
    await audience(env, alice.key, 'team', ['alice@example.test', 'bob@example.test'], ['design'])
    await api(env, bob.key, 'POST', '/api/groups/design/members', { add: ['alice@example.test'] })
    expect(await names(env, alice.key)).toEqual([])
    expect(await names(env, bob.key)).not.toContain('open')
    // An unrestricted site keeps nobody's grant.
    await audience(env, alice.key, 'direct', [])
    expect(await names(env, bob.key)).toEqual(['team'])
  })

  it('drops a site once the caller leaves the group, or the group is deleted', async () => {
    const { env, bob, carol } = await world()
    await api(env, bob.key, 'POST', '/api/groups/design/members', {
      remove: ['carol@example.test'],
    })
    expect(await names(env, carol.key)).toEqual([])
    await api(env, bob.key, 'POST', '/api/groups/design/members', { add: ['carol@example.test'] })
    expect(await names(env, carol.key)).toEqual(['team'])
    expect((await api(env, bob.key, 'DELETE', '/api/groups/design')).status).toBe(204)
    expect(await names(env, carol.key)).toEqual([])
  })

  it('leaves out archived sites, public ones and sites with no version', async () => {
    const { env, alice, bob, carol } = await world()
    await api(env, alice.key, 'POST', '/api/sites/direct/archive')
    expect(await names(env, bob.key)).toEqual([])
    await api(env, alice.key, 'POST', '/api/sites/direct/unarchive')
    expect(await names(env, bob.key)).toEqual(['direct'])
    await api(env, alice.key, 'PATCH', '/api/sites/team', { visibility: 'public' })
    expect(await names(env, carol.key)).toEqual([])
  })

  it('reads no site: one query per source, however many sites are shared', async () => {
    const { env, alice, carol } = await world()
    for (const name of ['one', 'two', 'three']) {
      env.advance(1000)
      await deploy(env, alice.key, name)
      await audience(env, alice.key, name, ['carol@example.test'], ['design'])
    }
    const findSite = vi.spyOn(env.store, 'findSite')
    const get = vi.spyOn(env.table, 'get')
    expect(await names(env, carol.key)).toEqual(['three', 'two', 'one', 'team'])
    expect(findSite).not.toHaveBeenCalled()
    expect(get.mock.calls.filter(([pk]) => /^(SITE|NAME)#/.test(pk))).toEqual([])
  })

  it('shows each deploy’s updatedAt, and follows archive and unarchive', async () => {
    const { env, alice, bob } = await world()
    env.advance(60_000)
    await deploy(env, alice.key, 'direct', [file('index.html', '<h1>again</h1>')])
    const site = await env.store.findSite('direct')
    expect((await shared(env, bob.key))[0]?.updatedAt).toBe(site?.updatedAt)
    await api(env, alice.key, 'POST', '/api/sites/direct/archive')
    expect(await names(env, bob.key)).toEqual([])
    env.advance(1000)
    await api(env, alice.key, 'POST', '/api/sites/direct/unarchive')
    const [listed] = await shared(env, bob.key)
    expect(listed?.name).toBe('direct')
    expect(listed?.updatedAt).toBe((await env.store.findSite('direct'))?.updatedAt)
  })

  it('answers an item without a listing (v1) from the site, asked of policy', async () => {
    const { env, bob } = await world()
    const direct = await env.store.findSite('direct')
    if (!direct) throw new Error('no site')
    const { pk, sk } = { pk: 'USER#bob@example.test', sk: `SHARED#${direct.id}` }
    await env.table.put({
      pk,
      sk,
      type: 'sitegrant',
      v: 1,
      email: 'bob@example.test',
      siteId: direct.id,
      name: 'direct',
      owner: 'alice@example.test',
      grantedAt: direct.updatedAt,
    })
    expect(await shared(env, bob.key)).toMatchObject([
      { name: 'direct', via: { direct: true, groups: [] }, updatedAt: direct.updatedAt },
    ])
  })

  it('an interrupted rewrite leaves a stale listing until the site is next saved', async () => {
    const { env, alice, carol } = await world()
    // Carol last, so her grant falls past the first transaction.
    const others = Array.from({ length: 29 }, (_, i) => `u${i}@example.test`)
    await audience(env, alice.key, 'direct', [...others, 'carol@example.test'])
    expect(await names(env, carol.key)).toContain('direct')
    const transact = env.table.transact.bind(env.table)
    let calls = 0
    const spy = vi.spyOn(env.table, 'transact').mockImplementation(async ops => {
      if (++calls > 1) throw new Error('interrupted')
      return transact(ops)
    })
    expect((await api(env, alice.key, 'POST', '/api/sites/direct/archive')).status).toBe(500)
    spy.mockRestore()
    expect((await env.store.findSite('direct'))?.archived).toBe(true)
    // Her grant still carries the listing from before the archive.
    expect(await names(env, carol.key)).toContain('direct')
    env.advance(1000)
    await api(env, alice.key, 'PATCH', '/api/sites/direct', { spa: true })
    expect(await names(env, carol.key)).not.toContain('direct')
  })

  it('an item the audience does not back lists the name, and opening the site is still refused', async () => {
    const { env, carol } = await world()
    const direct = await env.store.findSite('direct')
    if (!direct) throw new Error('no site')
    // A grant with a current listing for someone the audience doesn't name: what two saves of
    // the site racing can leave.
    await env.table.put(
      encode(
        'sitegrant',
        { pk: 'USER#carol@example.test', sk: `SHARED#${direct.id}` },
        {
          email: 'carol@example.test',
          siteId: direct.id,
          name: 'direct',
          owner: 'alice@example.test',
          createdAt: direct.createdAt,
          updatedAt: direct.updatedAt,
          archived: false,
          live: true,
          restricted: true,
        }
      )
    )
    expect((await names(env, carol.key)).sort()).toEqual(['direct', 'team'])
    await expect(requireSite(env.deps, carol.user, 'direct', 'site.view')).rejects.toMatchObject({
      status: 404,
    })
    expect((await api(env, carol.key, 'GET', '/api/sites/direct/comments')).status).toBe(404)
  })

  it('asks policy of every site read for an item without a listing', async () => {
    const { env, alice, carol } = await world()
    const direct = await env.store.findSite('direct')
    if (!direct) throw new Error('no site')
    // Items without a listing: a grant the audience doesn't back, and a group-site item for a
    // group the audience doesn't name.
    await env.table.put(
      encode(
        'sitegrant',
        { pk: 'USER#carol@example.test', sk: `SHARED#${direct.id}` },
        {
          email: 'carol@example.test',
          siteId: direct.id,
          name: 'direct',
          owner: 'alice@example.test',
          grantedAt: direct.updatedAt,
        }
      )
    )
    const [group] = await env.store.listGroups()
    if (!group) throw new Error('no group')
    await env.table.put(
      encode(
        'groupsite',
        { pk: `GROUP#${group.id}`, sk: `SITE#${direct.id}` },
        { groupId: group.id, siteId: direct.id, name: 'direct', owner: 'alice@example.test' }
      )
    )
    expect(await names(env, carol.key)).toEqual(['team'])
    // An item naming a site whose name now belongs to another site shows nothing either.
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    await deploy(env, alice.key, 'team')
    expect(await names(env, carol.key)).toEqual([])
  })
})

describe('fling_list { shared }', () => {
  it('lists the sites shared with the caller, in the order asked', async () => {
    const { env, alice, carol } = await world()
    await audience(env, alice.key, 'direct', ['carol@example.test'])
    const { accessToken } = await connect(env, carol.user.email)
    const result = await callTool(env, accessToken, 'fling_list', { shared: true, sort: 'name' })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.sites.map((s: { name: string }) => s.name)).toEqual([
      'direct',
      'team',
    ])
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('2 site(s) shared with you')
    expect(text).toContain('shared by alice@example.test, through group design')
    expect(text).toContain(`review: ${APP_ORIGIN}/review/team`)
    const own = await callTool(env, accessToken, 'fling_list', {})
    expect(own.structuredContent.sites).toEqual([])
  })
})
