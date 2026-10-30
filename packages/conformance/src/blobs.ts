/**
 * Blobs conformance: what the API relies on from the sites bucket. Every test works under its own
 * random prefix, so a shared bucket (MinIO, a real one) needs no cleanup between tests.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Blobs } from '@fling/api/blobs'
import { describe, expect, it } from 'vitest'

export interface BlobsHarness {
  blobs: Blobs
  /** The client's half of a presigned upload (default: global fetch). */
  upload?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * The object's stored Content-Type and Cache-Control, read beside the port, for adapters that
   * keep them (S3, R2). FsBlobs keeps none: its dev server derives the type from the name.
   */
  metadata?: (key: string) => Promise<{ contentType?: string; cacheControl?: string } | null>
}

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export function blobsConformance(
  name: string,
  harness: () => BlobsHarness | Promise<BlobsHarness>
) {
  describe(`Blobs conformance: ${name}`, () => {
    const setup = async () => {
      const h = await harness()
      return { ...h, upload: h.upload ?? fetch, p: `conformance/${randomUUID()}/` }
    }

    it('put, get and head an object; missing objects are null', async () => {
      const { blobs, p } = await setup()
      expect(await blobs.get(`${p}a.txt`)).toBeNull()
      expect(await blobs.head(`${p}a.txt`)).toBeNull()
      await blobs.put(`${p}a.txt`, bytes('hello'), { contentType: 'text/plain' })
      expect(text(await blobs.get(`${p}a.txt`))).toBe('hello')
      expect(await blobs.head(`${p}a.txt`)).toEqual({ size: 5 })
    })

    it('round-trips binary bytes and overwrites in place', async () => {
      const { blobs, p } = await setup()
      const bin = new Uint8Array([0, 137, 80, 78, 71, 255, 10])
      await blobs.put(`${p}dir/sub/x.bin`, bin)
      expect([...((await blobs.get(`${p}dir/sub/x.bin`)) ?? [])]).toEqual([...bin])
      await blobs.put(`${p}dir/sub/x.bin`, bytes('longer content'), { cacheControl: 'no-cache' })
      expect(text(await blobs.get(`${p}dir/sub/x.bin`))).toBe('longer content')
      expect(await blobs.head(`${p}dir/sub/x.bin`)).toEqual({ size: 14 })
    })

    it('putJson and getJson round-trip; missing JSON is null', async () => {
      const { blobs, p } = await setup()
      expect(await blobs.getJson(`${p}m.json`)).toBeNull()
      const value = { files: [{ path: 'index.html', size: 3 }], n: null, ok: true }
      await blobs.putJson(`${p}m.json`, value)
      expect(await blobs.getJson(`${p}m.json`)).toEqual(value)
    })

    it('deletePrefix removes everything under a `dir/` prefix and nothing beside it', async () => {
      const { blobs, p } = await setup()
      await blobs.put(`${p}site/v1/index.html`, bytes('1'))
      await blobs.put(`${p}site/v1/deep/a/b.css`, bytes('2'))
      await blobs.putJson(`${p}site/_manifests/v1.json`, { files: [] })
      await blobs.put(`${p}site-other/v1/index.html`, bytes('3'))
      await blobs.put(`${p}sit/index.html`, bytes('4'))
      await blobs.deletePrefix(`${p}site/`)
      expect(await blobs.head(`${p}site/v1/index.html`)).toBeNull()
      expect(await blobs.head(`${p}site/v1/deep/a/b.css`)).toBeNull()
      expect(await blobs.getJson(`${p}site/_manifests/v1.json`)).toBeNull()
      expect(text(await blobs.get(`${p}site-other/v1/index.html`))).toBe('3')
      expect(text(await blobs.get(`${p}sit/index.html`))).toBe('4')
    })

    it('deletePrefix refuses a prefix that does not end in `/`', async () => {
      const { blobs, p } = await setup()
      await blobs.put(`${p}m.json`, bytes('1'))
      await expect(blobs.deletePrefix(`${p}m.json`)).rejects.toThrow()
      expect(text(await blobs.get(`${p}m.json`))).toBe('1')
    })

    it('delete removes one object and nothing beside it; a missing object is fine', async () => {
      const { blobs, p } = await setup()
      await blobs.putJson(`${p}_manifests/v1.json`, { files: [] })
      await blobs.put(`${p}_manifests/v1.json.bak`, bytes('2'))
      await blobs.put(`${p}_manifests/v10.json`, bytes('3'))
      await blobs.delete(`${p}_manifests/v1.json`)
      expect(await blobs.getJson(`${p}_manifests/v1.json`)).toBeNull()
      expect(text(await blobs.get(`${p}_manifests/v1.json.bak`))).toBe('2')
      expect(text(await blobs.get(`${p}_manifests/v10.json`))).toBe('3')
      await expect(blobs.delete(`${p}_manifests/v1.json`)).resolves.toBeUndefined()
      await expect(blobs.delete(`${p}never/was.txt`)).resolves.toBeUndefined()
    })

    it('copy duplicates an object with its metadata and leaves the source', async () => {
      const { blobs, metadata, p } = await setup()
      const bin = new Uint8Array([0, 137, 80, 78, 71, 255, 10])
      const meta = { contentType: 'image/png', cacheControl: 'public, max-age=300' }
      await blobs.put(`${p}v1/img/a b.png`, bin, meta)
      await blobs.copy(`${p}v1/img/a b.png`, `${p}v2/img/a b.png`)
      expect([...((await blobs.get(`${p}v2/img/a b.png`)) ?? [])]).toEqual([...bin])
      expect(await blobs.head(`${p}v2/img/a b.png`)).toEqual({ size: bin.length })
      expect([...((await blobs.get(`${p}v1/img/a b.png`)) ?? [])]).toEqual([...bin])
      if (metadata) expect(await metadata(`${p}v2/img/a b.png`)).toMatchObject(meta)
    })

    it('copy overwrites the destination and refuses a missing source', async () => {
      const { blobs, p } = await setup()
      await blobs.put(`${p}from.txt`, bytes('new'))
      await blobs.put(`${p}to.txt`, bytes('old and longer'))
      await blobs.copy(`${p}from.txt`, `${p}to.txt`)
      expect(text(await blobs.get(`${p}to.txt`))).toBe('new')
      await expect(blobs.copy(`${p}never/was.txt`, `${p}x.txt`)).rejects.toThrow()
      expect(await blobs.head(`${p}x.txt`)).toBeNull()
    })

    it('deletePrefix on a prefix with nothing under it is a no-op', async () => {
      const { blobs, p } = await setup()
      await expect(blobs.deletePrefix(`${p}nothing-here/`)).resolves.toBeUndefined()
    })

    it('deletePrefix handles more objects than one listing page', async () => {
      const { blobs, p } = await setup()
      const keys = Array.from({ length: 1005 }, (_, i) => `${p}many/${String(i).padStart(4, '0')}`)
      for (let i = 0; i < keys.length; i += 50) {
        await Promise.all(keys.slice(i, i + 50).map(k => blobs.put(k, bytes('x'))))
      }
      await blobs.deletePrefix(`${p}many/`)
      expect(await blobs.head(keys[0] as string)).toBeNull()
      expect(await blobs.head(keys[keys.length - 1] as string)).toBeNull()
    }, 120_000)

    describe('presigned uploads', () => {
      const body = bytes('<!doctype html><title>hi</title>')
      const opts = {
        contentType: 'text/html; charset=utf-8',
        cacheControl: 'public, max-age=300',
        sha256: sha256(body),
      }

      it('accept exactly the bytes they were signed for, with the headers they return', async () => {
        const { blobs, upload, p } = await setup()
        const signed = await blobs.presignPut(`${p}up/index.html`, opts)
        expect(signed.headers).toMatchObject({
          'content-type': opts.contentType,
          'cache-control': opts.cacheControl,
        })
        const res = await upload(signed.url, { method: 'PUT', headers: signed.headers, body })
        expect(res.ok).toBe(true)
        expect(await blobs.head(`${p}up/index.html`)).toEqual({ size: body.length })
        expect(text(await blobs.get(`${p}up/index.html`))).toBe(text(body))
      })

      it('reject any other body', async () => {
        const { blobs, upload, p } = await setup()
        const signed = await blobs.presignPut(`${p}up/index.html`, opts)
        const res = await upload(signed.url, {
          method: 'PUT',
          headers: signed.headers,
          body: bytes('<!doctype html><title>evil</title>'),
        })
        expect(res.ok).toBe(false)
        expect(await blobs.head(`${p}up/index.html`)).toBeNull()
      })

      it('reject an upload without the checksum header', async () => {
        const { blobs, upload, p } = await setup()
        const signed = await blobs.presignPut(`${p}up/index.html`, opts)
        const headers = Object.fromEntries(
          Object.entries(signed.headers).filter(([k]) => k !== 'x-amz-checksum-sha256')
        )
        const res = await upload(signed.url, { method: 'PUT', headers, body })
        expect(res.ok).toBe(false)
        expect(await blobs.head(`${p}up/index.html`)).toBeNull()
      })

      it('reject a different Content-Type than the one signed', async () => {
        const { blobs, upload, p } = await setup()
        const signed = await blobs.presignPut(`${p}up/index.html`, opts)
        const res = await upload(signed.url, {
          method: 'PUT',
          headers: { ...signed.headers, 'content-type': 'application/javascript' },
          body,
        })
        expect(res.ok).toBe(false)
        expect(await blobs.head(`${p}up/index.html`)).toBeNull()
      })

      it('are bound to their key', async () => {
        const { blobs, upload, p } = await setup()
        const signed = await blobs.presignPut(`${p}up/index.html`, opts)
        const res = await upload(signed.url.replace('/up/index.html', '/up/other.html'), {
          method: 'PUT',
          headers: signed.headers,
          body,
        })
        expect(res.ok).toBe(false)
        expect(await blobs.head(`${p}up/other.html`)).toBeNull()
      })
    })
  })
}
