/**
 * Groups through the API and the remote MCP server: anyone signed in lists them, sees their
 * members and puts them in an audience; only the owner renames, changes members or deletes; a
 * group in an audience lets its members in (the API and the site pass), and deleting it never
 * widens who sees a site.
 */
import { GROUP_MEMBERS_MAX, siteKvsKey } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { api, createUser, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const page = [file('index.html', '<h1>hi</h1>')]

async function deploy(env: ReturnType<typeof setup>, key: string, name: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
  })
  const body = await json(res)
  await upload(env, body.uploads, page)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

/** Alice owns a site; Bob owns the `design` group, with Carol in it. */
async function team() {
  const env = setup()
  const alice = await createUser(env, 'alice@example.test')
  const bob = await createUser(env, 'bob@example.test')
  const carol = await createUser(env, 'carol@example.test')
  await deploy(env, alice.key, 'team')
  const created = await api(env, bob.key, 'POST', '/api/groups', {
    slug: 'design',
    name: 'Design team',
    members: ['Carol@Example.test', 'new@example.test'],
  })
  expect(created.status).toBe(201)
  return { env, alice, bob, carol }
}

const route = (env: ReturnType<typeof setup>) =>
  JSON.parse(env.routeTable.data.get(siteKvsKey('team')) ?? '{}')

describe('/api/groups', () => {
  it('creates a group owned by its maker, members normalised, saying who has signed in', async () => {
    const { env, alice, bob } = await team()
    const detail = await json(await api(env, bob.key, 'GET', '/api/groups/design'))
    expect(detail).toMatchObject({
      slug: 'design',
      name: 'Design team',
      owner: 'bob@example.test',
      size: 2,
      canManage: true,
      members: [
        { email: 'carol@example.test', known: true },
        { email: 'new@example.test', known: false },
      ],
    })
    // Anyone signed in sees it and its members, but may not manage it.
    const asAlice = await json(await api(env, alice.key, 'GET', '/api/groups/design'))
    expect(asAlice).toMatchObject({ size: 2, canManage: false })
    expect(asAlice.members).toHaveLength(2)
  })

  it('lists every group, or only the caller’s own', async () => {
    const { env, alice, bob } = await team()
    await api(env, alice.key, 'POST', '/api/groups', { slug: 'alpha', name: 'Alpha' })
    const all = await json(await api(env, alice.key, 'GET', '/api/groups'))
    expect(all.groups.map((g: { slug: string }) => g.slug)).toEqual(['alpha', 'design'])
    const mine = await json(await api(env, bob.key, 'GET', '/api/groups?mine=1'))
    expect(mine.groups.map((g: { slug: string }) => g.slug)).toEqual(['design'])
  })

  it('refuses a slug in use, a bad slug, an address that cannot sign in and too many members', async () => {
    const { env, alice } = await team()
    const taken = await api(env, alice.key, 'POST', '/api/groups', { slug: 'design', name: 'x' })
    expect(taken.status).toBe(409)
    expect((await json(taken)).error.code).toBe('group_taken')
    const bad = await api(env, alice.key, 'POST', '/api/groups', { slug: 'No--Way', name: 'x' })
    expect(bad.status).toBe(400)
    const outsider = await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'ops',
      name: 'Ops',
      members: ['eve@elsewhere.test'],
    })
    expect(outsider.status).toBe(400)
    expect((await json(outsider)).error.code).toBe('email_not_allowed')
    const many = Array.from({ length: GROUP_MEMBERS_MAX + 1 }, (_, i) => `u${i}@example.test`)
    const big = await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'big',
      name: 'Big',
      members: many,
    })
    expect(big.status).toBe(400)
    expect((await api(env, alice.key, 'GET', '/api/groups/ops')).status).toBe(404)
  })

  it('only the owner renames, changes members or deletes (403 for anyone else)', async () => {
    const { env, alice, bob } = await team()
    expect((await api(env, alice.key, 'PATCH', '/api/groups/design', { name: 'X' })).status).toBe(
      403
    )
    const members = await api(env, alice.key, 'POST', '/api/groups/design/members', {
      add: ['alice@example.test'],
    })
    expect(members.status).toBe(403)
    expect((await api(env, alice.key, 'DELETE', '/api/groups/design')).status).toBe(403)
    expect((await api(env, alice.key, 'GET', '/api/groups/nope')).status).toBe(404)

    const renamed = await json(
      await api(env, bob.key, 'PATCH', '/api/groups/design', { name: 'Designers' })
    )
    expect(renamed).toMatchObject({ slug: 'design', name: 'Designers' })
    const changed = await json(
      await api(env, bob.key, 'POST', '/api/groups/design/members', {
        add: ['alice@example.test', 'carol@example.test'],
        remove: ['new@example.test'],
      })
    )
    expect(changed.size).toBe(2)
    expect(changed.members.map((m: { email: string }) => m.email)).toEqual([
      'alice@example.test',
      'carol@example.test',
    ])
  })

  it('adds and removes members past one transaction (each member item with its membership)', async () => {
    const { env, bob } = await team()
    const many = Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, '0')}@example.test`)
    const added = await json(
      await api(env, bob.key, 'POST', '/api/groups/design/members', { add: many })
    )
    expect(added.size).toBe(62)
    expect(await env.store.listMemberships('p59@example.test')).toHaveLength(1)
    const removed = await json(
      await api(env, bob.key, 'POST', '/api/groups/design/members', { remove: many })
    )
    expect(removed.size).toBe(2)
    expect(await env.store.listMemberships('p59@example.test')).toEqual([])
  })
})

describe('a group in an audience', () => {
  it('anyone may name it; its members get in; one taken out is refused at once', async () => {
    const { env, alice, bob, carol } = await team()
    const comments = (key: string) => api(env, key, 'GET', '/api/sites/team/comments')
    const set = await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['design'] },
    })
    expect(set.status).toBe(200)
    const site = await json(set)
    expect(site).toMatchObject({ restricted: true, audienceSize: 1, audienceGroups: 1 })
    expect(site.audience.groups).toEqual([{ slug: 'design', name: 'Design team', size: 2 }])
    expect(route(env).r).toBe(1)

    expect((await comments(carol.key)).status).toBe(200)
    expect((await comments(bob.key)).status).toBe(404)
    await api(env, bob.key, 'POST', '/api/groups/design/members', {
      remove: ['carol@example.test'],
    })
    expect((await comments(carol.key)).status).toBe(404)
  })

  it('the site pass follows the group', async () => {
    const { env, alice, bob, carol } = await team()
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['design'] },
    })
    const hop = () =>
      env.app.request(`/auth/login?return=${encodeURIComponent('https://team.fling.test/')}`, {
        headers: { cookie: `__Host-fling_session=${carol.session}` },
      })
    expect((await hop()).headers.get('location')).toMatch(
      /^https:\/\/team\.fling\.test\/_fling-pass\?t=/
    )
    await api(env, bob.key, 'POST', '/api/groups/design/members', {
      remove: ['carol@example.test'],
    })
    expect((await hop()).headers.get('location')).toBe('https://team.fling.test/_fling/404.html')
  })

  it('deleting the only group in an audience keeps the site restricted, to its owner', async () => {
    const { env, alice, bob, carol } = await team()
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['design'] },
    })
    const group = await env.store.findGroup('design')
    expect((await api(env, bob.key, 'DELETE', '/api/groups/design')).status).toBe(204)
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail).toMatchObject({ restricted: true, audienceSize: 1 })
    expect(detail.audience.groups).toEqual([
      { slug: `#${group?.id}`, name: 'a deleted group', size: 0, deleted: true },
    ])
    expect(route(env).r).toBe(1)
    // Nobody it let in gets in; the owner still does.
    expect((await api(env, carol.key, 'GET', '/api/sites/team/comments')).status).toBe(404)
    expect((await api(env, bob.key, 'GET', '/api/sites/team/comments')).status).toBe(404)
    expect((await api(env, alice.key, 'GET', '/api/sites/team/comments')).status).toBe(200)
    expect(await env.store.listMemberships('carol@example.test')).toEqual([])
    expect(await env.store.listGroupSites(group?.id ?? '')).toEqual([])
    expect((await api(env, alice.key, 'GET', '/api/groups/design')).status).toBe(404)

    // The owner keeps it by passing its reference back, and removes it by leaving it out.
    const kept = await json(
      await api(env, alice.key, 'PATCH', '/api/sites/team', {
        audience: { emails: ['bob@example.test'], groups: [`#${group?.id}`] },
      })
    )
    expect(kept.audience.groups).toHaveLength(1)
    const removed = await json(
      await api(env, alice.key, 'PATCH', '/api/sites/team', {
        audience: { emails: ['bob@example.test'], groups: [] },
      })
    )
    expect(removed).toMatchObject({ restricted: true, audienceSize: 1, audienceGroups: 0 })
    // A reference the audience doesn't hold is refused.
    const forged = await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['#nosuchgroup'] },
    })
    expect(forged.status).toBe(400)
    // The slug is free again.
    const again = await api(env, alice.key, 'POST', '/api/groups', { slug: 'design', name: 'D' })
    expect(again.status).toBe(201)
  })

  it('deleting a group takes it out of an audience that names others too', async () => {
    const { env, alice, bob } = await team()
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: ['bob@example.test'], groups: ['design'] },
    })
    expect((await api(env, bob.key, 'DELETE', '/api/groups/design')).status).toBe(204)
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail).toMatchObject({ restricted: true, audienceSize: 1, audienceGroups: 0 })
    expect(detail.audience.groups).toEqual([])
    expect(route(env).r).toBe(1)
  })

  it('fling_info and fling_set_audience name a deleted group', async () => {
    const { env, alice, bob } = await team()
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['design'] },
    })
    await api(env, bob.key, 'DELETE', '/api/groups/design')
    const { accessToken } = await connect(env, alice.user.email)
    const info = await callTool(env, accessToken, 'fling_info', { name: 'team' })
    expect(info.content[0]?.text).toMatch(
      /Restricted: only you can open it\. Its audience names only a deleted group \(#\w+\)/
    )
    const added = await callTool(env, accessToken, 'fling_set_audience', {
      name: 'team',
      add: ['carol@example.test'],
    })
    expect(added.content[0]?.text).toMatch(/only you, 1 person and a deleted group \(#\w+\)/)
  })

  it('deleting the site removes its group-site items', async () => {
    const { env, alice } = await team()
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['design'] },
    })
    const group = await env.store.findGroup('design')
    expect(await env.store.listGroupSites(group?.id ?? '')).toHaveLength(1)
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    expect(await env.store.listGroupSites(group?.id ?? '')).toEqual([])
  })
})

describe('the group tools and fling_set_audience with groups', () => {
  it('list, show, create, change, rename and delete; groups in an audience', async () => {
    const { env, alice } = await team()
    const { accessToken } = await connect(env, alice.user.email)
    const call = (tool: string, args: object) => callTool(env, accessToken, tool, args)

    const list = await call('fling_groups', {})
    expect(list.content[0]?.text).toContain(
      'design (Design team, 2 people), owned by bob@example.test'
    )
    const show = await call('fling_group_show', { slug: 'design' })
    expect(show.content[0]?.text).toContain('only they can change it')
    const refused = await call('fling_group_rename', { slug: 'design', name: 'X' })
    expect(refused.isError).toBe(true)

    const made = await call('fling_group_create', {
      slug: 'ops',
      name: 'Ops',
      members: ['carol@example.test'],
    })
    expect(made.structuredContent).toMatchObject({ slug: 'ops', owner: 'alice@example.test' })
    const added = await call('fling_group_members', { slug: 'ops', add: ['bob@example.test'] })
    expect(added.structuredContent.size).toBe(2)
    const renamed = await call('fling_group_rename', { slug: 'ops', name: 'Operations' })
    expect(renamed.structuredContent.name).toBe('Operations')
    const mine = await call('fling_groups', { mine: true })
    expect(mine.structuredContent.groups.map((g: { slug: string }) => g.slug)).toEqual(['ops'])

    const audience = await call('fling_set_audience', {
      name: 'team',
      add: ['bob@example.test'],
      addGroups: ['design', 'ops'],
    })
    expect(audience.content[0]?.text).toContain(
      'Restricted: only you, 1 person and the groups design (Design team, 2 people), ops (Operations, 2 people) can open it'
    )
    const fewer = await call('fling_set_audience', { name: 'team', removeGroups: ['ops'] })
    expect(fewer.structuredContent.audience.groups.map((g: { slug: string }) => g.slug)).toEqual([
      'design',
    ])
    const unknown = await call('fling_set_audience', { name: 'team', addGroups: ['nope'] })
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0]?.text).toContain('nope')

    const deleted = await call('fling_group_delete', { slug: 'ops', confirm: true })
    expect(deleted.isError).toBeFalsy()
    expect((await call('fling_group_show', { slug: 'ops' })).isError).toBe(true)
  })
})
