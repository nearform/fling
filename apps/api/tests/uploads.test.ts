/**
 * The core's signed upload routes read no more than they must: FsBlobs' route (the Node host's
 * store in production) checks the signature before it reads a byte and refuses a body over a
 * file's limit, as HostUploads does; HostUploads' downloads are never rendered on the app origin.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { FsBlobs } from '../src/blobs/fs.ts'
import { HostUploads } from '../src/blobs/host-uploads.ts'
import { APP_ORIGIN, setup } from './helpers.ts'

/** A body of `size` bytes that counts how much of it was read. */
function counted(size: number) {
  let read = 0
  const chunk = new Uint8Array(1024 * 1024)
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (read >= size) return controller.close()
      read += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return { body, read: () => read }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe("FsBlobs' upload route", () => {
  it('refuses a bad signature without reading the body', async () => {
    const env = setup()
    const big = counted(64 * 1024 * 1024)
    const res = await env.app.request(`${APP_ORIGIN}/dev-upload/sites/S/V/a.bin?exp=1&sig=x`, {
      method: 'PUT',
      body: big.body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(403)
    expect(big.read()).toBeLessThanOrEqual(1024 * 1024)
  })

  it('refuses a signed body over a file’s limit, reading no further than the limit', async () => {
    const env = setup()
    const put = await env.blobs.presignPut('sites/S/V/a.bin', {
      contentType: 'application/octet-stream',
      cacheControl: 'no-cache',
      sha256: sha256(new Uint8Array()),
    })
    const big = counted(MAX_FILE_BYTES + 8 * 1024 * 1024)
    const res = await env.app.request(put.url, {
      method: 'PUT',
      headers: put.headers,
      body: big.body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(big.read()).toBeLessThanOrEqual(MAX_FILE_BYTES + 2 * 1024 * 1024)
    expect(await env.blobs.head('sites/S/V/a.bin')).toBeNull()
  })

  it('takes a signed body whose SHA-256 matches', async () => {
    const env = setup()
    const bytes = new TextEncoder().encode('hello')
    const put = await env.blobs.presignPut('sites/S/V/a.txt', {
      contentType: 'text/plain',
      cacheControl: 'no-cache',
      sha256: sha256(bytes),
    })
    const res = await env.app.request(put.url, { method: 'PUT', headers: put.headers, body: bytes })
    expect(res.status).toBe(200)
    expect(await env.blobs.get('sites/S/V/a.txt')).toEqual(bytes)
  })
})

describe('HostUploads downloads', () => {
  it('are attachments the browser may not sniff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fling-host-uploads-'))
    const blobs = new FsBlobs(root, APP_ORIGIN, 's'.repeat(40))
    const uploads = new HostUploads(blobs, { secret: 's'.repeat(40), baseUrl: APP_ORIGIN })
    await blobs.put('sites/S/V/page.html', new TextEncoder().encode('<script>1</script>'))
    const res = await uploads.handle(new Request(await uploads.presignGet('sites/S/V/page.html')))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })
})
