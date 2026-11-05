/**
 * Path publish through the API, publication's own interface and the remote MCP tools: what a
 * `path` may be (one top-level folder), `outside_path`, the scan, a publish on a base of a Path
 * (only what changed sent, the rest of the Path carried forward), the guard on the Path's current
 * version (`base_changed`), and that a Path publish never changes the site's own version.
 * Paths themselves (who may publish, the home page, serving) are paths.test.ts.
 */
import { MAX_KEPT_FILES, siteObjectKey } from '@fling/shared'
import { describe, expect, it, vi } from 'vitest'
import { manifestKey } from '../src/blobs/types.ts'
import type { Principal } from '../src/policy.ts'
import { publishBytes } from '../src/publication.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

// Assembled at runtime so the repo never contains a real-looking key.
const FAKE_AWS_KEY = `AKIA${'Q'.repeat(16)}`

type F = ReturnType<typeof file>

const v1 = [file('index.html', '<h1>v1</h1>'), file('about.html', '<h1>about</h1>')]

/** Stage `files` (with `extra`, e.g. `path`) as `key`; the deploy response. */
async function stageAs(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  return { status: res.status, body: await json(res) }
}

/** Stage, upload and finalize; the finalize response (or the deploy's, if it stopped there). */
async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const staged = await stageAs(env, key, name, files, extra)
  if (staged.status !== 200 || staged.body.status !== 'upload') return staged
  await upload(env, staged.body.uploads, files)
  return finalize(env, key, name, staged.body.versionId)
}

async function finalize(env: Env, key: string, name: string, versionId: string) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys/${versionId}/finalize`)
  return { status: res.status, body: await json(res) }
}

async function world() {
  const env = setup()
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  expect((await deploy(env, alice.key, 'team', v1)).status).toBe(200)
  const site = await env.store.findSite('team')
  return { env, alice, bob, base: site?.currentVersionId as string }
}

/** The files of the Path's current version, by path within it, read from the bucket. */
async function pathFiles(env: Env, folder: string, name = 'team') {
  const site = await env.store.findSite(name)
  const path = site ? await env.store.getPath(site.id, folder) : null
  if (!path?.currentVersionId) return {}
  const manifest = await env.blobs.getJson<{ files: { path: string }[] }>(
    manifestKey(path.id, path.currentVersionId)
  )
  const out: Record<string, string> = {}
  for (const f of manifest?.files ?? []) {
    const bytes = await env.blobs.get(siteObjectKey(path.id, path.currentVersionId, f.path))
    out[f.path] = bytes ? Buffer.from(bytes).toString('utf8') : '(missing)'
  }
  return out
}

const week = [
  file('wk44/index.html', '<h1>new week</h1>'),
  file('wk44/chart.svg', '<svg/>', 'image/svg+xml'),
]

describe('path publish', () => {
  it('publishes the folder as its Path; the site’s version stays as it was', async () => {
    const { env, alice, base } = await world()
    const staged = await stageAs(env, alice.key, 'team', week, { path: '/wk44/' })
    expect(staged.status).toBe(200)
    expect(staged.body.uploads.map((u: { path: string }) => u.path).sort()).toEqual([
      'wk44/chart.svg',
      'wk44/index.html',
    ])
    await upload(env, staged.body.uploads, week)
    const copy = vi.spyOn(env.blobs, 'copy')
    const done = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(done.body.status).toBe('live')
    expect(copy).not.toHaveBeenCalled()
    expect(await pathFiles(env, 'wk44')).toEqual({
      'index.html': '<h1>new week</h1>',
      'chart.svg': '<svg/>',
    })
    expect((await env.store.findSite('team'))?.currentVersionId).toBe(base)
  })

  it('takes one top-level folder: nested folders, files outside it and dotfiles are refused', async () => {
    const { env, alice } = await world()
    const outside = await stageAs(env, alice.key, 'team', [...week, file('index.html', 'x')], {
      path: 'wk44',
    })
    expect(outside.status).toBe(400)
    expect(outside.body.error.code).toBe('outside_path')
    expect(outside.body.error.paths).toEqual(['index.html'])
    // A file named like the folder is not inside it.
    const named = await stageAs(env, alice.key, 'team', [file('wk44', 'x')], { path: 'wk44' })
    expect(named.body.error.code).toBe('outside_path')
    const nested = await stageAs(env, alice.key, 'team', [file('a/b/index.html', 'x')], {
      path: 'a/b',
    })
    expect(nested.status).toBe(400)
    expect(nested.body.error.message).toContain('one top-level folder')
    for (const path of ['', '/', '.well-known', 'a/../b', 'a//b', 'x'.repeat(101)]) {
      expect((await stageAs(env, alice.key, 'team', week, { path })).status).toBe(400)
    }
  })

  it('scans what is sent: a secret refuses the publish', async () => {
    const { env, alice } = await world()
    const secret = [file('wk44/leak.js', `k="${FAKE_AWS_KEY}"`, 'text/javascript')]
    const refused = await deploy(env, alice.key, 'team', secret, { path: 'wk44' })
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('secret_detected')
  })

  it('forms are the site’s: a Path publish carrying a config is refused, null is fine', async () => {
    const { env, alice } = await world()
    const page = [file('wk44/index.html', '<h1>wk44</h1>')]
    const forms = {
      title: 'Notes',
      forms: [
        {
          id: 'note',
          title: 'Note',
          kind: 'page',
          paths: ['**'],
          schema: { type: 'object', properties: { note: { type: 'string' } } },
        },
      ],
    }
    const refused = await deploy(env, alice.key, 'team', page, { path: 'wk44', forms })
    expect(refused.status).toBe(400)
    expect(refused.body.error.message).toMatch(/Forms belong to the site/)
    const done = await deploy(env, alice.key, 'team', page, { path: 'wk44', forms: null })
    expect(done.status).toBe(200)
  })

  it('on a base: sends only what changed, carries the rest of the Path, and removes', async () => {
    const { env, alice } = await world()
    const first = await deploy(env, alice.key, 'team', week, { path: 'wk44' })
    const base = first.body.versionId
    const changed = [file('wk44/notes.html', '<p>notes</p>')]
    const staged = await stageAs(env, alice.key, 'team', changed, {
      path: 'wk44',
      base,
      partial: true,
      remove: ['wk44/chart.svg'],
    })
    expect(staged.status).toBe(200)
    expect(staged.body.uploads.map((u: { path: string }) => u.path)).toEqual(['wk44/notes.html'])
    await upload(env, staged.body.uploads, changed)
    expect((await finalize(env, alice.key, 'team', staged.body.versionId)).status).toBe(200)
    expect(await pathFiles(env, 'wk44')).toEqual({
      'index.html': '<h1>new week</h1>',
      'notes.html': '<p>notes</p>',
    })
  })

  it('on a base that is no longer the Path’s current version: base_changed', async () => {
    const { env, alice, bob } = await world()
    await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB] } })
    const first = await deploy(env, alice.key, 'team', week, { path: 'wk44' })
    const base = first.body.versionId
    const mine = [file('wk44/a.html', 'a')]
    const staged = await stageAs(env, alice.key, 'team', mine, {
      path: 'wk44',
      base,
      partial: true,
    })
    await upload(env, staged.body.uploads, mine)
    // Alice owns the Path; she publishes again before finalizing the first.
    await deploy(env, alice.key, 'team', [file('wk44/index.html', 'v2')], { path: 'wk44' })
    const lost = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('base_changed')
    const again = await stageAs(env, alice.key, 'team', mine, { path: 'wk44', base, partial: true })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('base_changed')
    // A base on a Path that doesn't exist yet is base_changed too.
    const none = await stageAs(env, bob.key, 'team', [file('new/a.html', 'a')], {
      path: 'new',
      base,
      partial: true,
    })
    expect(none.body.error.code).toBe('base_changed')
  })

  it('carries at most MAX_KEPT_FILES of a Path forward', async () => {
    const { env, alice } = await world()
    const many = Array.from({ length: MAX_KEPT_FILES + 1 }, (_, i) => file(`p/${i}.txt`, `${i}`))
    const first = await deploy(env, alice.key, 'team', many, { path: 'p' })
    expect(first.status).toBe(200)
    const refused = await stageAs(env, alice.key, 'team', [file('p/new.txt', 'x')], {
      path: 'p',
      base: first.body.versionId,
      partial: true,
    })
    expect(refused.status).toBe(413)
    expect(refused.body.error.message).toContain(`at most ${MAX_KEPT_FILES} files`)
  }, 60_000)

  it('going live is guarded: a Path that moves after the check is base_changed, the version pending', async () => {
    const { env, alice } = await world()
    await deploy(env, alice.key, 'team', week, { path: 'wk44' })
    const next = [file('wk44/index.html', 'next')]
    const staged = await stageAs(env, alice.key, 'team', next, { path: 'wk44' })
    await upload(env, staged.body.uploads, next)
    const putPath = env.store.putPath.bind(env.store)
    let raced = false
    vi.spyOn(env.store, 'putPath').mockImplementation(async (path, opts) => {
      if (opts?.ifCurrentVersion && !raced) {
        raced = true
        const site = await env.store.findSite('team')
        const stored = await env.store.getPath(site?.id as string, 'wk44')
        if (stored) await putPath({ ...stored, currentVersionId: 'someone-else' })
      }
      return putPath(path, opts)
    })
    const lost = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('base_changed')
    const site = await env.store.findSite('team')
    const path = await env.store.getPath(site?.id as string, 'wk44')
    expect(path?.currentVersionId).toBe('someone-else')
    const version = await env.store.getVersion(
      { id: path?.id as string, email: ALICE },
      staged.body.versionId
    )
    expect(version?.status).toBe('pending')
  })

  it('publishBytes publishes to the Path the same way', async () => {
    const { env } = await world()
    const user = (await env.store.getUser(ALICE)) as never
    const principal: Principal = { email: ALICE, admin: false, via: 'api_key', guest: false }
    const bytes = (s: string) => new Uint8Array(Buffer.from(s))
    const res = await publishBytes(
      env.deps,
      user,
      'team',
      [{ path: 'wk44/index.html', bytes: bytes('<h1>inline</h1>') }],
      { principal, path: 'wk44' }
    )
    expect(res.status).toBe('live')
    expect(await pathFiles(env, 'wk44')).toEqual({ 'index.html': '<h1>inline</h1>' })
    await expect(
      publishBytes(env.deps, user, 'team', [{ path: 'x.html', bytes: bytes('x') }], {
        principal,
        path: 'wk44',
      })
    ).rejects.toMatchObject({ status: 400, code: 'outside_path' })
  })
})

describe('fling_publish and fling_upload_* with path', () => {
  it('publish the folder’s Path, relative to it', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const res = await callTool(env, accessToken, 'fling_publish', {
      name: 'team',
      path: '/wk44/',
      files: [{ path: 'index.html', content: '<h1>from mcp</h1>' }],
    })
    expect(res.isError).toBeFalsy()
    expect(res.content[0]?.text).toContain('/wk44/')
    expect(res.structuredContent.path).toBe('wk44')
    expect(await pathFiles(env, 'wk44')).toEqual({ 'index.html': '<h1>from mcp</h1>' })

    const begun = await callTool(env, accessToken, 'fling_upload_begin', {
      name: 'team',
      path: 'reports',
    })
    const { uploadId } = begun.structuredContent
    await callTool(env, accessToken, 'fling_upload_file', {
      uploadId,
      path: 'q1.html',
      content: '<h1>q1</h1>',
    })
    const finished = await callTool(env, accessToken, 'fling_upload_finish', {
      uploadId,
      listHtml: true,
    })
    expect(finished.isError).toBeFalsy()
    const files = await pathFiles(env, 'reports')
    expect(files['q1.html']).toBe('<h1>q1</h1>')
    expect(files['index.html']).toContain('q1.html')

    for (const path of ['.git', 'reports/2026']) {
      const bad = await callTool(env, accessToken, 'fling_publish', {
        name: 'team',
        path,
        files: [{ path: 'index.html', content: 'x' }],
      })
      expect(bad.isError).toBe(true)
      expect(bad.content[0]?.text).toContain('invalid_path')
    }
  })
})
