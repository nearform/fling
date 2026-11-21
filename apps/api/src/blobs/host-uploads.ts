/**
 * Uploads and downloads through the host, over any Blobs: what a platform serves when its store
 * can't bind a presigned URL to the bytes it was signed for. The URLs are the core's signed routes
 * (signed-url.ts), `PUT <baseUrl>/blob-upload/<key>?exp=&sig=` and
 * `GET <baseUrl>/blob-download/<key>?exp=&sig=`, on the platform's own host:
 *
 * - `handle` verifies the signature (key, expiry, Content-Type, Cache-Control and the SHA-256 the
 *   client sends as `x-amz-checksum-sha256`), reads the body up to MAX_FILE_BYTES, checks its
 *   SHA-256 itself, and only then writes it with `Blobs.put`. A download streams nothing it was not
 *   signed for.
 * - A store adapter that checks only an MD5 uses `presignPut` here for a file whose MD5 the client
 *   did not send (an older CLI), so every client keeps deploying on every store. The bytes then
 *   pass through the host, so its request-size limit applies.
 *
 * The Node host (platforms/node) mounts `handle` on the app host; the Cloudflare Worker serves the
 * same routes with R2's own checks (R2Blobs).
 */
import { createHash } from 'node:crypto'
import { MAX_FILE_BYTES } from '@fling/shared'
import {
  keyFromPath,
  signDownload,
  signUpload,
  verifyDownload,
  verifyUpload,
} from './signed-url.ts'
import type { Blobs, PresignedPut, PresignPutOptions } from './types.ts'

/** Where a host mounts the routes (the Worker's R2 routes have the same paths). */
export const HOST_UPLOAD_ROUTE = '/blob-upload'
export const HOST_DOWNLOAD_ROUTE = '/blob-download'

export interface HostUploadsOptions {
  /** HMAC key for the URLs (the session secret) */
  secret: string
  /** the origin the host serves the routes on (the app origin) */
  baseUrl: string
  now?: () => number
}

const refuse = (status: number, message: string) =>
  Response.json(
    { error: { code: status === 403 ? 'forbidden' : 'bad_request', message } },
    { status, headers: { 'cache-control': 'no-store' } }
  )

/** The body, or null once it passes `max` bytes (read no further). */
async function bodyUpTo(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (declared > max) return null
  if (!request.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks, size))
}

export class HostUploads {
  constructor(
    private blobs: Pick<Blobs, 'put' | 'get'>,
    private signer: HostUploadsOptions
  ) {}

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    return signUpload({ ...this.signer, route: HOST_UPLOAD_ROUTE }, key, opts)
  }

  async presignGet(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    return signDownload({ ...this.signer, route: HOST_DOWNLOAD_ROUTE }, key, opts)
  }

  /** Whether `path` is one of the routes (the host's request goes to `handle`). */
  owns(path: string): boolean {
    return path.startsWith(`${HOST_UPLOAD_ROUTE}/`) || path.startsWith(`${HOST_DOWNLOAD_ROUTE}/`)
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const exp = url.searchParams.get('exp') ?? undefined
    const sig = url.searchParams.get('sig') ?? undefined
    const download = keyFromPath(url.pathname, HOST_DOWNLOAD_ROUTE)
    if (download !== null && request.method === 'GET') {
      if (!verifyDownload(this.signer, { key: download, exp, sig })) {
        return refuse(403, 'Bad signature')
      }
      const object = await this.blobs.get(download)
      if (!object) return refuse(404, 'No such object')
      return new Response(object as Uint8Array<ArrayBuffer>, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(object.byteLength),
          'cache-control': 'private, no-store',
        },
      })
    }
    const key = keyFromPath(url.pathname, HOST_UPLOAD_ROUTE)
    if (key === null || request.method !== 'PUT') return refuse(404, 'Not an upload')
    const signed = {
      key,
      exp,
      sig,
      contentType: request.headers.get('content-type') ?? '',
      cacheControl: request.headers.get('cache-control') ?? '',
      checksum: request.headers.get('x-amz-checksum-sha256') ?? '',
    }
    if (!verifyUpload(this.signer, signed)) return refuse(403, 'Bad signature')
    const body = await bodyUpTo(request, MAX_FILE_BYTES)
    if (!body) return refuse(413, 'Too large')
    if (createHash('sha256').update(body).digest('base64') !== signed.checksum) {
      return refuse(400, 'Body does not match the signed checksum')
    }
    await this.blobs.put(key, body, {
      contentType: signed.contentType,
      cacheControl: signed.cacheControl,
    })
    return new Response(null, { status: 200 })
  }
}
