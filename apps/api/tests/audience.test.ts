/**
 * Audiences through the API and the remote MCP server: setting one (checked against the email
 * policy, reported with who has signed in), what the owner sees, the route value the edge reads,
 * and who may then use the site's comments.
 */
import { siteKvsKey } from '@fling/shared'
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

async function team() {
  const env = setup()
  const alice = await createUser(env, 'alice@example.test')
  const bob = await createUser(env, 'bob@example.test')
  const carol = await createUser(env, 'carol@example.test')
  await deploy(env, alice.key, 'team')
  const restrict = (emails: string[]) =>
    api(env, alice.key, 'PATCH', '/api/sites/team', { audience: { emails } })
  return { env, alice, bob, carol, restrict }
}

const route = (env: ReturnType<typeof setup>) =>
  JSON.parse(env.routeTable.data.get(siteKvsKey('team')) ?? '{}')

describe('PATCH /api/sites/:name { audience }', () => {
  it('sets it, normalised, saying who has signed in; the route value marks the site restricted', async () => {
    const { env, restrict } = await team()
    expect(route(env).r).toBeUndefined()
    const res = await restrict([' Bob@Example.test ', 'new@example.test', 'bob@example.test'])
    expect(res.status).toBe(200)
    const site = await json(res)
    expect(site.audience).toEqual({
      emails: [
        { email: 'bob@example.test', known: true },
        { email: 'new@example.test', known: false },
      ],
      groups: [],
    })
    expect(site).toMatchObject({ restricted: true, audienceSize: 2 })
    expect(route(env).r).toBe(1)
  })

  it('refuses an address the instance would not let sign in, and changes nothing', async () => {
    const { env, alice, restrict } = await team()
    const res = await restrict(['bob@example.test', 'eve@elsewhere.test'])
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error.code).toBe('email_not_allowed')
    expect(body.error.message).toContain('eve@elsewhere.test')
    expect(body.error.message).not.toContain('bob@example.test')
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.audience.emails).toEqual([])
  })

  it('refuses groups (not on this instance) and more than 100 addresses', async () => {
    const { env, alice, restrict } = await team()
    const groups = await api(env, alice.key, 'PATCH', '/api/sites/team', {
      audience: { emails: [], groups: ['g1'] },
    })
    expect(groups.status).toBe(400)
    expect(JSON.stringify(await json(groups))).toMatch(/Groups are not available/)
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@example.test`)
    expect((await restrict(many)).status).toBe(400)
  })

  it('is kept but ignored while public: not restricted, no route mark; private again restores it', async () => {
    const { env, alice, restrict } = await team()
    await restrict(['bob@example.test'])
    const pub = await json(
      await api(env, alice.key, 'PATCH', '/api/sites/team', { visibility: 'public' })
    )
    expect(pub).toMatchObject({ restricted: false, audienceSize: 1 })
    expect(route(env).r).toBeUndefined()
    await api(env, alice.key, 'PATCH', '/api/sites/team', { visibility: 'private' })
    expect(route(env).r).toBe(1)
    const cleared = await json(await restrict([]))
    expect(cleared).toMatchObject({ restricted: false, audienceSize: 0 })
    expect(route(env).r).toBeUndefined()
  })

  it('the owner sees the audience in the site detail and the list', async () => {
    const { env, alice, restrict } = await team()
    await restrict(['bob@example.test'])
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.audience.emails).toEqual([{ email: 'bob@example.test', known: true }])
    const list = await json(await api(env, alice.key, 'GET', '/api/sites'))
    expect(list.sites[0]).toMatchObject({ name: 'team', restricted: true, audienceSize: 1 })
  })
})

describe('a restricted site', () => {
  it('its comments and live room are for the owner and the audience only', async () => {
    const { env, alice, bob, carol, restrict } = await team()
    const comments = (key: string) => api(env, key, 'GET', '/api/sites/team/comments')
    expect((await comments(carol.key)).status).toBe(200)
    await restrict(['bob@example.test'])
    expect((await comments(alice.key)).status).toBe(200)
    expect((await comments(bob.key)).status).toBe(200)
    const refused = await comments(carol.key)
    expect(refused.status).toBe(404)
    expect((await json(refused)).error.message).toBe('No site named "team"')
    const post = await api(env, carol.key, 'POST', '/api/sites/team/comments', { body: 'hi' })
    expect(post.status).toBe(404)
    const posted = await api(env, bob.key, 'POST', '/api/sites/team/comments', { body: 'hi' })
    expect(posted.status).toBe(201)
  })
})

describe('fling_set_audience and fling_info', () => {
  it('adds, removes, replaces and clears, and fling_info says who can open the site', async () => {
    const { env, alice } = await team()
    const { accessToken } = await connect(env, alice.user.email)
    const call = (args: object) =>
      callTool(env, accessToken, 'fling_set_audience', { name: 'team', ...args })

    const added = await call({ add: ['bob@example.test', 'new@example.test'] })
    expect(added.isError).toBeFalsy()
    expect(added.content[0]?.text).toContain('Restricted: only you and 2 people can open it')
    expect(added.content[0]?.text).toContain("new@example.test (hasn't signed in yet)")
    expect(added.structuredContent.restricted).toBe(true)

    const removed = await call({ remove: ['new@example.test'] })
    expect(removed.structuredContent.audience.emails).toEqual([
      { email: 'bob@example.test', known: true },
    ])
    const replaced = await call({ set: ['carol@example.test'] })
    expect(
      replaced.structuredContent.audience.emails.map((e: { email: string }) => e.email)
    ).toEqual(['carol@example.test'])
    const info = await callTool(env, accessToken, 'fling_info', { name: 'team' })
    expect(info.content[0]?.text).toContain('Restricted: only you and 1 person can open it')

    const share = await callTool(env, accessToken, 'fling_share', { name: 'team' })
    expect(share.isError).toBeFalsy()
    const warned = await callTool(env, accessToken, 'fling_info', { name: 'team' })
    expect(warned.content[0]?.text).toContain('A share link is active')

    const cleared = await call({ clear: true })
    expect(cleared.content[0]?.text).toContain('Private: anyone signed in to Fling')
    expect((await call({})).isError).toBe(true)
    const bad = await call({ add: ['eve@elsewhere.test'] })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toContain('eve@elsewhere.test')
  })
})
