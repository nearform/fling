/**
 * The conformance suites against the AWS adapters: DynamoTable (and Records on it) on DynamoDB
 * Local, skipped unless its endpoint is configured (see services.ts). S3Blobs is shared with the
 * other S3-compatible stores and runs its suite on MinIO in platforms/s3. CloudFront
 * KeyValueStore has no local emulator; the RouteTable suite runs against the memory adapter in
 * @fling/conformance.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { Records } from '@fling/api/store/records'
import { migrationsConformance, storeConformance, tableConformance } from '@fling/conformance'
import { beforeAll, describe } from 'vitest'
import { DynamoTable } from '../src/table/dynamo.ts'
import { DYNAMODB_ENDPOINT, dynamoTable } from './services.ts'

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
