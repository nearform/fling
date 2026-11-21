/**
 * The MinIO the S3Blobs conformance runs against. It runs only when FLING_TEST_S3_ENDPOINT is set
 * (CI sets it, with the service in ci.yml), so `pnpm gate` passes on a laptop without Docker. To
 * run it locally:
 *
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=fling-test \
 *     -e MINIO_ROOT_PASSWORD=fling-test-secret bitnamilegacy/minio
 *   FLING_TEST_S3_ENDPOINT=http://localhost:9000 pnpm --filter @fling/platform-s3 test
 *
 * The bucket is created here, named per run, never in a workflow step.
 */
import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3_CLIENT_CONFIG } from '../src/blobs.ts'

export const S3_ENDPOINT = process.env.FLING_TEST_S3_ENDPOINT
export const S3_ACCESS_KEY = process.env.FLING_TEST_S3_ACCESS_KEY ?? 'fling-test'
export const S3_SECRET_KEY = process.env.FLING_TEST_S3_SECRET_KEY ?? 'fling-test-secret'

const run = randomUUID().slice(0, 8)
let buckets = 0

/** A MinIO client (same checksum settings as production) and a fresh bucket. */
export async function s3Bucket() {
  const client = new S3Client({
    ...S3_CLIENT_CONFIG,
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  })
  const bucket = `fling-conformance-${run}-${buckets++}`
  await client.send(new CreateBucketCommand({ Bucket: bucket }))
  return { client, bucket }
}
