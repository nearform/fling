/**
 * The client for the local stand-in the service-backed suite runs against: DynamoDB Local. The
 * suite runs only when its endpoint env var is set (CI sets it, with the service in ci.yml), so
 * `pnpm gate` passes on a laptop without Docker. To run it locally:
 *
 *   docker run -d -p 8000:8000 amazon/dynamodb-local
 *   FLING_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 pnpm --filter @fling/platform-aws test
 *
 * The table is created here, named per run, never in a workflow step. S3Blobs' suite on MinIO is
 * in platforms/s3 (its tests/services.ts).
 */
import { randomUUID } from 'node:crypto'
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb'

export const DYNAMODB_ENDPOINT = process.env.FLING_TEST_DYNAMODB_ENDPOINT

const region = 'us-east-1'
const run = randomUUID().slice(0, 8)

let tables = 0

/** A DynamoDB Local client and a fresh table with the production key schema (PK, SK; no GSIs). */
export async function dynamoTable() {
  const client = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region,
    credentials: { accessKeyId: 'fling', secretAccessKey: 'fling' },
  })
  const table = `fling-conformance-${run}-${tables++}`
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
