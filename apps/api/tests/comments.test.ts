/**
 * Comments through the API: threads and replies on page paths, resolve/reopen, delete, who may do
 * what (policy.ts rows, end to end), the `comments` capability, and how comments live with the
 * site (they outlive versions and go with it).
 */
import { describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const pageV = (marker: string) => [file('index.html', `<h1>${marker}</h1>`)]

async function deploy(env: Env, key: string, name: string, marker = 'v1', extra = {}) {
  const files = pageV(marker)
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return body
  await upload(env, body.uploads, files)
  return json(await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`))
}

async function twoUsers(overrides = {}) {
  const env = setup(overrides)
  const alice = await createUser(env, 'alice@example.test')
  const bob = await createUser(env, 'bob@example.test')
  const live = await deploy(env, alice.key, 'hello', 'v1', { access: 'members' })
  return { env, alice, bob, v1: live.versionId as string }
}

const add = (env: Env, key: string, body: object, name = 'hello') =>
  api(env, key, 'POST', `/api/sites/${name}/comments`, body)
const list = async (env: Env, key: string, query = '') =>
  json(await api(env, key, 'GET', `/api/sites/hello/comments${query}`))

describe('comments', () => {
  it('a member starts a thread, the owner replies; listed oldest first with the site', async () => {
    const { env, alice, bob, v1 } = await twoUsers()
    const res = await add(env, bob.key, {
      body: '  The heading is too big  ',
      path: 'https://hello.fling.test/docs/index.html?x=1#top',
      anchor: { x: 10, y: 20.5 },
    })
    expect(res.status).toBe(201)
    const thread = await json(res)
    expect(thread).toMatchObject({
      parentId: null,
      path: '/docs/',
      versionId: v1,
      anchor: { x: 10, y: 20.5 },
      body: 'The heading is too big',
      author: { kind: 'user', email: 'bob@example.test' },
      createdAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      canDelete: true,
    })
    env.advance(1000)
    // A reply takes the thread's path and has no anchor of its own.
    const reply = await json(
      await add(env, alice.key, {
        body: 'Fixed',
        parentId: thread.id,
        path: '/',
        anchor: { x: 1, y: 1 },
      })
    )
    expect(reply).toMatchObject({ parentId: thread.id, path: '/docs/', anchor: null })

    const asBob = await list(env, bob.key)
    expect(asBob.site).toEqual({
      name: 'hello',
      url: 'https://hello.fling.test/',
      currentVersionId: v1,
    })
    expect(asBob.comments.map((c: { id: string }) => c.id)).toEqual([thread.id, reply.id])
    expect(asBob.comments.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([true, false])
    expect(asBob.can).toEqual({ create: true, resolve: true, deleteAny: false })
    const asAlice = await list(env, alice.key)
    expect(asAlice.comments.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([true, true])
    expect(asAlice.can).toEqual({ create: true, resolve: true, deleteAny: true })

    expect((await list(env, bob.key, '?path=/docs/index.html')).comments).toHaveLength(2)
    expect((await list(env, bob.key, '?path=/')).comments).toEqual([])
  })

  it('only threads resolve; anyone taking part may resolve and reopen', async () => {
    const { env, alice, bob } = await twoUsers()
    const thread = await json(await add(env, alice.key, { body: 'Typo in the footer' }))
    const reply = await json(await add(env, bob.key, { body: 'Where?', parentId: thread.id }))
    const patch = (key: string, id: string, resolved: boolean) =>
      api(env, key, 'PATCH', `/api/sites/hello/comments/${id}`, { resolved })

    env.advance(60_000)
    const resolved = await json(await patch(bob.key, thread.id, true))
    expect(resolved).toMatchObject({
      resolvedAt: '2026-01-01T00:01:00.000Z',
      resolvedBy: { kind: 'user', email: 'bob@example.test' },
    })
    const reopened = await json(await patch(alice.key, thread.id, false))
    expect(reopened).toMatchObject({ resolvedAt: null, resolvedBy: null })

    const onReply = await patch(alice.key, reply.id, true)
    expect(onReply.status).toBe(400)
    expect((await patch(alice.key, 'nope', true)).status).toBe(404)
    // Replies to replies are refused: threads are one level deep.
    expect((await add(env, alice.key, { body: 'x', parentId: reply.id })).status).toBe(400)
    expect((await add(env, alice.key, { body: 'x', parentId: 'nope' })).status).toBe(404)
  })

  it('authors delete their own; the owner deletes any (a thread with its replies)', async () => {
    const { env, alice, bob } = await twoUsers()
    const carol = await createUser(env, 'carol@example.test')
    const bobs = await json(await add(env, bob.key, { body: "Bob's" }))
    const carols = await json(await add(env, carol.key, { body: "Carol's" }))
    await add(env, alice.key, { body: 'reply', parentId: bobs.id })
    const del = (key: string, id: string) =>
      api(env, key, 'DELETE', `/api/sites/hello/comments/${id}`)

    const refused = await del(bob.key, carols.id)
    expect(refused.status).toBe(403)
    expect((await json(refused)).error.message).toMatch(/author, the site owner or an admin/)
    expect((await del(carol.key, carols.id)).status).toBe(204)
    expect((await del(alice.key, bobs.id)).status).toBe(204)
    expect((await list(env, bob.key)).comments).toEqual([])
    expect((await del(alice.key, bobs.id)).status).toBe(404)
  })

  it('validates the body and the path', async () => {
    const { env, bob } = await twoUsers()
    for (const body of [{}, { body: '   ' }, { body: 'x'.repeat(4001) }]) {
      expect((await add(env, bob.key, body)).status).toBe(400)
    }
    expect((await add(env, bob.key, { body: 'x', path: '/a b' })).status).toBe(400)
    expect((await add(env, bob.key, { body: 'x', path: '/../etc' })).status).toBe(400)
    expect((await add(env, bob.key, { body: 'x', anchor: { x: 101, y: 0 } })).status).toBe(400)
    expect((await api(env, bob.key, 'GET', '/api/sites/hello/comments?path=/a%20b')).status).toBe(
      400
    )
  })

  it('outlive new versions (showing the one they were made on) and go with the site', async () => {
    const { env, alice, bob, v1 } = await twoUsers()
    await add(env, bob.key, { body: 'On v1' })
    const v2 = (await deploy(env, alice.key, 'hello', 'v2')).versionId
    expect(v2).not.toBe(v1)
    env.advance(1000)
    await add(env, bob.key, { body: 'On v2' })
    const { site, comments } = await list(env, bob.key)
    expect(site.currentVersionId).toBe(v2)
    expect(comments.map((c: { versionId: string }) => c.versionId)).toEqual([v1, v2])

    const siteId = (await env.store.findSite('hello'))?.id as string
    expect(await env.store.listComments(siteId)).toHaveLength(2)
    expect((await api(env, alice.key, 'DELETE', '/api/sites/hello')).status).toBe(204)
    expect(await env.store.listComments(siteId)).toEqual([])
    // A new site of the same name starts with none.
    await deploy(env, bob.key, 'hello')
    expect((await list(env, bob.key)).comments).toEqual([])
  })

  it('anonymous callers are refused; an unknown site is a 404', async () => {
    const { env, bob } = await twoUsers()
    expect((await env.app.request('/api/sites/hello/comments')).status).toBe(401)
    const missing = await api(env, bob.key, 'GET', '/api/sites/nope/comments')
    expect(missing.status).toBe(404)
    expect((await json(missing)).error.message).toBe('No site named "nope"')
    expect((await add(env, bob.key, { body: 'x' }, 'nope')).status).toBe(404)
  })

  it('with comments turned off: no capability, and every route is a 404', async () => {
    const { env, alice } = await twoUsers({ comments: false })
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.comments).toBe(false)
    for (const [method, path, body] of [
      ['GET', '/api/sites/hello/comments'],
      ['POST', '/api/sites/hello/comments', { body: 'x' }],
      ['PATCH', '/api/sites/hello/comments/x', { resolved: true }],
      ['DELETE', '/api/sites/hello/comments/x'],
    ] as const) {
      const res = await api(env, alice.key, method, path, body)
      expect({ method, status: res.status }).toEqual({ method, status: 404 })
      expect((await json(res)).error.message).toBe('Comments are turned off on this instance')
    }
  })

  it('a site holds at most COMMENTS_PER_SITE_MAX comments', async () => {
    const { env, alice } = await twoUsers()
    const site = await env.store.findSite('hello')
    for (let i = 0; i < 1000; i++) {
      await env.store.createComment({
        siteId: site?.id as string,
        id: `c${String(i).padStart(4, '0')}`,
        parentId: null,
        path: '/',
        versionId: null,
        anchor: null,
        body: 'x',
        author: { kind: 'user', email: 'alice@example.test' },
        createdAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
      })
    }
    const res = await add(env, alice.key, { body: 'one more' })
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('too_many_comments')
  })

  it('cookie sessions need the app Origin to write (CSRF), like every other route', async () => {
    const { env, bob } = await twoUsers()
    const cookie = `${env.config.secureCookies ? '__Host-fling_session' : 'fling_session'}=${bob.session}`
    const post = (origin: string) =>
      env.app.request('/api/sites/hello/comments', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'from the review page' }),
      })
    // A site's own pages are same-site with the app but another origin: refused.
    expect((await post('https://hello.fling.test')).status).toBe(403)
    expect((await post(env.config.appOrigin)).status).toBe(201)
  })
})
