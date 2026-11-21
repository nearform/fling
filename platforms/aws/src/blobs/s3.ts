import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Blobs, PresignedPut, PresignPutOptions } from '@fling/api/blobs'

// WHEN_REQUIRED: otherwise the SDK signs a CRC32 of the (empty) presign body into the URL.
export const S3_CLIENT_CONFIG = {
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} as const

const isNotFound = (err: unknown) =>
  err instanceof Error &&
  (err.name === 'NotFound' ||
    err.name === 'NoSuchKey' ||
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)

/**
 * Which digest a presigned PUT binds: `sha256` (S3: `x-amz-checksum-sha256`) or `md5`
 * (`Content-MD5`, which every S3-compatible store checks: MinIO, DigitalOcean Spaces, Tigris).
 * Either is a signed header, so a client that leaves it off fails the signature, and the store
 * refuses a body that doesn't match it.
 */
export type S3Digest = 'sha256' | 'md5'

export interface S3BlobsOptions {
  /** default `sha256` */
  digest?: S3Digest
  /**
   * With `md5`: where a file whose MD5 the client did not send is uploaded instead (the core's
   * HostUploads on the platform's host). Without one, such a file can't be presigned.
   */
  fallback?: Pick<Blobs, 'presignPut'>
}

export class S3Blobs implements Blobs {
  constructor(
    private bucket: string,
    private client = new S3Client(S3_CLIENT_CONFIG),
    private opts: S3BlobsOptions = {}
  ) {}

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    const md5 = this.opts.digest === 'md5'
    if (md5 && !opts.md5) {
      if (this.opts.fallback) return this.opts.fallback.presignPut(key, opts)
      throw new Error("This store checks an upload's MD5, and the manifest gave none")
    }
    const digest = md5
      ? { header: 'content-md5', value: opts.md5 as string }
      : {
          header: 'x-amz-checksum-sha256',
          value: Buffer.from(opts.sha256, 'hex').toString('base64'),
        }
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        ...(md5 ? { ContentMD5: digest.value } : { ChecksumSHA256: digest.value }),
      }),
      {
        expiresIn: opts.expiresIn ?? 900,
        // Kept as a signed header (not hoisted into the query) so the store checks the body
        // against it: a different body → 400 BadDigest; leaving the header off → 403 signature
        // mismatch.
        unhoistableHeaders: new Set([digest.header]),
        signableHeaders: new Set(['content-type', 'cache-control', digest.header]),
      }
    )
    return {
      url,
      headers: {
        'content-type': opts.contentType,
        'cache-control': opts.cacheControl,
        [digest.header]: digest.value,
      },
    }
  }

  async presignGet(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: opts.expiresIn ?? 900,
    })
  }

  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { size: res.ContentLength ?? 0 }
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
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
      })
    )
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return (await res.Body?.transformToByteArray()) ?? null
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async putJson(key: string, value: unknown) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
      })
    )
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      const text = await res.Body?.transformToString()
      return text ? (JSON.parse(text) as T) : null
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /** CopyObject (up to 5 GB, far above MAX_FILE_BYTES); COPY keeps Content-Type and Cache-Control. */
  async copy(from: string, to: string) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        CopySource: `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'COPY',
      })
    )
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith('/')) throw new Error('deletePrefix needs a `dir/` prefix')
    let token: string | undefined
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      const objects = (list.Contents ?? []).flatMap(o => (o.Key ? [{ Key: o.Key }] : []))
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          })
        )
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (token)
  }
}
