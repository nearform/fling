import { shareKvsKey, siteKvsKey } from '@fling/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

let env: Env
let key: string

beforeEach(async () => {
  env = setup()
  ;({ key } = await createUser(env))
})

const v1 = [file('index.html', '<h1>v1</h1>'), file('app.js', 'console.log(1)', 'text/javascript')]
const v2 = [file('index.html', '<h1>v2</h1>')]
const manifest = (files: typeof v1) => ({ files: files.map(f => f.meta) })

async function deployLive(files: typeof v1, name = 'hello', extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: manifest(files),
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return body
  await upload(env, body.uploads, files)
  const fin = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  expect(fin.status).toBe(200)
  return json(fin)
}

const kvsSite = (label = 'hello') => {
  const raw = env.kvs.data.get(siteKvsKey(label))
  return raw ? JSON.parse(raw) : undefined
}

describe('deploy', () => {
  it('upload → finalize → live, with presigned cache headers', async () => {
    const res = await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.status).toBe('upload')
    expect(body.versionId).toMatch(/^[a-f0-9]{16}$/)
    const html = body.uploads.find((u: any) => u.path === 'index.html')
    const js = body.uploads.find((u: any) => u.path === 'app.js')
    expect(html.headers['cache-control']).toBe('public, max-age=60')
    expect(html.headers['content-type']).toBe('text/html')
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable')

    // not live yet, and not listed
    expect(kvsSite()).toBeUndefined()
    expect((await json(await api(env, key, 'GET', '/api/sites'))).sites).toEqual([])

    await upload(env, body.uploads, v1)
    const fin = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(fin.status).toBe(200)
    const live = await json(fin)
    expect(live.status).toBe('live')
    expect(live.site).toMatchObject({
      name: 'hello',
      url: 'https://hello.fling.test/',
      visibility: 'private',
      spa: false,
      archived: false,
      currentVersionId: body.versionId,
      shareUrl: null,
    })
    const value = kvsSite()
    expect(value).toEqual({ id: expect.any(String), v: body.versionId, vis: 'private', spa: false })

    // finalize is idempotent
    const again = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(again.status).toBe(200)
  })

  it('identical content → unchanged; old content → repointed', async () => {
    const first = await deployLive(v1)
    const same = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    expect(same.status).toBe('unchanged')
    expect(same.versionId).toBe(first.versionId)

    const second = await deployLive(v2)
    expect(second.status).toBe('live')
    expect(kvsSite().v).toBe(second.versionId)

    const back = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    expect(back.status).toBe('repointed')
    expect(back.site.currentVersionId).toBe(first.versionId)
    expect(kvsSite().v).toBe(first.versionId)

    const detail = await json(await api(env, key, 'GET', '/api/sites/hello'))
    expect(detail.versions.map((v: any) => v.id).sort()).toEqual(
      [first.versionId, second.versionId].sort()
    )
  })

  it('applies spa/visibility from the deploy request', async () => {
    await deployLive(v1, 'hello', { spa: true, visibility: 'public' })
    expect(kvsSite()).toMatchObject({ spa: true, vis: 'public' })
  })

  it('finalize with missing or short files → 409 listing them', async () => {
    const body = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    await upload(
      env,
      body.uploads.filter((u: any) => u.path === 'index.html'),
      v1
    )
    const fin = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(fin.status).toBe(409)
    const err = await json(fin)
    expect(err.error.code).toBe('missing_uploads')
    expect(err.error.missing).toEqual(['app.js'])
    expect(kvsSite()).toBeUndefined()
  })

  it('rejects bad names, bad manifests, oversize deploys and tampered uploads', async () => {
    const bad = await api(env, key, 'POST', '/api/sites/Bad--Name/deploys', {
      manifest: manifest(v1),
    })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error.code).toBe('invalid_name')
    for (const name of ['www', 'my--app', 'a'.repeat(51)]) {
      const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
        manifest: manifest(v1),
      })
      expect(res.status).toBe(400)
      expect((await json(res)).error.code).toBe('invalid_name')
    }

    const invalid = await api(env, key, 'POST', '/api/sites/hello/deploys', {
      manifest: { files: [{ ...v1[0]?.meta, path: '../x' }] },
    })
    expect(invalid.status).toBe(400)

    const huge = await api(env, key, 'POST', '/api/sites/hello/deploys', {
      manifest: { files: [{ ...v1[0]?.meta, size: 26 * 1024 * 1024 }] },
    })
    expect(huge.status).toBe(413)

    const body = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    const u = body.uploads[0]
    const tampered = await env.app.request(u.url, {
      method: 'PUT',
      headers: { ...u.headers, 'content-type': 'text/plain' },
      body: 'x',
    })
    expect(tampered.status).toBe(403)
  })

  it('finalize/deploy for unknown site or version → 404', async () => {
    expect((await api(env, key, 'POST', '/api/sites/nope/deploys/abc/finalize')).status).toBe(404)
    await deployLive(v1)
    expect((await api(env, key, 'POST', '/api/sites/hello/deploys/abc/finalize')).status).toBe(404)
  })
})

describe('site operations', () => {
  it('PATCH visibility/spa updates KVS', async () => {
    await deployLive(v1)
    const res = await api(env, key, 'PATCH', '/api/sites/hello', {
      visibility: 'public',
      spa: true,
    })
    expect(res.status).toBe(200)
    expect((await json(res)).visibility).toBe('public')
    expect(kvsSite()).toMatchObject({ vis: 'public', spa: true })
    expect((await api(env, key, 'PATCH', '/api/sites/hello', { visibility: 'x' })).status).toBe(400)
  })

  it('rollback via POST /current', async () => {
    const first = await deployLive(v1)
    await deployLive(v2)
    const res = await api(env, key, 'POST', '/api/sites/hello/current', {
      versionId: first.versionId,
    })
    expect(res.status).toBe(200)
    expect(kvsSite().v).toBe(first.versionId)
    const missing = await api(env, key, 'POST', '/api/sites/hello/current', { versionId: 'nope' })
    expect(missing.status).toBe(404)
  })

  it('share create/rotate/revoke maintains share: keys', async () => {
    await deployLive(v1)
    const s1 = await json(await api(env, key, 'POST', '/api/sites/hello/share'))
    const t1 = /^https:\/\/s--([a-z0-9]{20})\.fling\.test\/$/.exec(s1.shareUrl)?.[1]
    expect(t1).toBeDefined()
    expect(JSON.parse(env.kvs.data.get(shareKvsKey(t1 as string)) as string).v).toBe(kvsSite().v)

    const s2 = await json(await api(env, key, 'POST', '/api/sites/hello/share'))
    const t2 = /s--([a-z0-9]{20})\./.exec(s2.shareUrl)?.[1] as string
    expect(t2).not.toBe(t1)
    expect(env.kvs.data.has(shareKvsKey(t1 as string))).toBe(false)
    expect(env.kvs.data.has(shareKvsKey(t2))).toBe(true)
    const site = await json(await api(env, key, 'GET', '/api/sites/hello'))
    expect(site.shareUrl).toBe(s2.shareUrl)

    const revoked = await api(env, key, 'DELETE', '/api/sites/hello/share')
    expect(revoked.status).toBe(204)
    expect((await json(await api(env, key, 'GET', '/api/sites/hello'))).shareUrl).toBeNull()
    expect(env.kvs.data.has(shareKvsKey(t2))).toBe(false)
  })

  it('archive removes KVS keys and hides from list; unarchive and deploy restore', async () => {
    await deployLive(v1)
    const share = await json(await api(env, key, 'POST', '/api/sites/hello/share'))
    const token = /s--([a-z0-9]{20})\./.exec(share.shareUrl)?.[1] as string

    const archived = await api(env, key, 'POST', '/api/sites/hello/archive')
    expect((await json(archived)).archived).toBe(true)
    expect(kvsSite()).toBeUndefined()
    expect(env.kvs.data.has(shareKvsKey(token))).toBe(false)
    expect((await json(await api(env, key, 'GET', '/api/sites'))).sites).toEqual([])
    const list = await json(await api(env, key, 'GET', '/api/sites?archived=1'))
    expect(list.sites.map((s: any) => s.name)).toEqual(['hello'])

    await api(env, key, 'POST', '/api/sites/hello/unarchive')
    expect(kvsSite()).toBeDefined()
    expect(env.kvs.data.has(shareKvsKey(token))).toBe(true)

    await api(env, key, 'POST', '/api/sites/hello/archive')
    const redeploy = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    expect(redeploy.status).toBe('unchanged')
    expect(redeploy.site.archived).toBe(false)
    expect(kvsSite()).toBeDefined()
  })

  it('DELETE removes KVS keys, files, versions and the site', async () => {
    const live = await deployLive(v1)
    await api(env, key, 'POST', '/api/sites/hello/share')
    const siteId = kvsSite().id
    expect(await env.storage.head(`sites/${siteId}/${live.versionId}/index.html`)).not.toBeNull()
    const res = await api(env, key, 'DELETE', '/api/sites/hello')
    expect(res.status).toBe(204)
    expect(env.kvs.data.size).toBe(0)
    expect(await env.storage.head(`sites/${siteId}/${live.versionId}/index.html`)).toBeNull()
    expect((await api(env, key, 'GET', '/api/sites/hello')).status).toBe(404)
    // a fresh deploy starts over
    const again = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', { manifest: manifest(v1) })
    )
    expect(again.status).toBe('upload')
  })

  it("can't see another user's sites", async () => {
    await deployLive(v1)
    const bob = await createUser(env, 'bob@nearform.com')
    expect((await api(env, bob.key, 'GET', '/api/sites/hello')).status).toBe(404)
    expect((await json(await api(env, bob.key, 'GET', '/api/sites'))).sites).toEqual([])
  })
})

describe('global site names', () => {
  // alice@nearform.com deploys 'hello' first; clifton.cunningham@… then wants it.
  let cc: Awaited<ReturnType<typeof createUser>>
  beforeEach(async () => {
    cc = await createUser(env, 'clifton.cunningham@nearform.com')
  })

  const deployAs = (k: string, name: string, files = v1) =>
    api(env, k, 'POST', `/api/sites/${name}/deploys`, { manifest: manifest(files) })
  const check = async (k: string, name: string) =>
    json(await api(env, k, 'GET', `/api/names/${encodeURIComponent(name)}`))

  it("deploying to another user's name → 409 name_taken with initials suggestions", async () => {
    await deployLive(v1)
    const res = await deployAs(cc.key, 'hello', v2)
    expect(res.status).toBe(409)
    const body = await json(res)
    expect(body.error).toMatchObject({
      code: 'name_taken',
      suggestions: ['hello-cc', 'hello-cc2', 'hello-cc3'],
    })
    expect(body.error.message).toContain('hello-cc')
    // alice's site is untouched
    expect(kvsSite()).toBeDefined()
    expect((await json(await api(env, key, 'GET', '/api/sites/hello'))).versions).toHaveLength(1)
  })

  it('suggestions skip names that are already claimed', async () => {
    await deployLive(v1)
    await deployLive(v1, 'hello-cc')
    await deployLive(v1, 'hello-cc3')
    const body = await json(await deployAs(cc.key, 'hello'))
    expect(body.error.suggestions).toEqual(['hello-cc2', 'hello-cc4', 'hello-cc5'])
    // a suggested name is deployable
    expect((await json(await deployAs(cc.key, 'hello-cc2'))).status).toBe('upload')
  })

  it('a pending first deploy already claims the name', async () => {
    expect((await json(await deployAs(key, 'hello'))).status).toBe('upload')
    expect((await deployAs(cc.key, 'hello')).status).toBe(409)
  })

  it('GET /api/names/:name → available / yours / taken / invalid', async () => {
    await deployLive(v1)
    expect(await check(key, 'fresh')).toEqual({
      name: 'fresh',
      status: 'available',
      suggestions: [],
    })
    expect(await check(key, 'hello')).toEqual({ name: 'hello', status: 'yours', suggestions: [] })
    expect(await check(cc.key, 'hello')).toEqual({
      name: 'hello',
      status: 'taken',
      suggestions: ['hello-cc', 'hello-cc2', 'hello-cc3'],
    })
    expect(await check(cc.key, 'www')).toMatchObject({
      status: 'invalid',
      suggestions: ['www-cc', 'www-cc2', 'www-cc3'],
    })
    expect(await check(cc.key, 'My Site!')).toMatchObject({
      name: 'My Site!',
      status: 'invalid',
      suggestions: ['my-site-cc', 'my-site-cc2', 'my-site-cc3'],
    })
    expect((await env.app.request('/api/names/hello')).status).toBe(401)
  })

  it('deleting a site frees its name; archiving keeps it', async () => {
    await deployLive(v1)
    await api(env, key, 'POST', '/api/sites/hello/archive')
    expect((await check(cc.key, 'hello')).status).toBe('taken')
    expect((await deployAs(cc.key, 'hello')).status).toBe(409)

    expect((await api(env, key, 'DELETE', '/api/sites/hello')).status).toBe(204)
    expect((await check(cc.key, 'hello')).status).toBe('available')
    expect((await deployAs(cc.key, 'hello')).status).toBe(200)
    expect((await check(cc.key, 'hello')).status).toBe('yours')
    expect((await check(key, 'hello')).status).toBe('taken')
    expect((await deployAs(key, 'hello')).status).toBe(409)
  })
})
