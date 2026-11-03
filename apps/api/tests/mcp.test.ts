import { siteKvsKey } from '@fling/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Blobs } from '../src/blobs/types.ts'
import { APP_ORIGIN, createUser, type Env, json, setup } from './helpers.ts'
import { callTool, connect, rpc } from './oauth-helpers.ts'

let env: Env
let bearer: string

beforeEach(async () => {
  env = setup()
  bearer = (await connect(env)).accessToken
})

const page = (title: string, body = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

describe('/mcp auth', () => {
  it('401s without a token, pointing at the resource metadata', async () => {
    const res = await rpc(env, undefined, 'initialize', {})
    expect(res.status).toBe(401)
    const header = res.headers.get('www-authenticate') ?? ''
    expect(header).toMatch(/^Bearer /)
    expect(header).toContain(
      `resource_metadata="${APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`
    )
    expect(header).toContain('scope="fling"')
    expect(header).not.toContain('error=')
    expect(res.headers.get('access-control-expose-headers')).toMatch(/www-authenticate/i)
  })

  it('401s with error=invalid_token for a bad or foreign token', async () => {
    const res = await rpc(env, 'eyJhbGciOiJIUzI1NiJ9.e30.bad', 'tools/list')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"')
    // a session JWT is not an access token
    const { session } = await createUser(env)
    expect((await rpc(env, session, 'tools/list')).status).toBe(401)
    expect((await rpc(env, 'fling_notakey', 'tools/list')).status).toBe(401)
  })

  it('accepts a CLI API key', async () => {
    const { key } = await createUser(env, 'bob@example.test')
    const res = await rpc(env, key, 'tools/list')
    expect(res.status).toBe(200)
  })

  it('GET is 405 (stateless, no SSE)', async () => {
    const res = await env.app.request('/mcp', {
      headers: { authorization: `Bearer ${bearer}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(405)
  })
})

describe('/mcp tools', () => {
  it('initialize returns instructions; tools/list has the remote catalogue', async () => {
    const init = await rpc(env, bearer, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.status).toBe(200)
    const body = await json(init)
    expect(body.result.serverInfo.name).toBe('fling')
    expect(body.result.instructions).toMatch(/fling_publish/)
    // Rendered from this instance's config: its name, sites domain and allowlist.
    expect(body.result.instructions).toMatch(
      /^Fling publishes static sites .* at https:\/\/<name>\.fling\.test\./
    )
    expect(body.result.instructions).toContain('anyone signed in to Fling (@example.test accounts)')

    const list = await json(await rpc(env, bearer, 'tools/list'))
    const names = list.result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(
      [
        'fling_archive',
        'fling_check_name',
        'fling_comment_add',
        'fling_comment_delete',
        'fling_comment_resolve',
        'fling_comments_list',
        'fling_delete',
        'fling_files',
        'fling_forms',
        'fling_forms_check',
        'fling_forms_template',
        'fling_group_create',
        'fling_group_delete',
        'fling_group_members',
        'fling_group_rename',
        'fling_group_show',
        'fling_groups',
        'fling_info',
        'fling_list',
        'fling_publish',
        'fling_read_files',
        'fling_response_submit',
        'fling_responses_list',
        'fling_rollback',
        'fling_set_access',
        'fling_set_audience',
        'fling_set_owners',
        'fling_set_publishers',
        'fling_set_visibility',
        'fling_share',
        'fling_upload_begin',
        'fling_upload_file',
        'fling_upload_finish',
        'fling_whoami',
      ].sort()
    )
    const publish = list.result.tools.find((t: { name: string }) => t.name === 'fling_publish')
    expect(publish.inputSchema.properties.files).toBeDefined()
    expect(publish.description).toMatch(/sandbox/)
  })

  it('whoami', async () => {
    const r = await callTool(env, bearer, 'fling_whoami', {})
    expect(r.structuredContent.email).toBe('alice@example.test')
  })

  it('publishes inline content; republishing is unchanged', async () => {
    const files = [
      { path: 'index.html', content: page('Q3', '<img src="dot.png">') },
      {
        path: 'dot.png',
        content: Buffer.from([137, 80, 78, 71]).toString('base64'),
        encoding: 'base64',
      },
    ]
    const r = await callTool(env, bearer, 'fling_publish', { name: 'q3-report', files })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({
      status: 'live',
      name: 'q3-report',
      url: 'https://q3-report.fling.test/',
      visibility: 'private',
      fileCount: 2,
      warnings: [],
    })
    const lines = (r.content[0]?.text ?? '').split('\n')
    expect(lines[0]).toBe('Published 2 files.')
    expect(lines[1]).toMatch(
      /^Share for feedback: https:\/\/fling\.test\/review\/q3-report \(reviewers sign in/
    )
    expect(lines[2]).toMatch(/^Site: https:\/\/q3-report\.fling\.test\/ \(only_me\)\./)
    // A new site with no access asked for gets the instance's default, and says how to change it.
    expect(lines[2]).toContain('Who can open it: Only you can open it.')
    expect(lines[2]).toContain('fling_set_access')
    expect(r.structuredContent).toMatchObject({ access: 'only_me', created: true })
    expect(r.structuredContent.reviewUrl).toBe('https://fling.test/review/q3-report')
    expect(r.content[0]?.text).toContain('fling_files')
    const kvs = JSON.parse(env.routeTable.data.get(siteKvsKey('q3-report')) ?? '{}')
    expect(kvs.v).toBe(r.structuredContent.versionId)
    const png = await env.blobs.get(`sites/${kvs.id}/${kvs.v}/dot.png`)
    expect([...(png ?? [])]).toEqual([137, 80, 78, 71])
    const html = await env.blobs.head(`sites/${kvs.id}/${kvs.v}/index.html`)
    expect(html?.size).toBe(Buffer.byteLength(files[0]?.content ?? ''))

    // Re-publishing never changes who can open it, even when asked to.
    const again = await callTool(env, bearer, 'fling_publish', {
      name: 'q3-report',
      files,
      access: 'members',
    })
    expect(again.structuredContent.status).toBe('unchanged')
    expect(again.structuredContent.access).toBe('only_me')
    expect(again.structuredContent.created).toBeUndefined()
    expect(again.content[0]?.text).toContain('Its access is unchanged')
    expect(again.structuredContent.versionId).toBe(r.structuredContent.versionId)

    const pub = await callTool(env, bearer, 'fling_publish', {
      name: 'q3-report',
      files,
      public: true,
    })
    expect(pub.structuredContent.visibility).toBe('public')
  })

  it('server-side puts use the cache rule: hashed names immutable, the rest revalidate', async () => {
    const put = vi.spyOn(env.blobs as Blobs, 'put')
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'cached',
      files: [
        { path: 'a.html', content: page('A') },
        { path: 'main.3f9a2c1b.css', content: 'body{}' },
        { path: 'style.css', content: 'p{}' },
      ],
      listHtml: true,
    })
    expect(r.structuredContent.status).toBe('live')
    const cc = Object.fromEntries(
      put.mock.calls.map(([key, , opts]) => [key.split('/').pop(), opts?.cacheControl])
    )
    const revalidate = 'public, max-age=0, must-revalidate, s-maxage=31536000'
    expect(cc).toEqual({
      'index.html': revalidate, // the generated listing too
      'a.html': revalidate,
      'style.css': revalidate,
      'main.3f9a2c1b.css': 'public, max-age=31536000, immutable',
    })
  })

  it('waits for the edge after publishing / sharing; says so when it is not there yet', async () => {
    const waited: { url: string; paths: readonly string[] }[] = []
    let ready = false
    env.deps.waitReady = async (url, paths) => {
      waited.push({ url, paths })
      return { ready }
    }
    const files = [{ path: 'page.html', content: page('P') }]
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'edgy',
      files,
      listHtml: false,
    })
    expect(r.structuredContent).toMatchObject({ status: 'live', ready: false })
    expect(r.content[0]?.text).toMatch(/reload if you see a 404/)
    expect(waited).toEqual([{ url: 'https://edgy.fling.test/', paths: ['page.html'] }])

    // unchanged: already live, no wait
    const same = await callTool(env, bearer, 'fling_publish', {
      name: 'edgy',
      files,
      listHtml: false,
    })
    expect(same.structuredContent).toMatchObject({ status: 'unchanged', ready: true })
    expect(waited).toHaveLength(1)

    ready = true
    const share = await callTool(env, bearer, 'fling_share', { name: 'edgy' })
    expect(share.structuredContent).toMatchObject({ action: 'created', ready: true })
    expect(share.content[0]?.text).not.toMatch(/reload/)
    expect(waited[1]?.url).toBe(share.structuredContent.shareUrl)
    expect(waited[1]?.paths).toEqual(['page.html'])
  })

  it('name_taken comes back as a tool error with suggestions', async () => {
    const { key } = await createUser(env, 'bob@example.test')
    await callTool(env, key, 'fling_publish', {
      name: 'taken',
      files: [{ path: 'index.html', content: 'bob' }],
    })
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'taken',
      files: [{ path: 'index.html', content: 'alice' }],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/taken by someone else/)
    expect(r.content[0]?.text).toContain('taken-al')
    const check = await callTool(env, bearer, 'fling_check_name', { name: 'taken' })
    expect(check.structuredContent.status).toBe('taken')
  })

  it('rejects bad paths and bad base64 as tool errors', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'x1',
      files: [{ path: '../etc/passwd', content: 'x' }],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/Invalid file path/)
    const b = await callTool(env, bearer, 'fling_publish', {
      name: 'x1',
      files: [{ path: 'a.png', content: '%%%', encoding: 'base64' }],
    })
    expect(b.content[0]?.text).toMatch(/not valid base64/)
  })

  it('no root index.html: asks first, then lists HTML pages or publishes without', async () => {
    const files = [
      { path: 'a.html', content: page('Alpha') },
      { path: 'docs/b.html', content: page('Beta') },
      { path: 'style.css', content: 'body{}' },
    ]
    const ask = await callTool(env, bearer, 'fling_publish', { name: 'pages', files })
    expect(ask.isError).toBeFalsy()
    expect(ask.structuredContent).toMatchObject({
      status: 'needs_decision',
      reason: 'no_index_html',
      htmlPages: ['a.html', 'docs/b.html'],
    })
    expect(ask.content[0]?.text).toMatch(/listHtml: true/)
    expect(env.routeTable.data.get(siteKvsKey('pages'))).toBeUndefined()

    const listed = await callTool(env, bearer, 'fling_publish', {
      name: 'pages',
      files,
      listHtml: true,
    })
    expect(listed.structuredContent).toMatchObject({
      status: 'live',
      generatedIndex: true,
      fileCount: 4,
    })
    const kvs = JSON.parse(env.routeTable.data.get(siteKvsKey('pages')) ?? '{}')
    const index = Buffer.from(
      (await env.blobs.get(`sites/${kvs.id}/${kvs.v}/index.html`)) ?? []
    ).toString('utf8')
    expect(index).toContain('Alpha')
    expect(index).toContain('docs/b.html')

    const same = await callTool(env, bearer, 'fling_publish', {
      name: 'pages',
      files,
      listHtml: true,
    })
    expect(same.structuredContent.status).toBe('unchanged')

    const without = await callTool(env, bearer, 'fling_publish', {
      name: 'pages',
      files,
      listHtml: false,
    })
    expect(without.structuredContent).toMatchObject({
      status: 'live',
      generatedIndex: false,
      fileCount: 3,
    })
    expect(without.structuredContent.warnings[0]).toMatch(/404/)

    // fling_files: the served version has no index.html → warning; the earlier one was generated
    const listing = await callTool(env, bearer, 'fling_files', { name: 'pages' })
    expect(listing.isError).toBeFalsy()
    expect(listing.structuredContent).toMatchObject({
      name: 'pages',
      current: true,
      versionId: without.structuredContent.versionId,
      generatedIndex: false,
    })
    expect(listing.structuredContent.files.map((f: any) => f.path)).toEqual([
      'a.html',
      'docs/b.html',
      'style.css',
    ])
    expect(listing.content[0]?.text).toMatch(/no index\.html at the root/)
    expect(listing.content[0]?.text).toContain('- docs/b.html (')
    const older = await callTool(env, bearer, 'fling_files', {
      name: 'pages',
      versionId: listed.structuredContent.versionId,
    })
    expect(older.structuredContent).toMatchObject({ current: false, generatedIndex: true })
    expect(older.content[0]?.text).toMatch(/not the version being served/)
    const missing = await callTool(env, bearer, 'fling_files', { name: 'nope' })
    expect(missing.isError).toBe(true)

    // no HTML at all: no question, just a warning
    const assets = await callTool(env, bearer, 'fling_publish', {
      name: 'assets-only',
      files: [{ path: 'data.json', content: '{}' }],
    })
    expect(assets.structuredContent.status).toBe('live')
    expect(assets.structuredContent.warnings).toHaveLength(1)
  })

  it('chunked upload: begin → files (with append) → finish', async () => {
    const begin = await callTool(env, bearer, 'fling_upload_begin', { name: 'big-site', spa: true })
    const uploadId = begin.structuredContent.uploadId
    expect(uploadId).toBeTruthy()
    const bin = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
    const b64 = bin.toString('base64')
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: '<h1>part one',
    })
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: ' and two</h1>',
      append: true,
    })
    // base64 split at an arbitrary point (not a multiple of 4)
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'img/blob.bin',
      content: b64.slice(0, 101),
      encoding: 'base64',
    })
    const tail = await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'img/blob.bin',
      content: b64.slice(101),
      encoding: 'base64',
      append: true,
    })
    expect(tail.isError).toBeFalsy()
    const mismatch = await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'img/blob.bin',
      content: 'x',
      append: true,
    })
    expect(mismatch.isError).toBe(true)

    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId })
    expect(fin.isError).toBeFalsy()
    expect(fin.structuredContent).toMatchObject({
      status: 'live',
      name: 'big-site',
      spa: true,
      fileCount: 2,
    })
    const kvs = JSON.parse(env.routeTable.data.get(siteKvsKey('big-site')) ?? '{}')
    const html = Buffer.from((await env.blobs.get(`sites/${kvs.id}/${kvs.v}/index.html`)) ?? [])
    expect(html.toString()).toBe('<h1>part one and two</h1>')
    const blob = Buffer.from((await env.blobs.get(`sites/${kvs.id}/${kvs.v}/img/blob.bin`)) ?? [])
    expect(blob.equals(bin)).toBe(true)

    // staging is gone; the upload can't be finished twice
    expect(await env.blobs.head(`uploads/${uploadId}/x`)).toBeNull()
    expect(await env.store.getUpload(uploadId)).toBeNull()
    const twice = await callTool(env, bearer, 'fling_upload_finish', { uploadId })
    expect(twice.isError).toBe(true)
  })

  it('chunked upload without index.html keeps the upload open until the user decides', async () => {
    const { uploadId } = (await callTool(env, bearer, 'fling_upload_begin', { name: 'chunky' }))
      .structuredContent
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'one.html',
      content: page('One'),
    })
    const ask = await callTool(env, bearer, 'fling_upload_finish', { uploadId })
    expect(ask.structuredContent.status).toBe('needs_decision')
    expect(ask.content[0]?.text).toMatch(/fling_upload_finish/)
    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId, listHtml: true })
    expect(fin.structuredContent).toMatchObject({ status: 'live', generatedIndex: true })
  })

  it('chunked upload: name checks up front, other users and expiry are refused', async () => {
    const { key } = await createUser(env, 'bob@example.test')
    await callTool(env, key, 'fling_publish', {
      name: 'bobs',
      files: [{ path: 'index.html', content: 'b' }],
    })
    const taken = await callTool(env, bearer, 'fling_upload_begin', { name: 'bobs' })
    expect(taken.isError).toBe(true)
    expect(taken.content[0]?.text).toMatch(/bobs-al/)

    const { uploadId } = (await callTool(env, bearer, 'fling_upload_begin', { name: 'mine' }))
      .structuredContent
    const stolen = await callTool(env, key, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: 'x',
    })
    expect(stolen.isError).toBe(true)
    env.advance(3601_000)
    // the access token has expired too; use alice's CLI key
    const alice = await createUser(env)
    const late = await callTool(env, alice.key, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: 'x',
    })
    expect(late.isError).toBe(true)
    expect(late.content[0]?.text).toMatch(/expire/)
  })

  it('fling_list lists the last updated first, or in the order `sort` asks for', async () => {
    for (const name of ['beta', 'alpha']) {
      await callTool(env, bearer, 'fling_publish', {
        name,
        files: [{ path: 'index.html', content: name }],
      })
      env.advance(1000)
    }
    const names = async (args: Record<string, unknown>) =>
      (await callTool(env, bearer, 'fling_list', args)).structuredContent.sites.map(
        (s: { name: string }) => s.name
      )
    expect(await names({})).toEqual(['alpha', 'beta'])
    expect(await names({ sort: 'created' })).toEqual(['alpha', 'beta'])
    expect(await names({ sort: 'name' })).toEqual(['alpha', 'beta'])
    await callTool(env, bearer, 'fling_publish', {
      name: 'beta',
      files: [{ path: 'index.html', content: 'beta v2' }],
    })
    expect(await names({ sort: 'updated' })).toEqual(['beta', 'alpha'])
    expect(await names({ sort: 'created' })).toEqual(['alpha', 'beta'])
  })

  it('manages sites: list, info, share, visibility, archive, rollback, delete', async () => {
    const v1 = await callTool(env, bearer, 'fling_publish', {
      name: 'm',
      files: [{ path: 'index.html', content: 'v1' }],
    })
    await callTool(env, bearer, 'fling_publish', {
      name: 'm',
      files: [{ path: 'index.html', content: 'v2' }],
    })
    expect((await callTool(env, bearer, 'fling_list', {})).structuredContent.sites).toHaveLength(1)
    const info = await callTool(env, bearer, 'fling_info', { name: 'm' })
    expect(info.structuredContent.versions).toHaveLength(2)
    for (const v of info.structuredContent.versions)
      expect(v.publishedBy).toBe('alice@example.test')
    expect(info.content[0]?.text).toContain('by alice@example.test')
    const share = await callTool(env, bearer, 'fling_share', { name: 'm' })
    expect(share.structuredContent.shareUrl).toMatch(/^https:\/\/s--/)
    const same = await callTool(env, bearer, 'fling_share', { name: 'm' })
    expect(same.structuredContent).toMatchObject({
      action: 'existing',
      shareUrl: share.structuredContent.shareUrl,
    })
    const vis = await callTool(env, bearer, 'fling_set_visibility', {
      name: 'm',
      visibility: 'public',
    })
    expect(vis.structuredContent.visibility).toBe('public')
    const rb = await callTool(env, bearer, 'fling_rollback', {
      name: 'm',
      versionId: v1.structuredContent.versionId,
    })
    expect(rb.structuredContent.currentVersionId).toBe(v1.structuredContent.versionId)
    await callTool(env, bearer, 'fling_archive', { name: 'm' })
    expect(env.routeTable.data.get(siteKvsKey('m'))).toBeUndefined()
    await callTool(env, bearer, 'fling_archive', { name: 'm', unarchive: true })
    expect(env.routeTable.data.get(siteKvsKey('m'))).toBeDefined()
    const noConfirm = await rpc(env, bearer, 'tools/call', {
      name: 'fling_delete',
      arguments: { name: 'm', confirm: false },
    })
    expect((await json(noConfirm)).result.isError).toBe(true)
    await callTool(env, bearer, 'fling_delete', { name: 'm', confirm: true })
    const gone = await callTool(env, bearer, 'fling_info', { name: 'm' })
    expect(gone.isError).toBe(true)
  })
})

describe('/mcp access levels', () => {
  const files = [{ path: 'index.html', content: page('Hi') }]

  it('a new site takes the access asked for, with its audience', async () => {
    await connect(env, 'bob@example.test')
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'team-deck',
      files,
      access: 'people',
      emails: ['bob@example.test'],
    })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent.access).toBe('people')
    expect(r.content[0]?.text).toContain('Only you and 1 person can open it.')
    const bad = await callTool(env, bearer, 'fling_publish', {
      name: 'nobody',
      files,
      access: 'people',
    })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toMatch(/needs at least one address or group/)
    const members = await callTool(env, bearer, 'fling_publish', {
      name: 'everyone',
      files,
      access: 'members',
    })
    expect(members.content[0]?.text).toContain(
      'Anyone signed in to Fling (@example.test accounts) can open it.'
    )
  })

  it('fling_set_access reaches every level', async () => {
    await callTool(env, bearer, 'fling_publish', { name: 'levels', files })
    const set = (args: object) =>
      callTool(env, bearer, 'fling_set_access', { name: 'levels', ...args })
    expect((await set({ access: 'members' })).structuredContent.access).toBe('members')
    const people = await set({ access: 'people', emails: ['bob@example.test'] })
    expect(people.structuredContent.access).toBe('people')
    expect(people.content[0]?.text).toContain('Restricted: only you and 1 person')
    const pub = await set({ access: 'public' })
    expect(pub.structuredContent.access).toBe('public')
    // Private again: the audience it kept.
    const back = await callTool(env, bearer, 'fling_set_visibility', {
      name: 'levels',
      visibility: 'private',
    })
    expect(back.structuredContent.access).toBe('people')
    const mine = await set({ access: 'only_me' })
    expect(mine.structuredContent).toMatchObject({ access: 'only_me', audienceSize: 0 })
    expect(mine.content[0]?.text).toContain('Only you: nobody else can open it.')
    expect((await set({ access: 'groups' })).isError).toBe(true)
  })
})

describe('/mcp comment tools', () => {
  const publish = (bearer: string, name: string) =>
    callTool(env, bearer, 'fling_publish', {
      name,
      files: [{ path: 'index.html', content: page('Hi') }],
      access: 'members',
    })

  it('a member comments, the owner lists, replies, resolves and deletes', async () => {
    await publish(bearer, 'deck')
    const bob = (await connect(env, 'bob@example.test')).accessToken
    const added = await callTool(env, bob, 'fling_comment_add', {
      name: 'deck',
      body: 'Slide 2 has a typo',
      path: '/slides/index.html',
    })
    expect(added.isError).toBeFalsy()
    const id = added.structuredContent.id
    expect(added.structuredContent).toMatchObject({ path: '/slides/', parentId: null })
    expect(added.content[0]?.text).toContain('https://fling.test/review/deck')

    const reply = await callTool(env, bearer, 'fling_comment_add', {
      name: 'deck',
      body: 'Thanks, fixed',
      replyTo: id,
    })
    expect(reply.structuredContent.parentId).toBe(id)

    const listed = await callTool(env, bearer, 'fling_comments_list', { name: 'deck' })
    const text = listed.content[0]?.text ?? ''
    expect(text).toMatch(
      /^1 open thread on deck\. Review page: https:\/\/fling\.test\/review\/deck/
    )
    expect(text).toContain(`[${id}] /slides/, current version — bob@example.test`)
    expect(text).toContain('Slide 2 has a typo')
    expect(text).toContain('alice@example.test')
    expect(listed.structuredContent.comments).toHaveLength(2)

    const resolved = await callTool(env, bearer, 'fling_comment_resolve', { name: 'deck', id })
    expect(resolved.structuredContent.resolvedBy).toEqual({
      kind: 'user',
      email: 'alice@example.test',
    })
    const open = await callTool(env, bearer, 'fling_comments_list', { name: 'deck' })
    expect(open.structuredContent.comments).toEqual([])
    expect(open.content[0]?.text).toMatch(/^0 open threads on deck \(1 resolved not shown\)/)
    const all = await callTool(env, bearer, 'fling_comments_list', {
      name: 'deck',
      includeResolved: true,
    })
    expect(all.content[0]?.text).toContain(`[${id}] RESOLVED /slides/`)

    // Bob can't delete the owner's reply; the owner deletes Bob's thread (and the reply).
    const refused = await callTool(env, bob, 'fling_comment_delete', {
      name: 'deck',
      id: reply.structuredContent.id,
    })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/author, the site owner or an admin/)
    const deleted = await callTool(env, bearer, 'fling_comment_delete', { name: 'deck', id })
    expect(deleted.isError).toBeFalsy()
    const after = await callTool(env, bob, 'fling_comments_list', {
      name: 'deck',
      includeResolved: true,
    })
    expect(after.structuredContent.comments).toEqual([])
  })

  it('an unknown site reads as missing', async () => {
    const r = await callTool(env, bearer, 'fling_comments_list', { name: 'nope' })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toBe('No site named "nope"')
  })

  it('with comments turned off the tools are not offered', async () => {
    env = setup({ comments: false })
    const off = (await connect(env)).accessToken
    const list = await json(await rpc(env, off, 'tools/list'))
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name)
    expect(names.filter(n => n.includes('comment'))).toEqual([])
    expect(names.filter(n => n.includes('forms') || n.includes('response'))).toEqual([])
    const init = await json(
      await rpc(env, off, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
    )
    expect(init.result.instructions).not.toContain('fling_comments_list')
    const pub = await callTool(env, off, 'fling_publish', {
      name: 'quiet',
      files: [{ path: 'index.html', content: page('Hi') }],
    })
    expect(pub.content[0]?.text).toMatch(/^Published 1 file: https:\/\/quiet\.fling\.test\//)
    expect(pub.structuredContent.reviewUrl).toBeUndefined()
  })
})

describe('/mcp forms tools', () => {
  const pages = [
    { path: 'index.html', content: page('Home') },
    { path: 'interviews/1.html', content: page('One') },
    { path: 'interviews/2.html', content: page('Two') },
  ]

  it('a template passes fling_forms_check, and a broken config says where', async () => {
    const t = await callTool(env, bearer, 'fling_forms_template', {
      template: 'labels',
      title: 'Evals',
    })
    expect(t.isError).toBeFalsy()
    expect(t.structuredContent.forms.title).toBe('Evals')
    const ok = await callTool(env, bearer, 'fling_forms_check', {
      forms: t.structuredContent.forms,
      paths: pages.map(p => p.path),
    })
    expect(ok.structuredContent.ok).toBe(true)
    expect(ok.content[0]?.text).toContain('3 pages')
    const bad = await callTool(env, bearer, 'fling_forms_check', { forms: { forms: [] } })
    expect(bad.structuredContent.ok).toBe(false)
    expect(bad.content[0]?.text).toMatch(/not valid:\n- title/)
  })

  it('a publish without forms carries the hint; with forms, the summary and the responses page', async () => {
    const plain = await callTool(env, bearer, 'fling_publish', {
      name: 'evals',
      files: pages,
      access: 'members',
    })
    expect(plain.structuredContent.formsHint).toMatch(/fling_forms_template/)
    expect(plain.content[0]?.text).toContain('add a form rather than asking reviewers')

    const forms = (await callTool(env, bearer, 'fling_forms_template', { template: 'labels' }))
      .structuredContent.forms
    forms.forms[0].paths = ['interviews/**']
    const live = await callTool(env, bearer, 'fling_publish', {
      name: 'evals',
      files: pages,
      forms,
    })
    expect(live.isError).toBeFalsy()
    expect(live.structuredContent.formsHint).toBeUndefined()
    expect(live.structuredContent.forms).toMatchObject({
      title: 'Labels',
      responsesUrl: 'https://fling.test/sites/evals/responses',
    })
    expect(live.structuredContent.forms.forms[0].pages).toEqual([
      '/interviews/1.html',
      '/interviews/2.html',
    ])
    const text = live.content[0]?.text ?? ''
    expect(text).toContain('answer its forms')
    expect(text).toContain('Labels · Label this page (label): one per reviewer per page, 2 pages')

    // A fling.forms.json among the files is the config, never a file of the site.
    const asFile = await callTool(env, bearer, 'fling_publish', {
      name: 'evals-file',
      files: [...pages, { path: 'fling.forms.json', content: JSON.stringify(forms) }],
    })
    expect(asFile.structuredContent.fileCount).toBe(3)
    expect(asFile.structuredContent.forms.title).toBe('Labels')
    const files = await callTool(env, bearer, 'fling_files', { name: 'evals-file' })
    expect(files.content[0]?.text).not.toContain('fling.forms.json')

    const refused = await callTool(env, bearer, 'fling_publish', {
      name: 'evals',
      files: pages,
      forms: {
        title: 'x',
        forms: [{ id: 'a', title: 'A', kind: 'page', schema: { type: 'array' } }],
      },
    })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/invalid_forms/)
  })

  it('fling_forms shows the config; responses are submitted and listed with progress', async () => {
    const forms = (await callTool(env, bearer, 'fling_forms_template', { template: 'labels' }))
      .structuredContent.forms
    forms.forms[0].visibility = 'everyone'
    await callTool(env, bearer, 'fling_publish', {
      name: 'evals',
      files: pages,
      forms,
      access: 'members',
    })
    const shown = await callTool(env, bearer, 'fling_forms', { name: 'evals' })
    expect(shown.structuredContent.config.title).toBe('Labels')
    expect(shown.content[0]?.text).toContain('3 pages')

    const bob = (await connect(env, 'bob@example.test')).accessToken
    const sent = await callTool(env, bob, 'fling_response_submit', {
      name: 'evals',
      path: '/interviews/1.html',
      formId: 'label',
      data: { verdict: 'pass' },
    })
    expect(sent.isError).toBeFalsy()
    expect(sent.content[0]?.text).toContain('Verdict: Pass')
    const wrong = await callTool(env, bob, 'fling_response_submit', {
      name: 'evals',
      path: '/interviews/1.html',
      formId: 'label',
      data: { verdict: 'maybe' },
    })
    expect(wrong.isError).toBe(true)
    expect(wrong.content[0]?.text).toMatch(/invalid_response/)

    const listed = await callTool(env, bearer, 'fling_responses_list', { name: 'evals' })
    expect(listed.structuredContent.responses).toHaveLength(1)
    expect(listed.structuredContent.responses[0]).toMatchObject({
      author: 'bob@example.test',
      data: { verdict: 'pass' },
    })
    expect(listed.content[0]?.text).toContain(
      'Label this page (label): 1 / 3 pages answered, 1 reviewer'
    )
    const comments = await callTool(env, bearer, 'fling_comments_list', { name: 'evals' })
    expect(comments.content[0]?.text).toContain('(response to form "label")')
  })

  it('a site without forms whose comments look like coded labels gets a note', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      path: `p${i}.html`,
      content: page(`P${i}`),
    }))
    await callTool(env, bearer, 'fling_publish', {
      name: 'coded',
      files: [{ path: 'index.html', content: page('Home') }, ...many],
    })
    for (const [i, code] of ['B2', 'A1', 'B2', 'A1', 'B2', 'C3'].entries()) {
      await callTool(env, bearer, 'fling_comment_add', {
        name: 'coded',
        body: code,
        path: `p${i}.html`,
      })
    }
    const listed = await callTool(env, bearer, 'fling_comments_list', { name: 'coded' })
    expect(listed.content[0]?.text).toContain('look like labels typed by hand')
  })
})
