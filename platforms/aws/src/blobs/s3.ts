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
import type { Blobs, PresignedPut } from '@fling/api/blobs'

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

export class S3Blobs implements Blobs {
  constructor(
    private bucket: string,
    private client = new S3Client(S3_CLIENT_CONFIG)
  ) {}

  async presignPut(
    key: string,
    opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
  ): Promise<PresignedPut> {
    const checksum = Buffer.from(opts.sha256, 'hex').toString('base64')
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: opts.expiresIn ?? 900,
        // Kept as a signed header (not hoisted into the query) so S3 checks the body against it:
        // a different body → 400 BadDigest; leaving the header off → 403 signature mismatch.
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        signableHeaders: new Set(['content-type', 'cache-control', 'x-amz-checksum-sha256']),
      }
    )
    return {
      url,
      headers: {
        'content-type': opts.contentType,
        'cache-control': opts.cacheControl,
        'x-amz-checksum-sha256': checksum,
      },
    }
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
