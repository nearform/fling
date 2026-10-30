/**
 * Owners and publishers through the API: setting them (members only, the caps, groups by slug, at
 * least one person owner, someone in both lists an owner), what a publisher may do (deploy, roll
 * back, read; no share link, no settings), the lists of sites each person sees, and deleting a
 * group that holds a role.
 */
import { describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const DAN = 'dan@example.test'

const pageOf = (text: string) => [file('index.html', `<h1>${text}</h1>`)]

/** Deploy `files` to `name` with the key; the finalize response (or the deploy's, if not new). */
async function deploy(
  env: Env,
  key: string,
  name: string,
  files = pageOf('hi'),
  extra: object = {}
) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (res.status !== 200 || body.status !== 'upload') return { status: res.status, body }
  await upload(env, body.uploads, files)
  const done = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  return { status: done.status, body: await json(done) }
}

/** Alice owns `team` (members-level, live); Bob, Carol and Dan are members. */
async function world(overrides = {}) {
  const env = setup(overrides)
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  const carol = await createUser(env, CAROL)
  const dan = await createUser(env, DAN)
  expect((await deploy(env, alice.key, 'team', pageOf('v1'), { access: 'members' })).status).toBe(
    200
  )
  const patch = (key: string, body: object) => api(env, key, 'PATCH', '/api/sites/team', body)
  return { env, alice, bob, carol, dan, patch }
}

const names = async (env: Env, key: string, path = '/api/sites') =>
  ((await json(await api(env, key, 'GET', path))).sites as { name: string }[]).map(s => s.name)

describe('PATCH /api/sites/:name { owners, publishers }', () => {
  it('sets them, reports them, and keeps someone in both lists an owner only', async () => {
    const { env, alice, patch } = await world()
    await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design',
      members: [DAN],
    })
    const res = await patch(alice.key, {
      owners: { emails: [ALICE, ' Bob@Example.test '] },
      publishers: { emails: [BOB, CAROL], groups: ['design'] },
    })
    expect(res.status).toBe(200)
    const site = await json(res)
    expect(site.role).toBe('owner')
    expect(site.owners).toEqual({
      emails: [
        { email: ALICE, known: true },
        { email: BOB, known: true },
      ],
      groups: [],
    })
    expect(site.publishers.emails.map((e: { email: string }) => e.email)).toEqual([CAROL])
    expect(site.publishers.groups).toEqual([{ slug: 'design', name: 'Design', size: 1 }])
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.owners).toEqual(site.owners)
    expect(detail.publishers).toEqual(site.publishers)
    expect(detail.owner).toBe(ALICE)
  })

  it('keeps at least one person as an owner: 400 last_owner, and nothing changes', async () => {
    const { env, alice, patch } = await world()
    await api(env, alice.key, 'POST', '/api/groups', { slug: 'design', name: 'Design' })
    for (const owners of [{ emails: [] }, { emails: [], groups: ['design'] }]) {
      const res = await patch(alice.key, { owners })
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe('last_owner')
    }
    const site = await env.store.findSite('team')
    expect(site?.owners).toEqual({ emails: [ALICE], groups: [] })
  })

  it('takes members only: an address outside the email policy, or a guest, is refused', async () => {
    const { env, alice, patch } = await world({ invites: true })
    const outside = await patch(alice.key, { publishers: { emails: ['eve@elsewhere.test'] } })
    expect(outside.status).toBe(400)
    expect((await json(outside)).error.code).toBe('email_not_allowed')
    // Naming someone as an owner invites nobody.
    expect(await env.store.getInvitation('eve@elsewhere.test')).toBeNull()
    const now = env.deps.clock.now().toISOString()
    for (const [email, role] of [
      ['guest@elsewhere.test', 'guest'],
      ['pat@elsewhere.test', 'member'],
    ] as const) {
      await env.store.putInvitation({ email, role, invitedBy: ALICE, via: 'admin', createdAt: now })
    }
    const guest = await patch(alice.key, { owners: { emails: [ALICE, 'guest@elsewhere.test'] } })
    expect(guest.status).toBe(400)
    expect((await json(guest)).error.code).toBe('email_not_allowed')
    const member = await patch(alice.key, { owners: { emails: [ALICE, 'pat@elsewhere.test'] } })
    expect(member.status).toBe(200)
  })

  it('refuses an unknown group, and lists past their caps', async () => {
    const { alice, patch } = await world()
    const unknown = await patch(alice.key, { publishers: { emails: [], groups: ['nope'] } })
    expect(unknown.status).toBe(400)
    expect((await json(unknown)).error.code).toBe('unknown_group')
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.test`)
    expect((await patch(alice.key, { owners: { emails: many } })).status).toBe(400)
  })

  it('is for owners: a publisher gets 404 like anyone else', async () => {
    const { bob, patch, alice } = await world()
    await patch(alice.key, { publishers: { emails: [BOB] } })
    for (const body of [
      { publishers: { emails: [BOB, CAROL] } },
      { owners: { emails: [ALICE, BOB] } },
      { access: 'only_me' },
      { spa: true },
    ]) {
      expect((await patch(bob.key, body)).status).toBe(404)
    }
  })
})

describe('a publisher', () => {
  it('deploys and rolls back, reads the site without its share link, and changes nothing else', async () => {
    const { env, alice, bob, patch } = await world()
    await api(env, alice.key, 'POST', '/api/sites/team/share')
    await patch(alice.key, { publishers: { emails: [BOB] } })
    expect((await json(await api(env, bob.key, 'GET', '/api/names/team'))).status).toBe('yours')

    const first = (await env.store.findSite('team'))?.currentVersionId
    const published = await deploy(env, bob.key, 'team', pageOf('v2'))
    expect(published.status).toBe(200)
    expect(published.body.site).toMatchObject({ role: 'publisher', shareUrl: null })

    const detail = await json(await api(env, bob.key, 'GET', '/api/sites/team'))
    expect(detail.role).toBe('publisher')
    expect(detail.shareUrl).toBeNull()
    const mine = detail.versions.find((v: { id: string }) => v.id === published.body.versionId)
    expect(mine.publishedBy).toBe(BOB)
    expect(detail.owners.emails.map((e: { email: string }) => e.email)).toEqual([ALICE])

    const back = await api(env, bob.key, 'POST', '/api/sites/team/current', { versionId: first })
    expect(back.status).toBe(200)

    for (const [method, path] of [
      ['POST', '/api/sites/team/share'],
      ['DELETE', '/api/sites/team/share'],
      ['POST', '/api/sites/team/archive'],
      ['DELETE', '/api/sites/team'],
    ] as const) {
      expect({ path, status: (await api(env, bob.key, method, path)).status }).toEqual({
        path,
        status: 404,
      })
    }
    const listed = await json(await api(env, bob.key, 'GET', '/api/sites'))
    expect(listed.sites).toEqual([expect.objectContaining({ name: 'team', role: 'publisher' })])
    expect(listed.sites[0].shareUrl).toBeNull()
  })

  it("can't change the site's settings by deploying: 400 owner_only, and nothing is stored", async () => {
    const { env, alice, bob, patch } = await world()
    await patch(alice.key, { publishers: { emails: [BOB] } })
    for (const extra of [{ visibility: 'public' }, { spa: true }]) {
      const res = await deploy(env, bob.key, 'team', pageOf('v2'), extra)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('owner_only')
    }
    // The settings it already has are fine.
    expect(
      (await deploy(env, bob.key, 'team', pageOf('v2'), { visibility: 'private' })).status
    ).toBe(200)
    expect(await env.store.findSite('team')).toMatchObject({ visibility: 'private', spa: false })
  })

  it("can't restore an archived site by deploying: 400 owner_only, and it stays archived", async () => {
    const { env, alice, bob, patch } = await world()
    await patch(alice.key, { publishers: { emails: [BOB] } })
    const v1 = (await env.store.findSite('team'))?.currentVersionId
    // A pending version staged while the site was live can't be made live once it is archived.
    const files = pageOf('v3')
    const staged = await json(
      await api(env, bob.key, 'POST', '/api/sites/team/deploys', {
        manifest: { files: files.map(f => f.meta) },
      })
    )
    await upload(env, staged.uploads, files)
    expect((await api(env, alice.key, 'POST', '/api/sites/team/archive')).status).toBe(200)
    for (const content of ['v2', 'v1']) {
      const res = await deploy(env, bob.key, 'team', pageOf(content))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('owner_only')
    }
    const finalize = await api(
      env,
      bob.key,
      'POST',
      `/api/sites/team/deploys/${staged.versionId}/finalize`
    )
    expect(finalize.status).toBe(400)
    expect((await json(finalize)).error.code).toBe('owner_only')
    expect(await env.store.findSite('team')).toMatchObject({ archived: true, currentVersionId: v1 })
    // An owner's deploy restores it.
    expect((await deploy(env, alice.key, 'team', pageOf('v2'))).status).toBe(200)
    expect(await env.store.findSite('team')).toMatchObject({ archived: false })
  })

  it("making an owner's staged version live applies only what the publisher may change", async () => {
    const { env, alice, bob, patch } = await world()
    await patch(alice.key, { publishers: { emails: [BOB] } })
    const files = pageOf('v2')
    const staged = await json(
      await api(env, alice.key, 'POST', '/api/sites/team/deploys', {
        manifest: { files: files.map(f => f.meta) },
        visibility: 'public',
        spa: true,
      })
    )
    await upload(env, staged.uploads, files)
    const res = await api(
      env,
      bob.key,
      'POST',
      `/api/sites/team/deploys/${staged.versionId}/finalize`
    )
    expect(res.status).toBe(200)
    expect(await env.store.findSite('team')).toMatchObject({
      currentVersionId: staged.versionId,
      visibility: 'private',
      spa: false,
    })
  })

  it('through a group: its members deploy, and see the site in their list', async () => {
    const { env, alice, carol, patch } = await world()
    await api(env, alice.key, 'POST', '/api/groups', {
      slug: 'design',
      name: 'Design',
      members: [CAROL],
    })
    await patch(alice.key, { publishers: { emails: [], groups: ['design'] } })
    expect((await deploy(env, carol.key, 'team', pageOf('v2'))).status).toBe(200)
    expect(await names(env, carol.key)).toEqual(['team'])
  })
})

describe('owners', () => {
  it('are equal: the creator taken out of the owners loses the site, and a co-owner deletes it', async () => {
    const { env, alice, bob, patch } = await world()
    expect((await patch(alice.key, { owners: { emails: [ALICE, BOB] } })).status).toBe(200)
    expect(await names(env, bob.key)).toEqual(['team'])
    const res = await patch(bob.key, { owners: { emails: [BOB] } })
    expect(res.status).toBe(200)
    expect(await names(env, alice.key)).toEqual([])
    expect(await names(env, bob.key)).toEqual(['team'])
    expect((await api(env, alice.key, 'GET', '/api/sites/team')).status).toBe(404)
    expect((await json(await api(env, bob.key, 'GET', '/api/sites/team'))).owner).toBe(BOB)
    expect((await api(env, bob.key, 'DELETE', '/api/sites/team')).status).toBe(204)
    expect(await env.store.findSite('team')).toBeNull()
    expect(await env.store.listRoleSites(BOB)).toEqual([])
  })

  it('a site its users hold a role on is not shared with them', async () => {
    const { env, alice, bob, patch } = await world()
    await patch(alice.key, { audience: { emails: [BOB] } })
    expect(await names(env, bob.key, '/api/shared')).toEqual(['team'])
    await patch(alice.key, { publishers: { emails: [BOB] } })
    expect(await names(env, bob.key, '/api/shared')).toEqual([])
    expect(await names(env, bob.key)).toEqual(['team'])
  })
})

describe('deleting a group', () => {
  it("takes it out of every site's owners and publishers", async () => {
    const { env, alice, carol, patch } = await world()
    await api(env, alice.key, 'POST', '/api/groups', { slug: 'ops', name: 'Ops', members: [CAROL] })
    await patch(alice.key, {
      owners: { emails: [ALICE], groups: ['ops'] },
      publishers: { emails: [], groups: [] },
    })
    const group = await env.store.findGroup('ops')
    expect(await names(env, carol.key)).toEqual(['team'])
    expect((await api(env, alice.key, 'DELETE', '/api/groups/ops')).status).toBe(204)
    const site = await env.store.findSite('team')
    expect(site?.owners).toEqual({ emails: [ALICE], groups: [] })
    expect(await env.store.listGroupRoleSites(group?.id ?? '')).toEqual([])
    expect(await names(env, carol.key)).toEqual([])
  })
})

describe('fling_set_owners, fling_set_publishers and fling_info', () => {
  it('edit the lists, and fling_info and fling_list show the roles', async () => {
    const { env, alice } = await world()
    await api(env, alice.key, 'POST', '/api/groups', { slug: 'ops', name: 'Ops', members: [DAN] })
    const { accessToken } = await connect(env, ALICE)
    const added = await callTool(env, accessToken, 'fling_set_publishers', {
      name: 'team',
      add: [BOB],
      addGroups: ['ops'],
    })
    expect(added.isError).toBeFalsy()
    expect(added.content[0]?.text).toContain(
      `Owners: ${ALICE}. Publishers: ${BOB}, the group ops (Ops, 1 person). You are an owner.`
    )
    const owners = await callTool(env, accessToken, 'fling_set_owners', {
      name: 'team',
      add: [CAROL],
    })
    expect(owners.structuredContent.owners.emails.map((e: { email: string }) => e.email)).toEqual([
      ALICE,
      CAROL,
    ])
    const last = await callTool(env, accessToken, 'fling_set_owners', {
      name: 'team',
      set: [],
    })
    expect(last.isError).toBe(true)
    expect(last.content[0]?.text).toContain('last_owner')
    expect((await callTool(env, accessToken, 'fling_set_owners', { name: 'team' })).isError).toBe(
      true
    )

    const asBob = (await connect(env, BOB)).accessToken
    const info = await callTool(env, asBob, 'fling_info', { name: 'team' })
    expect(info.content[0]?.text).toContain('You are a publisher.')
    const list = await callTool(env, asBob, 'fling_list', {})
    expect(list.content[0]?.text).toContain('you are a publisher')
    const refused = await callTool(env, asBob, 'fling_set_publishers', {
      name: 'team',
      add: [DAN],
    })
    expect(refused.isError).toBe(true)
    expect((await env.store.findSite('team'))?.publishers.emails).toEqual([BOB])
  })
})
