/**
 * Access levels (access.ts in @fling/shared): who can open a new site (the level its first deploy
 * names, else the instance's default), how PATCH sets each level, what the route table and the
 * site response say, and that records from before access levels keep the access they had.
 */
import { siteKvsKey } from '@fling/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const page = [file('index.html', '<h1>hi</h1>')]

let env: Env
let alice: { key: string }
let bob: { key: string }

beforeEach(async () => {
  env = setup()
  alice = await createUser(env, 'alice@example.test')
  bob = await createUser(env, 'bob@example.test')
})

async function deploy(name: string, extra: object = {}, key = alice.key) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (res.status !== 200) return { status: res.status, body }
  if (body.status !== 'upload') return { status: res.status, body }
  await upload(env, body.uploads, page)
  const fin = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  return { status: fin.status, body: await json(fin) }
}

const patch = async (name: string, body: object) => {
  const res = await api(env, alice.key, 'PATCH', `/api/sites/${name}`, body)
  return { status: res.status, body: await json(res) }
}

const route = (name: string) => JSON.parse(env.routeTable.data.get(siteKvsKey(name)) ?? '{}')
const bobSees = async (name: string) =>
  (await api(env, bob.key, 'GET', `/api/sites/${name}/comments`)).status === 200

describe('a new site', () => {
  it("gets the instance's default: only its owner", async () => {
    const { body } = await deploy('mine')
    expect(body.site).toMatchObject({ access: 'only_me', restricted: true, audienceSize: 0 })
    expect(body.first).toBe(true)
    expect(route('mine').r).toBe(1)
    expect(await bobSees('mine')).toBe(false)
  })

  it('gets every member when SITE_DEFAULT_ACCESS is members', async () => {
    env = setup({ siteDefaultAccess: 'members' })
    alice = await createUser(env, 'alice@example.test')
    bob = await createUser(env, 'bob@example.test')
    const { body } = await deploy('open')
    expect(body.site).toMatchObject({ access: 'members', restricted: false })
    expect(route('open').r).toBeUndefined()
    expect(await bobSees('open')).toBe(true)
  })

  it('takes the level its first deploy names, with its audience', async () => {
    expect((await deploy('pub', { access: 'public' })).body.site.access).toBe('public')
    expect(route('pub').vis).toBe('public')
    // Made private, it takes the instance's default.
    expect((await patch('pub', { visibility: 'private' })).body.access).toBe('only_me')
    expect((await deploy('all', { access: 'members' })).body.site.access).toBe('members')
    await api(env, bob.key, 'POST', '/api/groups', { slug: 'design', name: 'Design' })
    const team = await deploy('team', {
      access: 'groups',
      audience: { emails: [], groups: ['design'] },
    })
    expect(team.body.site).toMatchObject({ access: 'groups', audienceGroups: 1 })
    const people = await deploy('people', {
      access: 'people',
      audience: { emails: ['bob@example.test'], groups: ['design'] },
    })
    expect(people.body.site).toMatchObject({ access: 'people', audienceSize: 2 })
    expect(await bobSees('people')).toBe(true)
  })

  it('refuses an access that does not fit its audience, claiming nothing', async () => {
    const cases: [object, number, string][] = [
      [{ access: 'people' }, 400, 'needs at least one'],
      [{ access: 'only_me', audience: { emails: ['bob@example.test'] } }, 400, 'takes no'],
      [{ audience: { emails: ['bob@example.test'] } }, 400, 'goes with `access`'],
      [{ access: 'public', visibility: 'public' }, 400, 'not both'],
      [{ access: 'people', audience: { emails: ['x@elsewhere.test'] } }, 400, 'x@elsewhere.test'],
      [{ access: 'groups', audience: { emails: [], groups: ['nope'] } }, 400, 'nope'],
      [{ access: 'nobody' }, 400, ''],
    ]
    for (const [extra, status, message] of cases) {
      const res = await deploy('claimed', extra)
      expect({ extra, status: res.status }).toEqual({ extra, status })
      expect(JSON.stringify(res.body)).toContain(message)
    }
    const check = await json(await api(env, bob.key, 'GET', '/api/names/claimed'))
    expect(check.status).toBe('available')
  })

  it('a re-deploy never changes who can open it', async () => {
    await deploy('kept')
    const again = await api(env, alice.key, 'POST', '/api/sites/kept/deploys', {
      manifest: { files: [file('index.html', '<h1>v2</h1>').meta] },
      access: 'public',
    })
    expect(again.status).toBe(200)
    const site = await json(await api(env, alice.key, 'GET', '/api/sites/kept'))
    expect(site.access).toBe('only_me')
  })
})

describe('PATCH { access }', () => {
  it('sets each level; public keeps the private settings for when it is private again', async () => {
    await deploy('site')
    const steps: [object, string, boolean][] = [
      [{ access: 'members' }, 'members', true],
      [{ access: 'people', audience: { emails: ['bob@example.test'] } }, 'people', true],
      [{ access: 'only_me' }, 'only_me', false],
      [{ access: 'public' }, 'public', true],
      [{ visibility: 'private' }, 'only_me', false],
      [{ access: 'people', audience: { emails: ['bob@example.test'] } }, 'people', true],
      [{ access: 'public' }, 'public', true],
      [{ visibility: 'private' }, 'people', true],
    ]
    for (const [body, level, sees] of steps) {
      const res = await patch('site', body)
      expect({ body, status: res.status, level: res.body.access }).toEqual({
        body,
        status: 200,
        level,
      })
      expect({ body, sees: await bobSees('site') }).toEqual({ body, sees })
      expect(route('site').r === 1).toBe(level === 'only_me' || level === 'people')
    }
    // only_me and members empty the audience
    expect((await patch('site', { access: 'only_me' })).body.audience).toEqual({
      emails: [],
      groups: [],
    })
  })

  it('refuses a level with the wrong audience, or with visibility', async () => {
    await deploy('site')
    expect((await patch('site', { access: 'groups' })).status).toBe(400)
    expect((await patch('site', { access: 'members', audience: { emails: [] } })).status).toBe(400)
    expect((await patch('site', { access: 'public', visibility: 'public' })).status).toBe(400)
    expect((await api(env, bob.key, 'PATCH', '/api/sites/site', { access: 'public' })).status).toBe(
      404
    )
  })

  it('an audience edit alone restricts the site when it names someone, and opens it when emptied', async () => {
    await deploy('site')
    expect((await patch('site', { audience: { emails: ['bob@example.test'] } })).body.access).toBe(
      'people'
    )
    expect((await patch('site', { audience: { emails: [] } })).body.access).toBe('members')
    expect(await bobSees('site')).toBe(true)
  })
})

describe('records from before access levels', () => {
  it('keep their access: open to members without an audience, restricted with one', async () => {
    await deploy('old-open', { access: 'members' })
    await deploy('old-team', { access: 'people', audience: { emails: ['bob@example.test'] } })
    for (const name of ['old-open', 'old-team']) {
      const site = await env.store.findSite(name)
      if (!site) throw new Error('missing')
      const { restricted: _, ...old } = site
      await env.store.putSite(old)
      expect((await env.store.findSite(name))?.restricted).toBeUndefined()
    }
    const sites = await json(await api(env, alice.key, 'GET', '/api/sites'))
    const access = Object.fromEntries(sites.sites.map((s: any) => [s.name, s.access]))
    expect(access).toEqual({ 'old-open': 'members', 'old-team': 'people' })
    const carol = await createUser(env, 'carol@example.test')
    expect((await api(env, carol.key, 'GET', '/api/sites/old-open/comments')).status).toBe(200)
    expect((await api(env, carol.key, 'GET', '/api/sites/old-team/comments')).status).toBe(404)
    expect(await bobSees('old-team')).toBe(true)
  })
})
