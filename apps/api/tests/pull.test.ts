/**
 * Pull (`GET /api/sites/:name/pull`): who may pull which version, what it answers (paths, hashes,
 * signed URLs whose bytes are the version's), and `path`; and the remote MCP's side of it,
 * fling_read_files, then fling_publish and fling_upload_* with `base` and `remove`.
 */
import { createHash } from 'node:crypto'
import { MCP_READ_MAX_BYTES } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'

type F = ReturnType<typeof file>

const v1 = [
  file('index.html', '<h1>v1</h1>'),
  file('about.html', '<h1>about</h1>'),
  file('30-10-26/index.html', '<h1>week</h1>'),
]

async function deploy(env: Env, key: string, name: string, files: F[]) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
  })
  const body = await json(res)
  expect(res.status).toBe(200)
  if (body.status !== 'upload') return body.versionId as string
  await upload(env, body.uploads, files)
  const done = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  expect(done.status).toBe(200)
  return body.versionId as string
}

/** Alice's site `team`, two versions, restricted to Bob; Carol is any other member. */
async function world() {
  const env = setup()
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  const carol = await createUser(env, CAROL)
  const first = await deploy(env, alice.key, 'team', v1)
  const current = await deploy(env, alice.key, 'team', [...v1, file('new.html', '<h1>new</h1>')])
  const patch = await api(env, alice.key, 'PATCH', '/api/sites/team', {
    access: 'people',
    audience: { emails: [BOB] },
  })
  expect(patch.status).toBe(200)
  return { env, alice, bob, carol, first, current }
}

const pull = (env: Env, key: string, query = '') =>
  api(env, key, 'GET', `/api/sites/team/pull${query}`)

describe('pull', () => {
  it('gives the current version’s files with their hashes and URLs that serve their bytes', async () => {
    const { env, bob, current } = await world()
    const res = await pull(env, bob.key)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await json(res)
    expect(body.versionId).toBe(current)
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(env.deps.clock.now().getTime())
    expect(body.files.map((f: { path: string }) => f.path)).toEqual([
      '30-10-26/index.html',
      'about.html',
      'index.html',
      'new.html',
    ])
    for (const f of body.files) {
      const bytes = new Uint8Array(await (await env.app.request(f.url)).arrayBuffer())
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256)
      expect(bytes.byteLength).toBe(f.size)
    }
    expect(body.files.find((f: { path: string }) => f.path === 'new.html')).toMatchObject({
      contentType: 'text/html',
    })
  })

  it('`path` keeps one folder’s files, with their site paths; a bad path is a 400', async () => {
    const { env, alice } = await world()
    const body = await json(await pull(env, alice.key, '?path=/30-10-26/'))
    expect(body.path).toBe('30-10-26')
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(['30-10-26/index.html'])
    expect((await pull(env, alice.key, '?path=../x')).status).toBe(400)
  })

  it('anyone who can see the site pulls its current version; nobody else, as if it were missing', async () => {
    const { env, alice, bob, carol } = await world()
    expect((await pull(env, alice.key)).status).toBe(200)
    expect((await pull(env, bob.key)).status).toBe(200)
    const refused = await pull(env, carol.key)
    expect(refused.status).toBe(404)
    expect((await json(refused)).error.message).toBe('No site named "team"')
    // Open to every member, Carol may.
    await api(env, alice.key, 'PATCH', '/api/sites/team', { access: 'members' })
    expect((await pull(env, carol.key)).status).toBe(200)
    // Without a sign-in, nobody may.
    expect((await env.app.request('/api/sites/team/pull')).status).toBe(401)
  })

  it('an older version needs an owner, publisher or admin; a viewer gets a 404', async () => {
    const { env, alice, bob, first } = await world()
    expect((await pull(env, bob.key, `?version=${first}`)).status).toBe(404)
    const owner = await pull(env, alice.key, `?version=${first}`)
    expect(owner.status).toBe(200)
    expect((await json(owner)).files).toHaveLength(3)
    expect((await pull(env, alice.key, '?version=nope')).status).toBe(404)
    // A publisher may too.
    await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB] } })
    expect((await pull(env, bob.key, `?version=${first}`)).status).toBe(200)
  })

  it('an archived site is its owners’ to pull, and a site never live is nobody’s', async () => {
    const { env, alice, bob } = await world()
    await api(env, alice.key, 'POST', '/api/sites/team/archive')
    expect((await pull(env, bob.key)).status).toBe(404)
    expect((await pull(env, alice.key)).status).toBe(200)

    const staged = await api(env, alice.key, 'POST', '/api/sites/draft/deploys', {
      manifest: { files: v1.map(f => f.meta) },
    })
    expect(staged.status).toBe(200)
    const never = await api(env, alice.key, 'GET', '/api/sites/draft/pull')
    expect(never.status).toBe(404)
    expect((await json(never)).error.message).toBe('"draft" is not live')
  })

  it('each URL is signed for its own file', async () => {
    const { env, alice } = await world()
    const [a, b] = (await json(await pull(env, alice.key))).files as { url: string }[]
    const swapped = new URL(a?.url as string)
    swapped.search = new URL(b?.url as string).search
    expect((await env.app.request(swapped.toString())).status).toBe(403)
  })
})

describe('the remote MCP tools', () => {
  it('fling_read_files returns the contents and the base; fling_publish on it changes only what is sent', async () => {
    const { env, alice, current } = await world()
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2])
    // A binary file, so the read returns it as base64.
    const bin = await api(env, alice.key, 'POST', '/api/sites/team/deploys', {
      base: current,
      partial: true,
      manifest: {
        files: [
          {
            path: 'img/a.png',
            sha256: createHash('sha256').update(png).digest('hex'),
            size: png.length,
            contentType: 'image/png',
          },
        ],
      },
    })
    const staged = await json(bin)
    for (const u of staged.uploads) {
      await env.app.request(u.url, { method: 'PUT', headers: u.headers, body: png })
    }
    await api(env, alice.key, 'POST', `/api/sites/team/deploys/${staged.versionId}/finalize`)

    // Bob, a viewer, may read.
    const viewer = await connect(env, BOB)
    const read = await callTool(env, viewer.accessToken, 'fling_read_files', { name: 'team' })
    expect(read.isError).toBeFalsy()
    const data = read.structuredContent
    expect(data.versionId).toBe(staged.versionId)
    const byPath = Object.fromEntries(
      data.files.map((f: { path: string }) => [f.path, f])
    ) as Record<string, { encoding: string; content: string }>
    expect(byPath['index.html']).toMatchObject({ encoding: 'utf8', content: '<h1>v1</h1>' })
    expect(byPath['img/a.png']?.encoding).toBe('base64')
    expect([...Buffer.from(byPath['img/a.png']?.content ?? '', 'base64')]).toEqual([...png])
    expect(read.content[0]?.text).toContain(`base "${staged.versionId}"`)
    const some = await callTool(env, viewer.accessToken, 'fling_read_files', {
      name: 'team',
      paths: ['about.html', 'nope.html'],
    })
    expect(some.structuredContent.files.map((f: { path: string }) => f.path)).toEqual([
      'about.html',
    ])
    expect(some.structuredContent.missing).toEqual(['nope.html'])
    // …but not publish.
    const refused = await callTool(env, viewer.accessToken, 'fling_publish', {
      name: 'team',
      base: data.versionId,
      files: [{ path: 'index.html', content: '<h1>bob</h1>' }],
    })
    expect(refused.isError).toBe(true)

    const owner = await connect(env, ALICE)
    const pub = await callTool(env, owner.accessToken, 'fling_publish', {
      name: 'team',
      base: data.versionId,
      files: [{ path: 'index.html', content: '<h1>v2</h1>' }],
      remove: ['about.html'],
    })
    expect(pub.isError).toBeFalsy()
    expect(pub.content[0]?.text).toContain(`on version ${data.versionId}`)
    const after = await json(await pull(env, alice.key))
    expect(after.files.map((f: { path: string }) => f.path)).toEqual([
      '30-10-26/index.html',
      'img/a.png',
      'index.html',
      'new.html',
    ])

    // The same base again is stale.
    const stale = await callTool(env, owner.accessToken, 'fling_publish', {
      name: 'team',
      base: data.versionId,
      files: [{ path: 'new.html', content: '<h1>again</h1>' }],
    })
    expect(stale.isError).toBe(true)
    expect(stale.content[0]?.text).toContain('base_changed')

    // Chunked: removing alone, on the new base.
    const begun = await callTool(env, owner.accessToken, 'fling_upload_begin', {
      name: 'team',
      base: pub.structuredContent.versionId,
      remove: ['new.html'],
    })
    expect(begun.isError).toBeFalsy()
    const done = await callTool(env, owner.accessToken, 'fling_upload_finish', {
      uploadId: begun.structuredContent.uploadId,
    })
    expect(done.isError).toBeFalsy()
    expect((await json(await pull(env, alice.key))).files).toHaveLength(3)
  })

  it('fling_read_files pages by size, with a cursor', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    const big = 'x'.repeat(MCP_READ_MAX_BYTES / 2 + 1)
    await deploy(env, alice.key, 'team', [
      file('a.html', big),
      file('b.html', big),
      file('c.html', 'c'),
    ])
    const { accessToken } = await connect(env, ALICE)
    const first = await callTool(env, accessToken, 'fling_read_files', { name: 'team' })
    expect(first.structuredContent.files.map((f: { path: string }) => f.path)).toEqual(['a.html'])
    const next = await callTool(env, accessToken, 'fling_read_files', {
      name: 'team',
      cursor: first.structuredContent.nextCursor,
    })
    expect(next.structuredContent.files.map((f: { path: string }) => f.path)).toEqual([
      'b.html',
      'c.html',
    ])
    expect(next.structuredContent.nextCursor).toBeUndefined()
  })
})
