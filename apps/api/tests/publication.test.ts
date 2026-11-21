/**
 * Publication through its own interface (stage / publish / publishBytes) on Records (memory table) + FsBlobs.
 * FsBlobs enforces the same rules as S3: upload URLs are bound to the manifest's sha256 and expire.
 */

import { createHash } from 'node:crypto'
import { MAX_FILE_BYTES, siteObjectKey } from '@fling/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FsBlobs } from '../src/blobs/fs.ts'
import { manifestKey, stagedObjectKey } from '../src/blobs/types.ts'
import type { Principal } from '../src/policy.ts'
import { publish, publishBytes, stage, UPLOAD_URL_TTL_SECONDS } from '../src/publication.ts'
import type { User } from '../src/store/types.ts'
import { APP_ORIGIN, createUser, type Env, file, setup, upload } from './helpers.ts'

// Assembled at runtime so the repo never contains a real-looking key.
const FAKE_AWS_KEY = `AKIA${'Q'.repeat(16)}`

let env: Env
let user: User
let principal: Principal

beforeEach(async () => {
  env = setup()
  ;({ user } = await createUser(env))
  principal = { email: user.email, admin: false, via: 'api_key', guest: false }
})

type Upload = { path: string; url: string; headers: Record<string, string> }
const body = (files: ReturnType<typeof file>[]) => ({ manifest: { files: files.map(f => f.meta) } })
const put = (u: Upload, content: string, headers = u.headers) =>
  env.app.request(u.url, { method: 'PUT', headers, body: content })

async function stageUploads(files: ReturnType<typeof file>[], name = 'hello') {
  const res = await stage(env.deps, user, name, body(files), principal)
  if (res.status !== 'upload') throw new Error(`expected upload, got ${res.status}`)
  return res
}

async function stored(versionId: string, path: string, name = 'hello') {
  const site = await env.store.findSite(name)
  const bytes = await env.blobs.get(siteObjectKey(site?.id as string, versionId, path))
  return bytes ? Buffer.from(bytes).toString('utf8') : null
}

describe('upload URLs only accept the manifest bytes', () => {
  it('carry the checksum header the client must send', async () => {
    const f = file('index.html', '<h1>hi</h1>')
    const { uploads } = await stageUploads([f])
    const expected = Buffer.from(f.meta.sha256, 'hex').toString('base64')
    expect(uploads[0]?.headers['x-amz-checksum-sha256']).toBe(expected)
  })

  it("give the store each file's MD5 when the manifest has it, and sign without one", async () => {
    const signing = vi.spyOn(env.deps.blobs, 'presignPut')
    const a = file('index.html', '<h1>hi</h1>')
    const md5 = createHash('md5').update(a.content).digest('base64')
    const b = file('old.html', '<h1>an older client</h1>')
    const { uploads, versionId } = await stageUploads([{ ...a, meta: { ...a.meta, md5 } }, b])
    const given = new Map(signing.mock.calls.map(([key, opts]) => [key.split('/').at(-1), opts]))
    expect(given.get('index.html')).toMatchObject({ sha256: a.meta.sha256, md5 })
    expect(given.get('old.html')).not.toHaveProperty('md5')
    await upload(env, uploads, [a, b])
    expect((await publish(env.deps, user, 'hello', versionId)).status).toBe('live')
    await expect(
      stage(env.deps, user, 'other', body([{ ...a, meta: { ...a.meta, md5: 'nope' } }]), principal)
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('a live version cannot be overwritten with different bytes', async () => {
    const f = file('index.html', '<h1>clean</h1>')
    const { uploads, versionId } = await stageUploads([f])
    await upload(env, uploads, [f])
    expect((await publish(env.deps, user, 'hello', versionId)).status).toBe('live')

    const u = uploads[0] as Upload
    const swap = await put(u, `<p>${FAKE_AWS_KEY}</p>`)
    expect(swap.status).toBe(403)
    expect(await stored(versionId, 'index.html')).toBe('<h1>clean</h1>')
  })

  it('different bytes, or no checksum header, are refused before publish too', async () => {
    const f = file('index.html', '<h1>clean</h1>')
    const { uploads } = await stageUploads([f])
    const u = uploads[0] as Upload
    expect((await put(u, '<h1>other</h1>')).status).toBe(403)
    const { 'x-amz-checksum-sha256': _, ...noChecksum } = u.headers
    expect((await put(u, '<h1>clean</h1>', noChecksum)).status).toBe(403)
  })

  it('the same bytes again are fine (client retries)', async () => {
    const f = file('index.html', '<h1>clean</h1>')
    const { uploads } = await stageUploads([f])
    const u = uploads[0] as Upload
    expect((await put(u, f.content)).status).toBe(200)
    expect((await put(u, f.content)).status).toBe(200)
  })

  it(`expire after ${UPLOAD_URL_TTL_SECONDS / 60} minutes`, async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const blobs = new FsBlobs(env.root, APP_ORIGIN, 'k'.repeat(40), () => now)
    const f = file('index.html', '<h1>clean</h1>')
    const signed = await blobs.presignPut('sites/x/v/index.html', {
      contentType: 'text/html',
      cacheControl: 'no-cache',
      sha256: f.meta.sha256,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    })
    const q = new URL(signed.url).searchParams
    const accept = () =>
      blobs.acceptUpload({
        key: 'sites/x/v/index.html',
        exp: q.get('exp') ?? undefined,
        sig: q.get('sig') ?? undefined,
        contentType: 'text/html',
        cacheControl: 'no-cache',
        checksum: signed.headers['x-amz-checksum-sha256'] ?? '',
        body: new Uint8Array(Buffer.from(f.content)),
      })
    now += (UPLOAD_URL_TTL_SECONDS - 1) * 1000
    expect(await accept()).toBe(true)
    now += 2000
    expect(await accept()).toBe(false)
  })
})

describe('admission', () => {
  it('limits, then paths, then schema', async () => {
    const huge = { ...file('big.html', 'x').meta, size: MAX_FILE_BYTES + 1 }
    const dot = file('.env', 'A=1').meta
    const bad = { ...file('index.html', 'x').meta, sha256: 'nope' }

    await expect(
      stage(env.deps, user, 'hello', { manifest: { files: [huge, dot, bad] } }, principal)
    ).rejects.toMatchObject({ status: 413, code: 'too_large' })
    await expect(
      stage(env.deps, user, 'hello', { manifest: { files: [dot, bad] } }, principal)
    ).rejects.toMatchObject({ status: 400, code: 'dotfile' })
    await expect(
      stage(env.deps, user, 'hello', { manifest: { files: [bad] } }, principal)
    ).rejects.toMatchObject({ name: 'ZodError' })
    expect(await env.store.findSite('hello')).toBeNull()
  })

  it('applies to publishBytes as well', async () => {
    await expect(
      publishBytes(env.deps, user, 'hello', [{ path: 'secrets.json', bytes: new Uint8Array(1) }], {
        principal,
      })
    ).rejects.toMatchObject({ status: 400, code: 'secret_file' })
    expect(await env.store.findSite('hello')).toBeNull()
  })
})

describe('a store bound by MD5', () => {
  // As an MD5-bound store (S3Blobs with digest: 'md5') answers: the upload URL checks no SHA-256.
  const md5Bound = () => {
    Object.defineProperty(env.blobs, 'uploadDigest', { value: 'md5' })
  }

  it('publishes uploads whose SHA-256 is the manifest’s', async () => {
    md5Bound()
    const files = [file('index.html', '<h1>hi</h1>'), file('app.bin', 'binary', 'application/x')]
    const { uploads, versionId } = await stageUploads(files)
    await upload(env, uploads, files)
    await expect(publish(env.deps, user, 'hello', versionId)).resolves.toMatchObject({
      status: 'live',
    })
  })

  it('refuses bytes that are not the manifest’s, every file read, and keeps nothing', async () => {
    md5Bound()
    const files = [file('index.html', '<h1>hi</h1>'), file('app.bin', 'binary', 'application/x')]
    const { uploads, versionId } = await stageUploads(files)
    await upload(env, uploads, files)
    const site = await env.store.findSite('hello')
    // Other bytes of the same size, as an MD5 the client chose would let through.
    await env.blobs.put(
      stagedObjectKey(site?.id as string, versionId, 'app.bin'),
      Buffer.from('BINARY')
    )
    await expect(publish(env.deps, user, 'hello', versionId)).rejects.toMatchObject({
      status: 409,
      code: 'upload_mismatch',
      extra: { mismatched: ['app.bin'] },
    })
    expect(await stored(versionId, 'index.html')).toBeNull()
    expect(await env.blobs.head(stagedObjectKey(site?.id as string, versionId, 'index.html'))).toBe(
      null
    )
    expect((await env.store.findSite('hello'))?.currentVersionId).toBeNull()
  })

  it('never presigns a version key, and serves the checked bytes whatever is PUT after', async () => {
    md5Bound()
    const files = [file('index.html', '<h1>checked</h1>')]
    const { uploads, versionId } = await stageUploads(files)
    const site = await env.store.findSite('hello')
    const id = site?.id as string
    const [u] = uploads as Upload[]
    expect(u?.url).toContain(`/_staged/${versionId}/`)
    expect(u?.url).not.toContain(siteObjectKey(id, versionId, 'index.html'))
    await upload(env, uploads, files)
    await publish(env.deps, user, 'hello', versionId)
    expect(await stored(versionId, 'index.html')).toBe('<h1>checked</h1>')
    expect(await env.blobs.head(stagedObjectKey(id, versionId, 'index.html'))).toBeNull()
    // A colliding body PUT to the still-valid URL afterwards lands at the staging key only.
    await env.blobs.put(
      stagedObjectKey(id, versionId, 'index.html'),
      Buffer.from('<h1>collide</h1>')
    )
    expect(await stored(versionId, 'index.html')).toBe('<h1>checked</h1>')
    // Finalizing again changes nothing (maintenance deletes the leftover with the version).
    await expect(publish(env.deps, user, 'hello', versionId)).resolves.toMatchObject({
      status: 'live',
    })
    expect(await stored(versionId, 'index.html')).toBe('<h1>checked</h1>')
  })

  it('scans the staged bytes and keeps nothing when they hold a secret', async () => {
    md5Bound()
    const files = [file('a.js', `k="${FAKE_AWS_KEY}"`, 'text/javascript')]
    const { uploads, versionId } = await stageUploads(files)
    await upload(env, uploads, files)
    await expect(publish(env.deps, user, 'hello', versionId)).rejects.toMatchObject({
      status: 422,
      code: 'secret_detected',
    })
    const id = (await env.store.findSite('hello'))?.id as string
    expect(await env.blobs.head(stagedObjectKey(id, versionId, 'a.js'))).toBeNull()
    expect(await stored(versionId, 'a.js')).toBeNull()
  })
})

describe('scanning', () => {
  it('publish reads back and refuses a secret; nothing is left behind', async () => {
    const files = [file('index.html', 'ok'), file('a.js', `k="${FAKE_AWS_KEY}"`, 'text/javascript')]
    const { uploads, versionId } = await stageUploads(files)
    await upload(env, uploads, files)
    await expect(publish(env.deps, user, 'hello', versionId)).rejects.toMatchObject({
      status: 422,
      code: 'secret_detected',
    })
    expect(await stored(versionId, 'index.html')).toBeNull()
    const site = await env.store.findSite('hello')
    expect(site?.currentVersionId).toBeNull()
    // Regression: the manifest is one object, deleted as such (a `deletePrefix` on its key threw
    // on S3 and turned the 422 into a 500).
    expect(await env.blobs.getJson(manifestKey(site?.id as string, versionId))).toBeNull()
  })

  it('text files above the old 5 MB cap are scanned', async () => {
    const big = file('data.txt', `${'a'.repeat(6 * 1024 * 1024)}\n${FAKE_AWS_KEY}\n`, 'text/plain')
    const { uploads, versionId } = await stageUploads([big])
    await upload(env, uploads, [big])
    await expect(publish(env.deps, user, 'hello', versionId)).rejects.toMatchObject({
      code: 'secret_detected',
    })
  })

  it('publishBytes scans before writing anything', async () => {
    const bytes = new Uint8Array(Buffer.from(`<p>${FAKE_AWS_KEY}</p>`))
    await expect(
      publishBytes(env.deps, user, 'hello', [{ path: 'index.html', bytes }], { principal })
    ).rejects.toMatchObject({ status: 422, code: 'secret_detected' })
    expect(await env.store.findSite('hello')).toBeNull()
  })

  it('publishBytes goes live, and the same bytes again are unchanged', async () => {
    const files = [{ path: 'index.html', bytes: new Uint8Array(Buffer.from('<h1>hi</h1>')) }]
    const first = await publishBytes(env.deps, user, 'hello', files, { principal })
    expect(first.status).toBe('live')
    expect(await stored(first.versionId, 'index.html')).toBe('<h1>hi</h1>')
    expect((await publishBytes(env.deps, user, 'hello', files, { principal })).status).toBe(
      'unchanged'
    )
  })
})
