import { siteKvsKey } from '@fling/shared'
import { beforeEach, describe, expect, it } from 'vitest'
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
    const { key } = await createUser(env, 'bob@nearform.com')
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

    const list = await json(await rpc(env, bearer, 'tools/list'))
    const names = list.result.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual(
      [
        'fling_archive',
        'fling_check_name',
        'fling_delete',
        'fling_info',
        'fling_list',
        'fling_publish',
        'fling_rollback',
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
    expect(r.structuredContent.email).toBe('alice@nearform.com')
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
    expect(r.content[0]?.text).toContain('https://q3-report.fling.test/')
    const kvs = JSON.parse(env.kvs.data.get(siteKvsKey('q3-report')) ?? '{}')
    expect(kvs.v).toBe(r.structuredContent.versionId)
    const png = await env.storage.get(`sites/${kvs.id}/${kvs.v}/dot.png`)
    expect([...(png ?? [])]).toEqual([137, 80, 78, 71])
    const html = await env.storage.head(`sites/${kvs.id}/${kvs.v}/index.html`)
    expect(html?.size).toBe(Buffer.byteLength(files[0]?.content ?? ''))

    const again = await callTool(env, bearer, 'fling_publish', { name: 'q3-report', files })
    expect(again.structuredContent.status).toBe('unchanged')
    expect(again.structuredContent.versionId).toBe(r.structuredContent.versionId)

    const pub = await callTool(env, bearer, 'fling_publish', {
      name: 'q3-report',
      files,
      public: true,
    })
    expect(pub.structuredContent.visibility).toBe('public')
  })

  it('name_taken comes back as a tool error with suggestions', async () => {
    const { key } = await createUser(env, 'bob@nearform.com')
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
    expect(env.kvs.data.get(siteKvsKey('pages'))).toBeUndefined()

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
    const kvs = JSON.parse(env.kvs.data.get(siteKvsKey('pages')) ?? '{}')
    const index = Buffer.from(
      (await env.storage.get(`sites/${kvs.id}/${kvs.v}/index.html`)) ?? []
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
    const kvs = JSON.parse(env.kvs.data.get(siteKvsKey('big-site')) ?? '{}')
    const html = Buffer.from((await env.storage.get(`sites/${kvs.id}/${kvs.v}/index.html`)) ?? [])
    expect(html.toString()).toBe('<h1>part one and two</h1>')
    const blob = Buffer.from((await env.storage.get(`sites/${kvs.id}/${kvs.v}/img/blob.bin`)) ?? [])
    expect(blob.equals(bin)).toBe(true)

    // staging is gone; the upload can't be finished twice
    expect(await env.storage.head(`uploads/${uploadId}/x`)).toBeNull()
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
    const { key } = await createUser(env, 'bob@nearform.com')
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
    expect(env.kvs.data.get(siteKvsKey('m'))).toBeUndefined()
    await callTool(env, bearer, 'fling_archive', { name: 'm', unarchive: true })
    expect(env.kvs.data.get(siteKvsKey('m'))).toBeDefined()
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
