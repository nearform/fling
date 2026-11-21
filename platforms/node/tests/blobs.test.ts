/** The Node host's choice of object store (src/blobs.ts). The stores' behaviour is conformance's. */
import { FsBlobs } from '@fling/api/blobs/fs'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { S3Blobs } from '@fling/platform-s3/blobs'
import { describe, expect, it } from 'vitest'
import { nodeBlobs, storageDriver } from '../src/blobs.ts'

const env = { SESSION_SECRET: 's'.repeat(40), SITE_HMAC_KEY: 'h'.repeat(40) }
const config: Config = { ...loadBaseConfig(env), secrets: secretsFromEnv(env) }
const s3 = {
  STORAGE_DRIVER: 's3',
  SITES_BUCKET: 'sites',
  S3_ENDPOINT: 'http://minio:9000',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
}

describe('the Node host’s object store', () => {
  it('is the filesystem unless STORAGE_DRIVER names s3, and refuses any other', () => {
    expect(storageDriver({})).toBe('fs')
    expect(nodeBlobs(config, {}, '/tmp/fling').blobs).toBeInstanceOf(FsBlobs)
    expect(() => storageDriver({ STORAGE_DRIVER: 'r2' })).toThrow(/fs or s3/)
  })

  it('serves the upload routes beside a store bound by MD5', async () => {
    const { blobs, uploads } = nodeBlobs(config, s3, '/tmp/fling')
    expect(blobs).toBeInstanceOf(S3Blobs)
    expect(blobs.uploadDigest).toBe('md5')
    const put = await blobs.presignPut('k', {
      contentType: 'text/plain',
      cacheControl: 'no-cache',
      sha256: 'a'.repeat(64),
    })
    expect(put.url.startsWith(`${config.appOrigin}/blob-upload/`)).toBe(true)
    expect(uploads?.owns(new URL(put.url).pathname)).toBe(true)
  })

  it('needs no upload routes beside a store bound by SHA-256', () => {
    expect(nodeBlobs(config, { ...s3, S3_UPLOAD_DIGEST: 'sha256' }, '/tmp/fling').uploads).toBe(
      undefined
    )
  })
})
