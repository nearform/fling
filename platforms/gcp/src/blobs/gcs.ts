/**
 * Cloud Storage Blobs: the sites bucket (SITES_BUCKET), through the official client.
 *
 * Presigned URLs are V4 signed URLs. Cloud Storage checks an upload's MD5 (or CRC32C), never its
 * SHA-256, so a presigned PUT signs `Content-MD5` with Content-Type and Cache-Control
 * (`uploadDigest = 'md5'`): a client that leaves a signed header off fails the signature, and a body
 * whose MD5 differs is refused with 400 BadDigest. Uploads therefore land on staging keys, and
 * publication copies and checks them (see `Blobs.uploadDigest`). A file whose MD5 the client did
 * not send is signed for the host's upload routes instead (`fallback`, the core's HostUploads).
 *
 * Signing needs no key file: on Cloud Run the client signs through the IAM Credentials API
 * (signBlob) as the service's own service account, which the Terraform module lets sign as itself
 * (platforms/gcp/infra/iam.tf). With a key (tests), it signs offline.
 */
import type { Blobs, PresignedPut, PresignPutOptions } from '@fling/api/blobs'
import { Storage } from '@google-cloud/storage'

const isNotFound = (err: unknown) => (err as { code?: number }).code === 404

export interface GcsBlobsOptions {
  /**
   * Where a file whose MD5 the client did not send is uploaded instead (the core's HostUploads on
   * the platform's host). Without one, such a file can't be presigned.
   */
  fallback?: Pick<Blobs, 'presignPut'>
}

/** The most objects one listing page returns, and so one deletePrefix round. */
const PAGE = 1000
/** Deletes in flight at once. */
const PARALLEL = 32

export class GcsBlobs implements Blobs {
  readonly uploadDigest = 'md5' as const

  constructor(
    private readonly bucketName: string,
    private readonly storage = new Storage(),
    private readonly opts: GcsBlobsOptions = {}
  ) {}

  private file(key: string) {
    return this.storage.bucket(this.bucketName).file(key)
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    if (!opts.md5) {
      if (this.opts.fallback) return this.opts.fallback.presignPut(key, opts)
      throw new Error("This store checks an upload's MD5, and the manifest gave none")
    }
    const [url] = await this.file(key).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + (opts.expiresIn ?? 900) * 1000,
      contentType: opts.contentType,
      contentMd5: opts.md5,
      extensionHeaders: { 'cache-control': opts.cacheControl },
    })
    return {
      url,
      headers: {
        'content-type': opts.contentType,
        'cache-control': opts.cacheControl,
        'content-md5': opts.md5,
      },
    }
  }

  async presignGet(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const [url] = await this.file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + (opts.expiresIn ?? 900) * 1000,
    })
    return url
  }

  async head(key: string) {
    try {
      const [meta] = await this.file(key).getMetadata()
      return { size: Number(meta.size ?? 0) }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string; cacheControl?: string } = {}
  ) {
    await this.file(key).save(Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
      resumable: false,
      contentType: opts.contentType ?? 'application/octet-stream',
      ...(opts.cacheControl ? { metadata: { cacheControl: opts.cacheControl } } : {}),
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const [bytes] = await this.file(key).download()
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async putJson(key: string, value: unknown) {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value)), {
      contentType: 'application/json',
    })
  }

  async getJson<T>(key: string): Promise<T | null> {
    const bytes = await this.get(key)
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null
  }

  /** A rewrite in the bucket, which keeps Content-Type and Cache-Control. */
  async copy(from: string, to: string) {
    await this.file(from).copy(this.file(to))
  }

  async delete(key: string) {
    await this.file(key).delete({ ignoreNotFound: true })
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith('/')) throw new Error('deletePrefix needs a `dir/` prefix')
    const bucket = this.storage.bucket(this.bucketName)
    let pageToken: string | undefined
    do {
      const [files, next] = await bucket.getFiles({
        prefix,
        autoPaginate: false,
        maxResults: PAGE,
        ...(pageToken ? { pageToken } : {}),
      })
      for (let i = 0; i < files.length; i += PARALLEL) {
        await Promise.all(files.slice(i, i + PARALLEL).map(f => f.delete({ ignoreNotFound: true })))
      }
      pageToken = (next as { pageToken?: string } | null)?.pageToken
    } while (pageToken)
  }
}
