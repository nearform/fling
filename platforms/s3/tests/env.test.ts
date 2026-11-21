import { describe, expect, it } from 'vitest'
import { s3FromEnv, s3Settings } from '../src/env.ts'

const sha256 = 'a'.repeat(64)
const md5 = Buffer.alloc(16, 1).toString('base64')
const file = { contentType: 'text/html', cacheControl: 'no-cache', sha256, md5 }

describe('s3Settings', () => {
  it('needs a bucket', () => {
    expect(() => s3Settings({})).toThrow(/SITES_BUCKET/)
  })

  it('binds the MD5 on an S3-compatible endpoint and the SHA-256 on AWS S3, unless told', () => {
    expect(s3Settings({ SITES_BUCKET: 'b', S3_ENDPOINT: 'http://minio:9000' }).digest).toBe('md5')
    expect(s3Settings({ SITES_BUCKET: 'b' }).digest).toBe('sha256')
    expect(
      s3Settings({
        SITES_BUCKET: 'b',
        S3_ENDPOINT: 'http://minio:9000',
        S3_UPLOAD_DIGEST: 'sha256',
      }).digest
    ).toBe('sha256')
  })

  it('refuses what it cannot use, naming the variable', () => {
    expect(() => s3Settings({ SITES_BUCKET: 'b', S3_ENDPOINT: 'minio:9000' })).toThrow(
      /S3_ENDPOINT/
    )
    expect(() => s3Settings({ SITES_BUCKET: 'b', S3_UPLOAD_DIGEST: 'crc32' })).toThrow(
      /S3_UPLOAD_DIGEST/
    )
    expect(() => s3Settings({ SITES_BUCKET: 'b', S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(
      /S3_FORCE_PATH_STYLE/
    )
    expect(() => s3Settings({ SITES_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toThrow(
      /S3_SECRET_ACCESS_KEY/
    )
  })

  it('takes the region from S3_REGION, then AWS_REGION', () => {
    expect(s3Settings({ SITES_BUCKET: 'b', S3_REGION: 'nyc3', AWS_REGION: 'x' }).region).toBe(
      'nyc3'
    )
    expect(s3Settings({ SITES_BUCKET: 'b', AWS_REGION: 'eu-west-1' }).region).toBe('eu-west-1')
  })
})

describe('s3FromEnv', () => {
  const env = {
    SITES_BUCKET: 'sites',
    S3_ENDPOINT: 'http://minio:9000',
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret-key',
  }

  it('presigns URLs that name the public endpoint, when there is one', async () => {
    const blobs = s3FromEnv({ ...env, S3_PUBLIC_ENDPOINT: 'https://storage.example.test' })
    const put = await blobs.presignPut('sites/x/v/index.html', file)
    expect(put.url.startsWith('https://storage.example.test/sites/sites/x/v/index.html?')).toBe(
      true
    )
    expect(put.headers['content-md5']).toBe(md5)
    const get = await blobs.presignGet('sites/x/v/index.html')
    expect(get.startsWith('https://storage.example.test/sites/')).toBe(true)
  })

  it('presigns on the endpoint itself without one', async () => {
    const put = await s3FromEnv(env).presignPut('k', file)
    expect(put.url.startsWith('http://minio:9000/sites/k?')).toBe(true)
  })

  it('sends a file without an MD5 to the fallback', async () => {
    const fallback = { presignPut: async () => ({ url: 'https://app/blob-upload/k', headers: {} }) }
    const put = await s3FromEnv(env, { fallback }).presignPut('k', { ...file, md5: undefined })
    expect(put.url).toBe('https://app/blob-upload/k')
  })
})
