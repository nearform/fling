/**
 * Path publish through the API, publication's own interface and the remote MCP tools: the merged
 * version, `outside_path`, the base guard (`base_changed`) at finalize and when going live, the
 * kept files copied and never rescanned, the caps on the merged set, what versions record, and
 * rollback.
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

const v1 = [
  file('index.html', '<h1>v1</h1>'),
  file('about.html', '<h1>about</h1>'),
  file('30-10-26/index.html', '<h1>old week</h1>'),
  file('30-10-26/stale.html', '<h1>stale</h1>'),
]

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

const week = [
  file('30-10-26/index.html', '<h1>new week</h1>'),
  file('30-10-26/chart.svg', '<svg/>', 'image/svg+xml'),
]

describe('path publish', () => {
  it('replaces only the folder, uploads only its files, and keeps the rest', async () => {
    const { env, alice, base } = await world()
    const staged = await stageAs(env, alice.key, 'team', week, { path: '/30-10-26/' })
    expect(staged.status).toBe(200)
    expect(staged.body.uploads.map((u: { path: string }) => u.path).sort()).toEqual([
      '30-10-26/chart.svg',
      '30-10-26/index.html',
    ])
    await upload(env, staged.body.uploads, week)
    const copy = vi.spyOn(env.blobs, 'copy')
    const done = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('live')
    expect(copy.mock.calls.map(([, to]) => to.split('/').slice(3).join('/')).sort()).toEqual([
      'about.html',
      'index.html',
    ])
    expect(await served(env)).toEqual({
      'index.html': '<h1>v1</h1>',
      'about.html': '<h1>about</h1>',
      '30-10-26/index.html': '<h1>new week</h1>',
      '30-10-26/chart.svg': '<svg/>',
    })

    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.versions[0]).toMatchObject({
      id: staged.body.versionId,
      path: '30-10-26',
      base,
      publishedBy: ALICE,
      fileCount: 4,
    })
    expect(detail.versions[1].path).toBeUndefined()

    // The same folder again is unchanged; rolling back to the base removes the new files.
    expect((await stageAs(env, alice.key, 'team', week, { path: '30-10-26' })).body.status).toBe(
      'unchanged'
    )
    const back = await api(env, alice.key, 'POST', '/api/sites/team/current', { versionId: base })
    expect(back.status).toBe(200)
    expect(await served(env)).toMatchObject({ '30-10-26/stale.html': '<h1>stale</h1>' })
    expect(Object.keys(await served(env))).not.toContain('30-10-26/chart.svg')
  })

  it('refuses files outside the path, and a path that is not a folder', async () => {
    const { env, alice } = await world()
    const outside = await stageAs(env, alice.key, 'team', [...week, file('index.html', 'x')], {
      path: '30-10-26',
    })
    expect(outside.status).toBe(400)
    expect(outside.body.error.code).toBe('outside_path')
    expect(outside.body.error.paths).toEqual(['index.html'])
    // A file named like the folder is not inside it.
    const named = await stageAs(env, alice.key, 'team', [file('30-10-26', 'x')], {
      path: '30-10-26',
    })
    expect(named.body.error.code).toBe('outside_path')
    for (const path of ['', '/', '.well-known', 'a/../b', 'a//b']) {
      expect((await stageAs(env, alice.key, 'team', week, { path })).status).toBe(400)
    }
  })

  it('finalize refuses with base_changed once another publish made it live first', async () => {
    const { env, alice, bob } = await world()
    await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB] } })
    const mine = await stageAs(env, alice.key, 'team', week, { path: '30-10-26' })
    const other = [file('06-11-26/index.html', '<h1>next</h1>')]
    const theirs = await stageAs(env, bob.key, 'team', other, { path: '06-11-26' })
    await upload(env, mine.body.uploads, week)
    await upload(env, theirs.body.uploads, other)
    const won = await finalize(env, bob.key, 'team', theirs.body.versionId)
    expect(won.status).toBe(200)
    const lost = await finalize(env, alice.key, 'team', mine.body.versionId)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('base_changed')

    // Publishing again builds on Bob's version: both folders are there.
    expect((await deploy(env, alice.key, 'team', week, { path: '30-10-26' })).status).toBe(200)
    const files = await served(env)
    expect(files['06-11-26/index.html']).toBe('<h1>next</h1>')
    expect(files['30-10-26/index.html']).toBe('<h1>new week</h1>')
    const detail = await json(await api(env, bob.key, 'GET', '/api/sites/team'))
    expect(detail.versions.map((v: { publishedBy: string }) => v.publishedBy)).toEqual([
      ALICE,
      BOB,
      ALICE,
    ])
  })

  it('going live is guarded too: a base that moves after the check is base_changed', async () => {
    const { env, alice, base } = await world()
    const staged = await stageAs(env, alice.key, 'team', week, { path: '30-10-26' })
    await upload(env, staged.body.uploads, week)
    // Someone else's publish lands between finalize's check and its save.
    const putSite = env.store.putSite.bind(env.store)
    let raced = false
    vi.spyOn(env.store, 'putSite').mockImplementation(async (site, opts) => {
      if (opts?.ifCurrentVersion && !raced) {
        raced = true
        const stored = await env.store.findSite('team')
        if (stored) await putSite({ ...stored, currentVersionId: 'someone-else' })
      }
      return putSite(site, opts)
    })
    const lost = await finalize(env, alice.key, 'team', staged.body.versionId)
    expect(lost.status).toBe(409)
    expect(lost.body.error.code).toBe('base_changed')
    const site = await env.store.findSite('team')
    expect(site?.currentVersionId).toBe('someone-else')
    // The version is not left looking published.
    const version = await env.store.getVersion(site as never, staged.body.versionId)
    expect(version?.status).toBe('pending')
    expect(base).not.toBe('someone-else')
  })

  it('scans only the files sent: kept files are not read back', async () => {
    const { env, alice } = await world()
    const get = vi.spyOn(env.blobs, 'get')
    expect((await deploy(env, alice.key, 'team', week, { path: '30-10-26' })).status).toBe(200)
    const read = get.mock.calls.map(([key]) => key.split('/').slice(3).join('/'))
    expect(read).toContain('30-10-26/index.html')
    expect(read).not.toContain('about.html')

    const secret = [file('30-10-26/leak.js', `k="${FAKE_AWS_KEY}"`, 'text/javascript')]
    const refused = await deploy(env, alice.key, 'team', secret, { path: '30-10-26' })
    expect(refused.status).toBe(422)
    expect(refused.body.error.code).toBe('secret_detected')
  })

  it('checks the caps on the merged set, and carries at most MAX_KEPT_FILES forward', async () => {
    const { env, alice } = await world()
    const many = Array.from({ length: MAX_KEPT_FILES + 1 }, (_, i) => file(`p/${i}.txt`, `${i}`))
    const big = await stageAs(env, alice.key, 'big', many)
    await upload(env, big.body.uploads, many)
    expect((await finalize(env, alice.key, 'big', big.body.versionId)).status).toBe(200)
    const refused = await stageAs(env, alice.key, 'big', [file('w/index.html', 'x')], {
      path: 'w',
    })
    expect(refused.status).toBe(413)
    expect(refused.body.error.code).toBe('too_large')
    expect(refused.body.error.message).toContain(`at most ${MAX_KEPT_FILES} files`)
    // Replacing the folder that holds them keeps nothing, so it is fine.
    expect(
      (await stageAs(env, alice.key, 'big', [file('p/a.txt', 'x')], { path: 'p' })).status
    ).toBe(200)
  }, 60_000)

  it('on a site with no current version, publishes just those files, with no base', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    expect((await deploy(env, alice.key, 'fresh', week, { path: '30-10-26' })).status).toBe(200)
    expect(Object.keys(await served(env, 'fresh')).sort()).toEqual([
      '30-10-26/chart.svg',
      '30-10-26/index.html',
    ])
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/fresh'))
    expect(detail.versions[0].path).toBe('30-10-26')
    expect(detail.versions[0].base).toBeUndefined()
  })

  it('a publisher can path-publish', async () => {
    const { env, alice, bob } = await world()
    await api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [BOB] } })
    const done = await deploy(env, bob.key, 'team', week, { path: '30-10-26' })
    expect(done.status).toBe(200)
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/team'))
    expect(detail.versions[0]).toMatchObject({ path: '30-10-26', publishedBy: BOB })
  })

  it('publishBytes merges the same way', async () => {
    const { env } = await world()
    const user = (await env.store.getUser(ALICE)) as never
    const principal: Principal = { email: ALICE, admin: false, via: 'api_key', guest: false }
    const bytes = (s: string) => new Uint8Array(Buffer.from(s))
    const res = await publishBytes(
      env.deps,
      user,
      'team',
      [{ path: '30-10-26/index.html', bytes: bytes('<h1>inline</h1>') }],
      { principal, path: '30-10-26' }
    )
    expect(res.status).toBe('live')
    expect(await served(env)).toEqual({
      'index.html': '<h1>v1</h1>',
      'about.html': '<h1>about</h1>',
      '30-10-26/index.html': '<h1>inline</h1>',
    })
    await expect(
      publishBytes(env.deps, user, 'team', [{ path: 'x.html', bytes: bytes('x') }], {
        principal,
        path: '30-10-26',
      })
    ).rejects.toMatchObject({ status: 400, code: 'outside_path' })
  })
})

describe('fling_publish and fling_upload_* with path', () => {
  it('publish the folder relative to it, and fling_info shows where', async () => {
    const { env } = await world()
    const { accessToken } = await connect(env, ALICE)
    const res = await callTool(env, accessToken, 'fling_publish', {
      name: 'team',
      path: '/30-10-26/',
      files: [{ path: 'index.html', content: '<h1>from mcp</h1>' }],
    })
    expect(res.isError).toBeFalsy()
    expect(res.content[0]?.text).toContain('to /30-10-26/')
    expect(res.structuredContent.path).toBe('30-10-26')
    expect((await served(env))['30-10-26/index.html']).toBe('<h1>from mcp</h1>')
    expect((await served(env))['index.html']).toBe('<h1>v1</h1>')
    const info = await callTool(env, accessToken, 'fling_info', { name: 'team' })
    expect(info.content[0]?.text).toContain('to /30-10-26/')

    const begun = await callTool(env, accessToken, 'fling_upload_begin', {
      name: 'team',
      path: 'reports/2026',
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
    const files = await served(env)
    expect(files['reports/2026/q1.html']).toBe('<h1>q1</h1>')
    expect(files['reports/2026/index.html']).toContain('q1.html')
    expect(files['30-10-26/index.html']).toBe('<h1>from mcp</h1>')

    const bad = await callTool(env, accessToken, 'fling_publish', {
      name: 'team',
      path: '.git',
      files: [{ path: 'index.html', content: 'x' }],
    })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toContain('invalid_path')
  })
})
