/**
 * Publishing on a base (`DeployRequest.base`, after a pull): the complete form and the partial one
 * (`partial`, `remove`), files the base has copied rather than uploaded, the base guard
 * (`base_changed`) when the deploy is made and at finalize, who may, the MAX_KEPT_FILES cap, and
 * publication's own interface (`publishBytes`, the remote MCP's).
 */
import { MAX_KEPT_FILES, siteObjectKey } from '@fling/shared'
import { describe, expect, it, vi } from 'vitest'
import { manifestKey } from '../src/blobs/types.ts'
import type { Principal } from '../src/policy.ts'
import { publishBytes } from '../src/publication.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

type F = ReturnType<typeof file>

const v1 = [
  file('index.html', '<h1>v1</h1>'),
  file('about.html', '<h1>about</h1>'),
  file('old.html', '<h1>old</h1>'),
  file('css/site.css', 'body{}', 'text/css'),
]

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

/** Alice's site `team` with Bob as a publisher; `base` is its current version. */
async function world() {
  const env = setup()
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  expect((await deploy(env, alice.key, 'team', v1)).status).toBe(200)
  await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB] } })
  const site = await env.store.findSite('team')
  return { env, alice, bob, base: site?.currentVersionId as string }
}

/** The files of the site's current version, by path, read from the bucket. */
async function served(env: Env, name = 'team') {
  const site = await env.store.findSite(name)
  if (!site?.currentVersionId) return {}
  const manifest = await env.blobs.getJson<{ files: { path: string }[] }>(
    manifestKey(site.id, site.currentVersionId)
  )
  const out: Record<string, string> = {}
  for (const f of manifest?.files ?? []) {
    const bytes = await env.blobs.get(siteObjectKey(site.id, site.currentVersionId, f.path))
    out[f.path] = bytes ? Buffer.from(bytes).toString('utf8') : '(missing)'
  }
  return out
}

const uploadsOf = (body: { uploads: { path: string }[] }) => body.uploads.map(u => u.path).sort()
const copiedTo = (copy: { mock: { calls: [string, string][] } }) =>
  copy.mock.calls.map(([, to]) => to.split('/').slice(3).join('/')).sort()

const edited = file('index.html', '<h1>v2</h1>')
const added = file('new.html', '<h1>new</h1>')

describe('publish on a base', () => {
  it('complete: the manifest is the whole version; files the base has are copied, not uploaded', async () => {
    const { env, alice, base } = await world()
    const next = [
      edited,
      added,
      ...v1.filter(f => !['index.html', 'old.html'].includes(f.meta.path)),
    ]
    const staged = await stageAs(env, alice.key, 'team', next, { base })
    expect(staged.status).toBe(200)
    expect(uploadsOf(staged.body)).toEqual(['index.html', 'new.html'])
    await upload(env, staged.body.uploads, next)
    const copy = vi.spyOn(env.blobs, 'copy')
    const done = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(done.status).toBe(200)
    expect(copiedTo(copy)).toEqual(['about.html', 'css/site.css'])
    expect(await served(env)).toEqual({
      'index.html': '<h1>v2</h1>',
      'new.html': '<h1>new</h1>',
      'about.html': '<h1>about</h1>',
      'css/site.css': 'body{}',
    })
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.versions[0]).toMatchObject({ id: done.body.versionId, base, fileCount: 4 })
    expect(detail.versions[0].path).toBeUndefined()
  })

  it('partial: only what changed is sent, `remove` leaves files out, the rest is kept', async () => {
    const { env, bob, base } = await world()
    const done = await deploy(env, bob.key, 'team', [edited, added], {
      base,
      partial: true,
      remove: ['old.html'],
    })
    expect(done.status).toBe(200)
    expect(await served(env)).toEqual({
      'index.html': '<h1>v2</h1>',
      'new.html': '<h1>new</h1>',
      'about.html': '<h1>about</h1>',
      'css/site.css': 'body{}',
    })
    // Removing alone sends no files.
    const site = await env.store.findSite('team')
    const removing = await stageAs(env, bob.key, 'team', [], {
      base: site?.currentVersionId,
      partial: true,
      remove: ['new.html'],
    })
    expect(removing.status).toBe(200)
    expect(removing.body.uploads).toEqual([])
    expect((await finalize(env, bob.key, 'team', removing.body.versionId)).status).toBe(200)
    expect(Object.keys(await served(env)).sort()).toEqual([
      'about.html',
      'css/site.css',
      'index.html',
    ])
  })

  it('unchanged content on its base is `unchanged`; the same version again is `repointed`', async () => {
    const { env, alice, base } = await world()
    expect((await stageAs(env, alice.key, 'team', v1, { base })).body.status).toBe('unchanged')
    expect((await deploy(env, alice.key, 'team', [edited], { base, partial: true })).status).toBe(
      200
    )
    const back = await api(env, alice.key, 'POST', '/api/sites/team/current', { versionId: base })
    expect(back.status).toBe(200)
    const again = await stageAs(env, alice.key, 'team', [edited], { base, partial: true })
    expect(again.body.status).toBe('repointed')
  })

  it('a base that is not current is base_changed, with nothing staged', async () => {
    const { env, alice, bob, base } = await world()
    expect((await deploy(env, bob.key, 'team', [added], { base, partial: true })).status).toBe(200)
    const stale = await stageAs(env, alice.key, 'team', [edited], { base, partial: true })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('base_changed')
    expect(stale.body.error.base).toBe(base)
    expect(stale.body.error.message).toMatch(/pull it again/)
    for (const other of ['no-such-version', '']) {
      const res = await stageAs(env, alice.key, 'team', v1, { base: other })
      expect(res.status).toBe(other ? 409 : 400)
    }
    // On a name with no site yet, there is no base to build on.
    const fresh = await stageAs(env, alice.key, 'fresh', v1, { base })
    expect(fresh.body.error.code).toBe('base_changed')
    expect(await env.store.findSite('fresh')).toBeNull()
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.versions).toHaveLength(2)
  })

  it('finalize refuses with base_changed once another publish went live first', async () => {
    const { env, alice, bob, base } = await world()
    const mine = await stageAs(env, alice.key, 'team', [edited], { base, partial: true })
    await upload(env, mine.body.uploads, [edited])
    expect((await deploy(env, bob.key, 'team', [added], { base, partial: true })).status).toBe(200)
    const lost = await finalize(env, alice.key, 'team', mine.body.versionId)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('base_changed')
    expect(await served(env)).toMatchObject({
      'index.html': '<h1>v1</h1>',
      'new.html': '<h1>new</h1>',
    })
  })

  it('only those who may deploy publish on a base: a viewer gets name_taken', async () => {
    const { env, alice, base } = await world()
    const carol = await createUser(env, 'carol@example.test')
    await api(env, alice.key, 'PATCH', '/api/sites/team', {
      access: 'people',
      audience: { emails: ['carol@example.test'] },
    })
    expect((await api(env, carol.key, 'GET', '/api/sites/team/pull')).status).toBe(200)
    const refused = await stageAs(env, carol.key, 'team', [edited], { base, partial: true })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('name_taken')
  })

  it('refuses requests that do not fit together', async () => {
    const { env, alice, base } = await world()
    const cases: [F[], object][] = [
      [[edited], { partial: true }],
      [[edited], { base, remove: ['old.html'] }],
      [[edited], { base, path: 'x' }],
      [[], { base }],
      [[], { base, partial: true }],
      [[edited], { base, partial: true, remove: ['index.html'] }],
    ]
    for (const [files, extra] of cases) {
      const res = await stageAs(env, alice.key, 'team', files, extra)
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 })
    }
  })

  it('keeps at most MAX_KEPT_FILES: the complete form uploads the rest, the partial one is a 413', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    const many = Array.from({ length: MAX_KEPT_FILES + 2 }, (_, i) => file(`p/${i}.txt`, `${i}`))
    expect((await deploy(env, alice.key, 'big', many)).status).toBe(200)
    const base = (await env.store.findSite('big'))?.currentVersionId
    const complete = await stageAs(env, alice.key, 'big', [...many, added], { base })
    expect(complete.status).toBe(200)
    expect(complete.body.uploads).toHaveLength(3)
    const partial = await stageAs(env, alice.key, 'big', [added], { base, partial: true })
    expect(partial.status).toBe(413)
    expect(partial.body.error.code).toBe('too_large')
    expect(partial.body.error.message).toContain(`at most ${MAX_KEPT_FILES} files`)
  }, 60_000)

  it('publishBytes on a base: the bytes sent, the removals, and the base kept', async () => {
    const { env, base } = await world()
    const user = (await env.store.getUser(ALICE)) as NonNullable<
      Awaited<ReturnType<typeof env.store.getUser>>
    >
    const principal: Principal = { email: ALICE, admin: false, via: 'oauth', guest: false }
    const bytes = (s: string) => new TextEncoder().encode(s)
    const put = vi.spyOn(env.blobs, 'put')
    const done = await publishBytes(
      env.deps,
      user,
      'team',
      [
        { path: 'index.html', bytes: bytes('<h1>v2</h1>') },
        { path: 'about.html', bytes: bytes('<h1>about</h1>') },
      ],
      { principal, base, remove: ['old.html'] }
    )
    expect(done.status).toBe('live')
    // about.html is the base's, byte for byte: copied, not written.
    expect(put.mock.calls.map(([key]) => key.split('/').slice(3).join('/'))).toEqual(['index.html'])
    expect(await served(env)).toEqual({
      'index.html': '<h1>v2</h1>',
      'about.html': '<h1>about</h1>',
      'css/site.css': 'body{}',
    })
    await expect(
      publishBytes(env.deps, user, 'team', [{ path: 'x.html', bytes: bytes('x') }], {
        principal,
        base,
      })
    ).rejects.toMatchObject({ status: 409, code: 'base_changed' })
  })
})
