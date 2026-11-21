/**
 * The Blobs conformance suite against S3Blobs on MinIO, binding the SHA-256 and binding the MD5
 * (with the host's upload routes for a file sent without one), and on S3Blobs made from the
 * environment as the Node host makes it (`s3FromEnv`). Skipped unless MinIO is configured
 * (services.ts).
 */
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { HostUploads } from '@fling/api/blobs/host-uploads'
import { blobsConformance } from '@fling/conformance'
import { beforeAll, describe } from 'vitest'
import { S3Blobs } from '../src/blobs.ts'
import { s3FromEnv } from '../src/env.ts'
import { S3_ACCESS_KEY, S3_ENDPOINT, S3_SECRET_KEY, s3Bucket } from './services.ts'

/** The platform's host, which serves HostUploads' routes. */
const HOST = 'https://app.example.test'

describe.runIf(S3_ENDPOINT)('MinIO', () => {
  let s3: { client: S3Client; bucket: string }
  beforeAll(async () => {
    s3 = await s3Bucket()
  }, 60_000)
  const metadata = async (key: string) => {
    const res = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }))
    return { contentType: res.ContentType, cacheControl: res.CacheControl }
  }
  blobsConformance('S3Blobs', () => ({ blobs: new S3Blobs(s3.bucket, s3.client), metadata }))
  // S3-compatible stores check Content-MD5; a file sent without one goes through the host.
  blobsConformance('S3Blobs binding Content-MD5', () => {
    const host = new HostUploads(new S3Blobs(s3.bucket, s3.client), {
      secret: 'u'.repeat(40),
      baseUrl: HOST,
    })
    return {
      blobs: new S3Blobs(s3.bucket, s3.client, { digest: 'md5', fallback: host }),
      upload: (url, init) =>
        url.startsWith(`${HOST}/`) ? host.handle(new Request(url, init)) : fetch(url, init),
      metadata,
    }
  })
  blobsConformance('S3Blobs from the environment', () => {
    const env = {
      SITES_BUCKET: s3.bucket,
      S3_ENDPOINT,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: S3_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: S3_SECRET_KEY,
    }
    const host = new HostUploads(s3FromEnv(env), { secret: 'u'.repeat(40), baseUrl: HOST })
    return {
      blobs: s3FromEnv(env, { fallback: host }),
      upload: (url, init) =>
        url.startsWith(`${HOST}/`) ? host.handle(new Request(url, init)) : fetch(url, init),
      metadata,
    }
  })
})
