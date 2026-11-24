import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ARCHIVE_PART_BYTES, MCP_UPLOAD_TTL_SECONDS, siteKvsKey } from '@fling/shared'
import { getRequestListener } from '@hono/node-server'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_ORIGIN, createUser, type Env, json, setup } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

let env: Env
let bearer: string

beforeEach(async () => {
  env = setup()
  bearer = (await connect(env)).accessToken
})

const text = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>

/** The signed archive URL inside the script fling_upload_begin returned. */
const urlOf = (script: string) => {
  const match = script.match(/^URL = "(.*)"$/m)
  if (!match?.[1]) throw new Error('no URL in the script')
  return new URL(match[1])
}

async function begin(name: string, args: Record<string, unknown> = {}) {
  const res = await callTool(env, bearer, 'fling_upload_begin', { name, ...args })
  expect(res.isError).toBeFalsy()
  return res.structuredContent as {
    uploadId: string
    script: string
    host: string
    allowAdvice: string
  }
}

/** PUT `zip` in parts, as the script does. */
async function putParts(url: URL, zip: Uint8Array, partBytes = ARCHIVE_PART_BYTES) {
  const parts: Uint8Array[] = []
  for (let i = 0; i < zip.length; i += partBytes) parts.push(zip.slice(i, i + partBytes))
  for (const [n, part] of parts.entries()) {
    const res = await env.app.request(`${url.pathname}${url.search}&part=${n}&of=${parts.length}`, {
      method: 'PUT',
      body: part as Uint8Array<ArrayBuffer>,
      headers: { 'content-type': 'application/zip' },
    })
    expect(res.status).toBe(200)
  }
}

const servedFile = async (name: string, path: string) => {
  const kvs = JSON.parse(env.routeTable.data.get(siteKvsKey(name)) ?? '{}')
  const bytes = await env.blobs.get(`sites/${kvs.id}/${kvs.v}/${path}`)
  return bytes ? Buffer.from(bytes).toString('utf8') : null
}

describe('sandbox upload', () => {
  it('begin returns a script on the app host; parts then finish publish the zip', async () => {
    const started = await begin('from-sandbox')
    const url = urlOf(started.script)
    expect(url.origin).toBe(APP_ORIGIN)
    expect(started.host).toBe(new URL(APP_ORIGIN).host)
    expect(started.allowAdvice).toContain(started.host)
    expect(started.allowAdvice).toContain(`${APP_ORIGIN}/guide/start/claude-uploads`)
    expect(started.script).toContain("python3 - '<path>'")
    // Edges that screen bots refuse urllib's own User-Agent (Cloudflare: 403, error 1010).
    expect(started.script).toMatch(/"user-agent": UA/)

    const zip = zipSync({
      'site/index.html': text('<h1>hi</h1>'),
      'site/css/app.css': text('h1{}'),
      'site/.env': text('SECRET=1'),
      '__MACOSX/site/._index.html': text('junk'),
    })
    // Small parts, so the zip spans several.
    await putParts(url, zip, 64)
    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId: started.uploadId })
    expect(fin.isError).toBeFalsy()
    expect(fin.structuredContent).toMatchObject({ status: 'live', fileCount: 2 })
    expect(fin.structuredContent.warnings.join(' ')).toContain('.env')
    expect(await servedFile('from-sandbox', 'index.html')).toBe('<h1>hi</h1>')
    expect(await servedFile('from-sandbox', 'css/app.css')).toBe('h1{}')
    expect(await env.store.getUpload(started.uploadId)).toBeNull()
  })

  it('refuses a bad signature, an expired upload and parts out of range', async () => {
    const { uploadId, script } = await begin('refusals')
    const url = urlOf(script)
    const put = (search: string, body: Uint8Array<ArrayBuffer> = text('x')) =>
      env.app.request(`${url.pathname}${search}`, { method: 'PUT', body })

    const tampered = new URLSearchParams(url.search)
    tampered.set('sig', `${tampered.get('sig')?.slice(0, -2)}AA`)
    expect((await put(`?${tampered}&part=0&of=1`)).status).toBe(403)
    // another upload's id with this one's signature
    const other = await begin('refusals-other')
    const foreign = `/api/uploads/${other.uploadId}/archive${url.search}&part=0&of=1`
    expect((await env.app.request(foreign, { method: 'PUT', body: text('x') })).status).toBe(403)

    expect((await put(`${url.search}&part=1&of=1`)).status).toBe(400)
    expect((await put(`${url.search}&part=0&of=0`)).status).toBe(400)
    expect((await put(`${url.search}&part=0&of=1000`)).status).toBe(400)
    const tooBig = new Uint8Array(ARCHIVE_PART_BYTES + 1)
    expect((await put(`${url.search}&part=0&of=1`, tooBig)).status).toBe(413)

    env.advance(MCP_UPLOAD_TTL_SECONDS * 1000 + 1)
    expect((await put(`${url.search}&part=0&of=1`)).status).toBe(403)
    expect(await env.blobs.get(`uploads/${uploadId}/archive/0`)).toBeNull()
  })

  it('finish refuses a missing part, a broken zip and a zip mixed with fling_upload_file', async () => {
    const missing = await begin('missing-part')
    const url = urlOf(missing.script)
    await env.app.request(`${url.pathname}${url.search}&part=0&of=2`, {
      method: 'PUT',
      body: text('half'),
    })
    const gap = await callTool(env, bearer, 'fling_upload_finish', { uploadId: missing.uploadId })
    expect(gap.isError).toBe(true)
    expect(gap.content[0]?.text).toMatch(/Part 2 of 2/)

    const broken = await begin('broken-zip')
    await putParts(urlOf(broken.script), text('not a zip'))
    const bad = await callTool(env, bearer, 'fling_upload_finish', { uploadId: broken.uploadId })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toMatch(/zip/)

    const mixed = await begin('mixed')
    await putParts(urlOf(mixed.script), zipSync({ 'index.html': text('a') }))
    await callTool(env, bearer, 'fling_upload_file', {
      uploadId: mixed.uploadId,
      path: 'other.html',
      content: 'b',
    })
    const both = await callTool(env, bearer, 'fling_upload_finish', { uploadId: mixed.uploadId })
    expect(both.isError).toBe(true)
  })

  it('a secret in the zip is refused at finish, like any publish', async () => {
    const started = await begin('secret-zip')
    await putParts(
      urlOf(started.script),
      zipSync({
        'index.html': text('<h1>x</h1>'),
        'config.js': text(`const key = "AKIA${'Q'.repeat(16)}"`),
      })
    )
    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId: started.uploadId })
    expect(fin.isError).toBe(true)
    expect(fin.content[0]?.text).toMatch(/secret|AWS/i)
    expect(env.routeTable.data.get(siteKvsKey('secret-zip'))).toBeUndefined()
  })

  it('the API routes begin and finish for the local MCP server', async () => {
    const { key } = await createUser(env, 'bob@example.test')
    const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const begun = await env.app.request('/api/sites/bobs-upload/uploads', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ access: 'only_me' }),
    })
    expect(begun.status).toBe(200)
    const started = await json(begun)
    expect(started).toMatchObject({ name: 'bobs-upload', host: new URL(APP_ORIGIN).host })
    await putParts(urlOf(started.script), zipSync({ 'index.html': text('<p>bob</p>') }))
    const fin = await env.app.request(`/api/uploads/${started.uploadId}/finish`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    })
    expect(fin.status).toBe(200)
    expect(await json(fin)).toMatchObject({ kind: 'published', status: 'live', fileCount: 1 })
    expect(await servedFile('bobs-upload', 'index.html')).toBe('<p>bob</p>')
  })
})

describe('the sandbox upload script', () => {
  let server: Server | undefined
  afterEach(() => server?.close())

  it('zips a folder and uploads it in parts with python3 alone', async () => {
    const started = await begin('python-upload')
    server = createServer(getRequestListener(req => env.app.fetch(req)))
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const script = started.script.replace(APP_ORIGIN, `http://127.0.0.1:${port}`)

    const dir = mkdtempSync(join(tmpdir(), 'fling-sandbox-'))
    mkdirSync(join(dir, 'site', 'img'), { recursive: true })
    writeFileSync(join(dir, 'site', 'index.html'), '<h1>from python</h1>')
    writeFileSync(join(dir, 'site', '.hidden'), 'never')
    // Incompressible bytes, so the zip needs more than one part.
    const noise = randomBytes(ARCHIVE_PART_BYTES + 1024)
    writeFileSync(join(dir, 'site', 'img', 'noise.bin'), noise)

    const command = script.replace("'<path>'", `'${join(dir, 'site')}'`)
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(stdout).toMatch(/^FLING_UPLOADED 2 part\(s\)/)

    const fin = await callTool(env, bearer, 'fling_upload_finish', { uploadId: started.uploadId })
    expect(fin.isError).toBeFalsy()
    expect(fin.structuredContent).toMatchObject({ status: 'live', fileCount: 2 })
    expect(await servedFile('python-upload', 'index.html')).toBe('<h1>from python</h1>')
  })

  it('reports a host it cannot reach as blocked', async () => {
    const started = await begin('python-blocked')
    // Nothing listens on port 9: the connection is refused, as a proxy refuses a host.
    const script = started.script.replace(APP_ORIGIN, 'http://127.0.0.1:9')
    const dir = mkdtempSync(join(tmpdir(), 'fling-sandbox-'))
    writeFileSync(join(dir, 'index.html'), 'x')
    const command = script.replace("'<path>'", `'${join(dir, 'index.html')}'`)
    const failed = await promisify(execFile)('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '' },
    }).catch((error: { stderr: string }) => error)
    expect('stderr' in failed ? failed.stderr : '').toMatch(/^FLING_UPLOAD_BLOCKED /m)
  }, 30_000)
})
