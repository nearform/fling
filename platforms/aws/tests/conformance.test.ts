/**
 * The conformance suites against the AWS adapters: DynamoStore on DynamoDB Local and S3Blobs on
 * MinIO, each skipped unless its endpoint is configured (see services.ts). CloudFront
 * KeyValueStore has no local emulator; the RouteTable suite runs against the memory adapter in
 * @fling/conformance.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { S3Client } from '@aws-sdk/client-s3'
import { blobsConformance, storeConformance } from '@fling/conformance'
import { beforeAll, describe } from 'vitest'
import { S3Blobs } from '../src/blobs/s3.ts'
import { DynamoStore } from '../src/store/dynamo.ts'
import { DYNAMODB_ENDPOINT, dynamoTable, S3_ENDPOINT, s3Bucket } from './services.ts'

describe.runIf(DYNAMODB_ENDPOINT)('DynamoDB Local', () => {
  let db: { client: DynamoDBClient; table: string }
  beforeAll(async () => {
    db = await dynamoTable()
  }, 60_000)
  storeConformance('DynamoStore', () => new DynamoStore(db.table, db.client))
})

describe.runIf(S3_ENDPOINT)('MinIO', () => {
  let s3: { client: S3Client; bucket: string }
  beforeAll(async () => {
    s3 = await s3Bucket()
  }, 60_000)
  blobsConformance('S3Blobs', () => ({ blobs: new S3Blobs(s3.bucket, s3.client) }))
})
