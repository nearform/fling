/**
 * The zips site servers' revisions are built from, in their own versioned bucket (Terraform's
 * server zip bucket): one per version, `<siteId>/<versionId>.zip`. A revision names the object
 * version it was made from, and Lambda reads it again whenever it starts an environment, so an
 * object version is deleted only with the revisions made from it (retire, the sweep): deleting it
 * sooner fails the revision for good. The bucket has no noncurrent-version expiry for the same
 * reason.
 */
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export interface ServerZips {
  readonly bucket: string
  /** The current object version at `key`; null when there is none. */
  find(key: string): Promise<string | null>
  /** Store a zip; its object version. */
  put(key: string, body: Uint8Array): Promise<string>
  /** Every object version (and delete marker) under `prefix`, gone. */
  deletePrefix(prefix: string): Promise<void>
}

export const zipKey = (siteId: string, versionId: string) => `${siteId}/${versionId}.zip`

export class S3ServerZips implements ServerZips {
  constructor(
    readonly bucket: string,
    private readonly client = new S3Client({})
  ) {}

  async find(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return res.VersionId ?? null
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404 || (err as Error).name === 'NotFound') return null
      throw err
    }
  }

  async put(key: string, body: Uint8Array) {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/zip',
      })
    )
    if (!res.VersionId) throw new Error(`The bucket ${this.bucket} has no versioning`)
    return res.VersionId
  }

  async deletePrefix(prefix: string) {
    let KeyMarker: string | undefined
    let VersionIdMarker: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker,
          VersionIdMarker,
        })
      )
      const objects = [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])]
        .filter(v => v.Key)
        .map(v => ({ Key: v.Key as string, VersionId: v.VersionId }))
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } })
        )
      }
      KeyMarker = res.IsTruncated ? res.NextKeyMarker : undefined
      VersionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined
    } while (KeyMarker)
  }
}
