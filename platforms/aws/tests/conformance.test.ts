/**
 * The conformance suites against the AWS adapters: DynamoTable (and Records on it) on DynamoDB
 * Local and S3Blobs on MinIO, each skipped unless its endpoint is configured (see services.ts).
 * CloudFront KeyValueStore has no local emulator; the RouteTable suite runs against the memory
 * adapter in @fling/conformance.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
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
  blobsConformance('S3Blobs', () => ({
    blobs: new S3Blobs(s3.bucket, s3.client),
    metadata: async key => {
      const res = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }))
      return { contentType: res.ContentType, cacheControl: res.CacheControl }
    },
  }))
})
