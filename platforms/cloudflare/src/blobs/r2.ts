/**
 * R2 Blobs over the Worker's R2 binding. R2 could presign S3-style URLs, but only with S3 API keys,
 * which a Worker otherwise never needs; so presigned PUTs point at the Worker's own
 * `PUT /blob-upload/<key>?exp=&sig=` route instead (the scheme in @fling/api/blobs/signed-upload,
 * the same one FsBlobs uses in dev). `handleUpload` is that route: it verifies the signature, then
 * streams the body into R2 with the signed SHA-256, which R2 checks before it stores anything.
 */
import type { R2Bucket, R2ObjectBody } from '@cloudflare/workers-types'
import type { Blobs, PresignedPut } from '@fling/api/blobs'
import { signUpload, uploadKeyFromPath, verifyUpload } from '@fling/api/blobs/signed-upload'

/** Where the Worker mounts `handleUpload`. */
export const UPLOAD_ROUTE = '/blob-upload'

/** Objects up to this size are copied through memory; larger ones stream. */
const BUFFER_COPY_BYTES = 1024 * 1024

type FixedLengthStreamClass = new (
  length: number
) => { readable: R2Readable; writable: Parameters<R2Readable['pipeTo']>[0] }
type R2Readable = R2ObjectBody['body']

/** R2's cap on keys per `delete` and objects per `list` page. */
const PAGE = 1000

const forbidden = (message: string, status = 403) =>
  Response.json(
    { error: { code: status === 403 ? 'forbidden' : 'bad_request', message } },
    { status }
  )

export class R2Blobs implements Blobs {
  constructor(
    private bucket: R2Bucket,
    private signer: {
      /** HMAC key for upload URLs (the session secret) */
      secret: string
      /** the origin the Worker serves `UPLOAD_ROUTE` on (the app origin) */
      baseUrl: string
      now?: () => number
    }
  ) {}

  async presignPut(
    key: string,
    opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
  ): Promise<PresignedPut> {
    return signUpload({ ...this.signer, route: UPLOAD_ROUTE }, key, opts)
  }

  /** The upload route: `PUT <UPLOAD_ROUTE>/<key>?exp=&sig=` from a `presignPut` URL. */
  async handleUpload(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = uploadKeyFromPath(url.pathname, UPLOAD_ROUTE)
    if (request.method !== 'PUT' || key === null) return forbidden('Not an upload', 404)
    const signed = {
      key,
      exp: url.searchParams.get('exp') ?? undefined,
      sig: url.searchParams.get('sig') ?? undefined,
      contentType: request.headers.get('content-type') ?? '',
      cacheControl: request.headers.get('cache-control') ?? '',
      checksum: request.headers.get('x-amz-checksum-sha256') ?? '',
    }
    if (!verifyUpload(this.signer, signed)) return forbidden('Bad signature')
    const sha256 = Buffer.from(signed.checksum, 'base64')
    if (sha256.length !== 32) return forbidden('Bad checksum', 400)
    // R2 needs the body's length up front to stream it; without Content-Length, buffer it.
    const body = request.headers.has('content-length')
      ? (request.body ?? new Uint8Array())
      : new Uint8Array(await request.arrayBuffer())
    try {
      // (DOM and workers-types each declare their own ReadableStream.)
      await this.bucket.put(key, body as unknown as Parameters<R2Bucket['put']>[1], {
        sha256: sha256.toString('hex'),
        httpMetadata: { contentType: signed.contentType, cacheControl: signed.cacheControl },
      })
    } catch (err) {
      // R2 refuses a body whose SHA-256 is not the one given (and stores nothing).
      if (err instanceof Error && /sha-?256|checksum|digest/i.test(err.message)) {
        return forbidden('Body does not match the signed checksum', 400)
      }
      throw err
    }
    return new Response(null, { status: 200 })
  }

  async head(key: string) {
    const object = await this.bucket.head(key)
    return object ? { size: object.size } : null
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string; cacheControl?: string } = {}
  ) {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: opts.contentType, cacheControl: opts.cacheControl },
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }

  async putJson(key: string, value: unknown) {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value)), {
      contentType: 'application/json',
    })
  }

  async getJson<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(key)
    return object ? ((await object.json()) as T) : null
  }

  /**
   * R2 bindings have no server-side copy: read the object and put it back with its httpMetadata.
   * Small objects are buffered; a large one streams through a FixedLengthStream (R2 only takes
   * streams of known length), so a run of concurrent copies never holds 25 MB files in memory.
   */
  async copy(from: string, to: string) {
    const object = await this.bucket.get(from)
    if (!object) throw new Error(`copy: no object at ${from}`)
    const options = { httpMetadata: object.httpMetadata }
    const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamClass }).FixedLengthStream
    if (object.size <= BUFFER_COPY_BYTES || !Fixed) {
      await this.bucket.put(to, await object.arrayBuffer(), options)
      return
    }
    const sized = new Fixed(object.size)
    await Promise.all([
      object.body.pipeTo(sized.writable),
      this.bucket.put(to, sized.readable, options),
    ])
  }

  async delete(key: string) {
    await this.bucket.delete(key)
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith('/')) throw new Error('deletePrefix needs a `dir/` prefix')
    let cursor: string | undefined
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor, limit: PAGE })
      if (page.objects.length) await this.bucket.delete(page.objects.map(o => o.key))
      if (!page.truncated) return
      cursor = page.cursor
    }
  }
}
