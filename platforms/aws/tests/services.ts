/**
 * Clients for the local stand-ins the service-backed suites run against: DynamoDB Local and MinIO.
 * Each suite runs only when its endpoint env var is set (CI sets both, with the services in
 * ci.yml), so `pnpm gate` passes on a laptop without Docker. To run them locally:
 *
 *   docker run -d -p 8000:8000 amazon/dynamodb-local
 *   docker run -d -p 9000:9000 -e MINIO_ROOT_USER=fling-test \
 *     -e MINIO_ROOT_PASSWORD=fling-test-secret bitnamilegacy/minio
 *   FLING_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     FLING_TEST_S3_ENDPOINT=http://localhost:9000 pnpm --filter @fling/platform-aws test
 *
 * The table and the bucket are created here, named per run, never in a workflow step.
 */
import { randomUUID } from 'node:crypto'
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3_CLIENT_CONFIG } from '../src/blobs/s3.ts'

export const DYNAMODB_ENDPOINT = process.env.FLING_TEST_DYNAMODB_ENDPOINT
export const S3_ENDPOINT = process.env.FLING_TEST_S3_ENDPOINT

const region = 'us-east-1'
const run = randomUUID().slice(0, 8)

/** A DynamoDB Local client and a fresh table with the production key schema (PK, SK; no GSIs). */
export async function dynamoTable() {
  const client = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region,
    credentials: { accessKeyId: 'fling', secretAccessKey: 'fling' },
  })
  const table = `fling-conformance-${run}`
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    })
  )
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: table })
  return { client, table }
}

/** A MinIO client (same checksum settings as production) and a fresh bucket. */
export async function s3Bucket() {
  const client = new S3Client({
    ...S3_CLIENT_CONFIG,
    endpoint: S3_ENDPOINT,
    region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.FLING_TEST_S3_ACCESS_KEY ?? 'fling-test',
      secretAccessKey: process.env.FLING_TEST_S3_SECRET_KEY ?? 'fling-test-secret',
    },
  })
  const bucket = `fling-conformance-${run}`
  await client.send(new CreateBucketCommand({ Bucket: bucket }))
  return { client, bucket }
}
