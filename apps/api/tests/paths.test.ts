/**
 * Paths through the API and publication's own interface (paths.ts): a one-folder path publish
 * makes the folder's Path and publishes to it; who may publish to a Path; Paths published at once
 * never collide; the site's home page lists them; and what the edge serves, through the real
 * routing decision (site-routing.ts) over the route table and the bucket.
 */
import { createHmac } from 'node:crypto'
import { routeSiteRequest } from '@fling/shared/site-routing'
import { describe, expect, it } from 'vitest'
import type { Principal } from '../src/policy.ts'
import { publishBytes } from '../src/publication.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'

type F = ReturnType<typeof file>

async function stageAs(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  return { status: res.status, body: await json(res) }
}

async function finalize(env: Env, key: string, name: string, versionId: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys/${versionId}/finalize`)
  return { status: res.status, body: await json(res) }
}

async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const staged = await stageAs(env, key, name, files, extra)
  if (staged.status !== 200 || staged.body.status !== 'upload') return staged
  await upload(env, staged.body.uploads, files)
  return finalize(env, key, name, staged.body.versionId)
}

/** What the edge serves for `uri` on the public site `name`: the body, or the status. */
async function get(env: Env, name: string, uri: string, query = '') {
  const d = await routeSiteRequest(
    { method: 'GET', host: `${name}.fling.test`, uri, query, cookie: null, pass: null },
    {
      appOrigin: APP_ORIGIN,
      siteScheme: 'https',
      nowSeconds: Math.floor(env.deps.clock.now().getTime() / 1000),
      getRoute: async k => (await env.routeTable.get(k)) ?? null,
      getCookieKey: async () => env.config.secrets.siteHmacKey,
      getRevocation: async k => (await env.routeTable.get(k)) ?? null,
      hmac: (key, data) => createHmac('sha256', key).update(data).digest('base64url'),
    }
  )
  if (d.action !== 'rewrite') return d.status
  const bytes = await env.blobs.get(decodeURIComponent(d.uri.slice(1)))
  return bytes ? Buffer.from(bytes).toString('utf8') : 404
}

const site = [file('index.html', '<title>Team</title><h1>home</h1><!-- fling:paths -->')]
const plan = (n: string, body = `<h1>${n}</h1>`) => [
  file(`${n}/index.html`, `<title>Plan ${n}</title>${body}`),
]

async function world() {
  const env = setup()
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  const carol = await createUser(env, CAROL)
  expect((await deploy(env, alice.key, 'team', site, { access: 'public' })).status).toBe(200)
  await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB, CAROL] } })
  return { env, alice, bob, carol }
}

describe('Paths', () => {
  it('a one-folder path publish makes its Path, served at /<folder>/, the site untouched', async () => {
    const { env, alice, bob } = await world()
    const before = (await env.store.findSite('team'))?.currentVersionId
    const staged = await stageAs(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    expect(staged.body.status).toBe('upload')
    expect(staged.body.uploads.map((u: { path: string }) => u.path)).toEqual(['PAY-1/index.html'])
    await upload(env, staged.body.uploads, plan('PAY-1'))
    expect((await finalize(env, bob.key, 'team', staged.body.versionId)).status).toBe(200)

    const now = await env.store.findSite('team')
    expect(now?.currentVersionId).toBe(before)
    const path = await env.store.getPath(now?.id as string, 'PAY-1')
    expect(path).toMatchObject({ owners: { emails: [BOB] }, title: 'Plan PAY-1', archived: false })
    expect(await get(env, 'team', '/PAY-1/')).toContain('<h1>PAY-1</h1>')
    expect(await get(env, 'team', '/PAY-1')).toBe(301)
    // Stored relative to the Path: its own storage id, the folder taken off.
    expect(
      await env.blobs.get(`sites/${path?.id}/${staged.body.versionId}/index.html`)
    ).not.toBeNull()
    void alice
  })

  it('lists live Paths on the home page, and at /_fling-paths.json', async () => {
    const { env, bob, carol } = await world()
    await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    env.advance(60_000)
    await deploy(env, carol.key, 'team', plan('PAY-2'), { path: 'PAY-2' })
    const home = await get(env, 'team', '/')
    expect(home).toContain('<h1>home</h1>')
    expect(home).toContain('Plan PAY-1')
    expect(home).toContain('Plan PAY-2')
    const listing = JSON.parse((await get(env, 'team', '/_fling-paths.json')) as string)
    expect(JSON.stringify(listing)).toContain('PAY-2')
    expect(JSON.stringify(listing)).not.toContain(BOB)
  })

  it('a publisher of the site can’t publish to someone else’s Path; its owner and the site’s can', async () => {
    const { env, alice, bob, carol } = await world()
    await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const refused = await stageAs(env, carol.key, 'team', plan('PAY-1', 'carol'), {
      path: 'PAY-1',
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('path_not_yours')
    expect(
      (await deploy(env, bob.key, 'team', plan('PAY-1', 'v2'), { path: 'PAY-1' })).status
    ).toBe(200)
    expect(
      (await deploy(env, alice.key, 'team', plan('PAY-1', 'v3'), { path: 'PAY-1' })).status
    ).toBe(200)
    expect(await get(env, 'team', '/PAY-1/')).toContain('v3')
  })

  it('Paths published at once never collide', async () => {
    const { env, bob, carol } = await world()
    const one = await stageAs(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const two = await stageAs(env, carol.key, 'team', plan('PAY-2'), { path: 'PAY-2' })
    await upload(env, one.body.uploads, plan('PAY-1'))
    await upload(env, two.body.uploads, plan('PAY-2'))
    expect((await finalize(env, carol.key, 'team', two.body.versionId)).status).toBe(200)
    expect((await finalize(env, bob.key, 'team', one.body.versionId)).status).toBe(200)
    expect(await get(env, 'team', '/PAY-1/')).toContain('<h1>PAY-1</h1>')
    expect(await get(env, 'team', '/PAY-2/')).toContain('<h1>PAY-2</h1>')
  })

  it('the same files again are unchanged; an earlier version is repointed', async () => {
    const { env, bob } = await world()
    const first = await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    await deploy(env, bob.key, 'team', plan('PAY-1', 'v2'), { path: 'PAY-1' })
    const back = await stageAs(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    expect(back.body).toMatchObject({ status: 'repointed', versionId: first.body.versionId })
    expect(await get(env, 'team', '/PAY-1/')).toContain('<h1>PAY-1</h1>')
    const again = await stageAs(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    expect(again.body.status).toBe('unchanged')
  })

  it('a site whose first publish is a Path gets a default home page listing it', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    const done = await deploy(env, alice.key, 'fresh', plan('PAY-9'), {
      path: 'PAY-9',
      access: 'public',
    })
    expect(done.status).toBe(200)
    expect(await get(env, 'fresh', '/')).toContain('Plan PAY-9')
    expect(await get(env, 'fresh', '/PAY-9/')).toContain('<h1>PAY-9</h1>')
  })

  it('publishBytes publishes to a Path too', async () => {
    const { env } = await world()
    const user = (await env.store.getUser(BOB)) as NonNullable<
      Awaited<ReturnType<Env['store']['getUser']>>
    >
    const principal: Principal = { email: BOB, admin: false, via: 'api_key', guest: false }
    const bytes = (s: string) => new TextEncoder().encode(s)
    const done = await publishBytes(
      env.deps,
      user,
      'team',
      [{ path: 'PAY-3/index.html', bytes: bytes('<h1>inline</h1>') }],
      { principal, path: 'PAY-3' }
    )
    expect(done.status).toBe('live')
    expect(await get(env, 'team', '/PAY-3/')).toBe('<h1>inline</h1>')
  })
})

describe('publish hints', () => {
  it('paths_index_missing from the second Path on a home page without a block; paths_block_hidden', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    await deploy(env, alice.key, 'plain', [file('index.html', '<h1>plain</h1>')])
    const first = await deploy(env, alice.key, 'plain', plan('PAY-1'), { path: 'PAY-1' })
    expect(first.body.hints).toBeUndefined()
    const second = await deploy(env, alice.key, 'plain', plan('PAY-2'), { path: 'PAY-2' })
    expect(second.body.hints?.map((h: { code: string }) => h.code)).toEqual(['paths_index_missing'])
    const hidden = await deploy(env, alice.key, 'plain', [
      file('index.html', '<h1>plain</h1><!-- fling:paths -->'),
      file('PAY-1/old.html', 'old'),
    ])
    expect(hidden.body.hints).toEqual([
      expect.objectContaining({ code: 'paths_block_hidden', folders: ['PAY-1'] }),
    ])
  })
})

describe('the Path routes', () => {
  it('list and detail: viewers see live Paths only; versions to those on the Path', async () => {
    const { env, alice, bob } = await world()
    const outsider = await createUser(env, 'dan@example.test')
    await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    await deploy(env, bob.key, 'team', plan('PAY-1', 'v2'), { path: 'PAY-1' })
    const listed = await json(await api(env, alice.key, 'GET', '/api/sites/team/paths'))
    expect(listed.paths).toEqual([
      expect.objectContaining({
        folder: 'PAY-1',
        title: 'Plan PAY-1',
        url: 'https://team.fling.test/PAY-1/',
        canPublish: true,
        owners: expect.objectContaining({ emails: [expect.objectContaining({ email: BOB })] }),
      }),
    ])
    const seen = await json(await api(env, outsider.key, 'GET', '/api/sites/team/paths'))
    expect(seen.paths[0]).toMatchObject({ folder: 'PAY-1', canPublish: false })
    expect(seen.paths[0].owners).toBeUndefined()
    const detail = await json(await api(env, bob.key, 'GET', '/api/sites/team/paths/PAY-1'))
    expect(detail.versions).toHaveLength(2)
    expect((await api(env, outsider.key, 'GET', '/api/sites/team/paths/PAY-1')).status).toBe(404)
    expect((await api(env, alice.key, 'GET', '/api/sites/team/paths/nope')).status).toBe(404)
  })

  it('rolling back one Path leaves the site and the other Paths as they are', async () => {
    const { env, bob, carol } = await world()
    const first = await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    await deploy(env, bob.key, 'team', plan('PAY-1', 'v2'), { path: 'PAY-1' })
    await deploy(env, carol.key, 'team', plan('PAY-2'), { path: 'PAY-2' })
    const res = await api(env, bob.key, 'POST', '/api/sites/team/paths/PAY-1/current', {
      versionId: first.body.versionId,
    })
    expect(res.status).toBe(200)
    expect(await get(env, 'team', '/PAY-1/')).toContain('<h1>PAY-1</h1>')
    expect(await get(env, 'team', '/PAY-2/')).toContain('<h1>PAY-2</h1>')
    expect(await get(env, 'team', '/')).toContain('<h1>home</h1>')
    // Carol publishes the site but not Bob's Path.
    const refused = await api(env, carol.key, 'POST', '/api/sites/team/paths/PAY-1/current', {
      versionId: first.body.versionId,
    })
    expect(refused.status).toBe(404)
  })

  it('its owner adds a publisher; archiving takes it off the site and the listing', async () => {
    const { env, alice, bob, carol } = await world()
    await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const shared = await api(env, bob.key, 'PATCH', '/api/sites/team/paths/PAY-1', {
      publishers: { emails: [CAROL] },
    })
    expect(shared.status).toBe(200)
    expect(
      (await deploy(env, carol.key, 'team', plan('PAY-1', 'carol'), { path: 'PAY-1' })).status
    ).toBe(200)
    expect(
      (await api(env, carol.key, 'PATCH', '/api/sites/team/paths/PAY-1', { archived: true })).status
    ).toBe(404)
    const archived = await api(env, alice.key, 'PATCH', '/api/sites/team/paths/PAY-1', {
      archived: true,
    })
    expect(archived.status).toBe(200)
    expect(await get(env, 'team', '/PAY-1/')).toBe(404)
    expect(await get(env, 'team', '/')).not.toContain('Plan PAY-1')
    await api(env, alice.key, 'PATCH', '/api/sites/team/paths/PAY-1', { archived: false })
    expect(await get(env, 'team', '/PAY-1/')).toContain('carol')
  })

  it('deleting a Path removes its route and files; deleting the site removes every Path', async () => {
    const { env, alice, bob } = await world()
    await deploy(env, bob.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    await deploy(env, bob.key, 'team', plan('PAY-2'), { path: 'PAY-2' })
    const site = await env.store.findSite('team')
    const one = await env.store.getPath(site?.id as string, 'PAY-1')
    expect((await api(env, bob.key, 'DELETE', '/api/sites/team/paths/PAY-1')).status).toBe(204)
    expect(await get(env, 'team', '/PAY-1/')).toBe(404)
    expect(await env.blobs.get(`sites/${one?.id}/${one?.currentVersionId}/index.html`)).toBeNull()
    expect(await env.store.getPath(site?.id as string, 'PAY-1')).toBeNull()
    expect((await api(env, alice.key, 'DELETE', '/api/sites/team')).status).toBe(204)
    expect([...env.routeTable.data.keys()].filter(k => k.startsWith('path:'))).toEqual([])
  })
})

describe('Markdown', () => {
  it('is served rendered, with the source at ?raw=1, and README.md stands in for index.html', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    const md = [
      file('README.md', '# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'text/markdown'),
      file('notes.md', '- [x] done\n', 'text/markdown'),
    ]
    expect((await deploy(env, alice.key, 'docs', md, { access: 'public' })).status).toBe(200)
    const home = await get(env, 'docs', '/')
    expect(home).toContain('<table>')
    expect(await get(env, 'docs', '/notes.md')).toContain('type="checkbox"')
    expect(await get(env, 'docs', '/notes.md', '?raw=1')).toBe('- [x] done\n')
  })
})
