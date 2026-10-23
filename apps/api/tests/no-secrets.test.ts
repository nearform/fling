/**
 * The server-side guarantee: dotfiles, secret files and secrets are refused whatever the client
 * (old CLIs, custom scripts, Claude's inline publish).
 */
import { siteKvsKey, siteObjectKey } from '@fling/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { manifestKey } from '../src/storage/types.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

// Assembled at runtime so the repo never contains a real-looking key.
const FAKE_AWS_KEY = `AKIA${'Q'.repeat(16)}`

let env: Env
let key: string

beforeEach(async () => {
  env = setup()
  ;({ key } = await createUser(env))
})

const deployReq = (files: ReturnType<typeof file>[]) => ({
  manifest: { files: files.map(f => f.meta) },
})

describe('deploy API paths', () => {
  it.each(['.env', '.dev.vars', '.git/config', 'a/.npmrc', '.well-known/security.txt'])(
    '%s → 400 dotfile',
    async path => {
      const res = await api(
        env,
        key,
        'POST',
        '/api/sites/hello/deploys',
        deployReq([file('index.html', 'x'), file(path, 'A=1')])
      )
      expect(res.status).toBe(400)
      const body = await json(res)
      expect(body.error).toMatchObject({ code: 'dotfile', paths: [path] })
      expect(body.error.message).toMatch(/never publishes dotfiles/)
      expect(await env.store.getSite('alice@nearform.com', 'hello')).toBeNull()
    }
  )

  it.each(['server.key', 'certs/a.pem', 'id_rsa', 'terraform.tfstate', 'credentials.json'])(
    '%s → 400 secret_file',
    async path => {
      const res = await api(
        env,
        key,
        'POST',
        '/api/sites/hello/deploys',
        deployReq([file('index.html', 'x'), file(path, 'x')])
      )
      expect(res.status).toBe(400)
      expect((await json(res)).error).toMatchObject({ code: 'secret_file', paths: [path] })
    }
  )
})

describe('finalize scans presigned uploads', () => {
  it('a file containing a secret → 422 secret_detected, objects deleted, site not live', async () => {
    const files = [
      file('index.html', '<h1>hi</h1>'),
      file('js/app.js', `// config\nconst k = "${FAKE_AWS_KEY}"\n`, 'text/javascript'),
      file('img/a.png', FAKE_AWS_KEY, 'image/png'), // binary format: not scanned
    ]
    const res = await api(env, key, 'POST', '/api/sites/hello/deploys', deployReq(files))
    const body = await json(res)
    expect(body.status).toBe('upload')
    await upload(env, body.uploads, files)

    const fin = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(fin.status).toBe(422)
    const err = (await json(fin)).error
    expect(err.code).toBe('secret_detected')
    expect(err.findings).toEqual([{ path: 'js/app.js', line: 2, rule: 'aws-access-key-id' }])
    expect(err.message).toMatch(/js\/app\.js line 2: AWS access key ID/)
    expect(JSON.stringify(err)).not.toContain(FAKE_AWS_KEY)

    const site = await env.store.getSite('alice@nearform.com', 'hello')
    expect(site?.currentVersionId).toBeNull()
    expect(env.kvs.data.get(siteKvsKey('hello'))).toBeUndefined()
    const id = site?.id as string
    for (const f of files)
      expect(await env.storage.get(siteObjectKey(id, body.versionId, f.meta.path))).toBeNull()
    expect(await env.storage.get(manifestKey(id, body.versionId))).toBeNull()

    // Finalizing again can't sneak it live.
    const again = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(again.status).not.toBe(200)
  })

  it('clean files and documented examples go live', async () => {
    const files = [file('index.html', '<p>AKIAIOSFODNN7EXAMPLE</p>')]
    const body = await json(
      await api(env, key, 'POST', '/api/sites/hello/deploys', deployReq(files))
    )
    await upload(env, body.uploads, files)
    const fin = await api(env, key, 'POST', `/api/sites/hello/deploys/${body.versionId}/finalize`)
    expect(fin.status).toBe(200)
  })
})

describe('remote MCP', () => {
  let bearer: string
  beforeEach(async () => {
    bearer = (await connect(env)).accessToken
  })

  it('fling_publish with a secret → tool error, nothing published', async () => {
    const r = await callTool(env, bearer, 'fling_publish', {
      name: 'leaky',
      files: [{ path: 'index.html', content: `<p>${FAKE_AWS_KEY}</p>` }],
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/index\.html line 1: AWS access key ID/)
    expect(r.content[0]?.text).not.toContain(FAKE_AWS_KEY)
    expect(await env.store.getSite('alice@nearform.com', 'leaky')).toBeNull()
  })

  it('fling_publish with a dotfile or secret file → tool error', async () => {
    for (const path of ['.env', 'server.key']) {
      const r = await callTool(env, bearer, 'fling_publish', {
        name: 'leaky',
        files: [
          { path: 'index.html', content: 'x' },
          { path, content: 'x' },
        ],
      })
      expect(r.isError).toBe(true)
      expect(r.content[0]?.text).toMatch(path === '.env' ? /dotfile/ : /secret_file/)
    }
  })

  it('chunked upload: a dotfile is refused on upload, a secret at finish', async () => {
    const begin = await callTool(env, bearer, 'fling_upload_begin', { name: 'chunky' })
    const uploadId = begin.structuredContent.uploadId
    const dot = await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: '.dev.vars',
      content: 'A=1',
    })
    expect(dot.isError).toBe(true)
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: `<p>${FAKE_AWS_KEY.slice(0, 10)}`,
    })
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId,
      path: 'index.html',
      content: `${FAKE_AWS_KEY.slice(10)}</p>`,
      append: true,
    })
    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId })
    expect(fin.isError).toBe(true)
    expect(fin.content[0]?.text).toMatch(/secret_detected/)
    expect(await env.store.getSite('alice@nearform.com', 'chunky')).toBeNull()
  })
})
