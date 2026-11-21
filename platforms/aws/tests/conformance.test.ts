/**
 * The conformance suites against the AWS adapters: DynamoTable (and Records on it) on DynamoDB
 * Local and S3Blobs on MinIO, each skipped unless its endpoint is configured (see services.ts).
 * CloudFront KeyValueStore has no local emulator; the RouteTable suite runs against the memory
 * adapter in @fling/conformance.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { HostUploads } from '@fling/api/blobs/host-uploads'
import { Records } from '@fling/api/store/records'
import {
  blobsConformance,
  migrationsConformance,
  storeConformance,
  tableConformance,
} from '@fling/conformance'
import { beforeAll, describe } from 'vitest'
import { S3Blobs } from '../src/blobs/s3.ts'
import { DynamoTable } from '../src/table/dynamo.ts'
import { DYNAMODB_ENDPOINT, dynamoTable, S3_ENDPOINT, s3Bucket } from './services.ts'

/** The platform's host, which serves HostUploads' routes. */
const HOST = 'https://app.example.test'

describe.runIf(DYNAMODB_ENDPOINT)('DynamoDB Local', () => {
  let db: { client: DynamoDBClient; table: string }
  beforeAll(async () => {
    db = await dynamoTable()
  }, 60_000)
  tableConformance('DynamoTable', () => new DynamoTable(db.table, db.client))
  storeConformance(
    'Records on DynamoTable',
    () => new Records(new DynamoTable(db.table, db.client))
  )
  // Migrations scan the whole table: a fresh one per test.
  migrationsConformance('DynamoTable', async () => {
    const fresh = await dynamoTable()
    return new DynamoTable(fresh.table, fresh.client)
  })
})

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
})
