/** R2Blobs' upload route beyond the conformance suite: what each refusal answers. */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { R2Blobs } from '../src/blobs/r2.ts'
import { type Local, local } from './miniflare.ts'

let cf: Local
beforeAll(async () => {
  cf = await local()
}, 60_000)
afterAll(() => cf?.mf.dispose())

const body = new TextEncoder().encode('<!doctype html><title>hi</title>')
const opts = {
  contentType: 'text/html',
  cacheControl: 'no-cache',
  sha256: createHash('sha256').update(body).digest('hex'),
}

const send = async (url: string, init: RequestInit) =>
  (await cf.mf.dispatchFetch(url, init as never)) as unknown as Response

it('stores a signed upload with its headers, streamed with a Content-Length', async () => {
  const blobs = new R2Blobs(cf.bucket, { secret: cf.uploadSecret, baseUrl: 'https://app.test' })
  const key = `r2/${crypto.randomUUID()}/index.html`
  const signed = await blobs.presignPut(key, opts)
  expect(signed.url).toMatch(/^https:\/\/app\.test\/blob-upload\/r2\//)
  const res = await send(signed.url, {
    method: 'PUT',
    headers: { ...signed.headers, 'content-length': String(body.length) },
    body,
  })
  expect(res.status).toBe(200)
  const object = await cf.bucket.get(key)
  expect(object?.httpMetadata).toMatchObject({ contentType: 'text/html', cacheControl: 'no-cache' })
})

it('answers 400 for other bytes, 403 for a bad or expired signature, 404 off the route', async () => {
  let now = Date.now()
  const blobs = new R2Blobs(cf.bucket, {
    secret: cf.uploadSecret,
    baseUrl: 'https://app.test',
    now: () => now,
  })
  const key = `r2/${crypto.randomUUID()}/index.html`
  const signed = await blobs.presignPut(key, { ...opts, expiresIn: 60 })
  const put = (url: string, b: Uint8Array = body) =>
    send(url, { method: 'PUT', headers: signed.headers, body: b as BodyInit })
  expect((await put(signed.url, new TextEncoder().encode('evil'))).status).toBe(400)
  expect((await put(signed.url.replace('sig=', 'sig=x'))).status).toBe(403)
  expect((await put(signed.url.replace('/blob-upload/', '/elsewhere/'))).status).toBe(404)
  expect(await cf.bucket.head(key)).toBeNull()
  // The worker checks expiry against its own clock, so sign one that has already expired.
  now -= 120_000
  const expired = await blobs.presignPut(key, { ...opts, expiresIn: 60 })
  expect((await put(expired.url)).status).toBe(403)
  expect(await cf.bucket.head(key)).toBeNull()
})
