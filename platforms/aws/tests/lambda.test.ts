/**
 * The Lambda's migrate event against DynamoDB Local (skipped without it, see services.ts): what
 * deploy.yml invokes after updating the code.
 */
import { legacyItems } from '@fling/conformance'
import type { LambdaContext } from 'hono/aws-lambda'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { handler } from '../src/lambda.ts'
import { DynamoTable } from '../src/table/dynamo.ts'
import { DYNAMODB_ENDPOINT, dynamoTable } from './services.ts'

const context = (remainingMs: number) =>
  ({ getRemainingTimeInMillis: () => remainingMs }) as unknown as LambdaContext

describe.runIf(DYNAMODB_ENDPOINT)('{"fling":"migrate"}', () => {
  let table: DynamoTable

  beforeAll(async () => {
    const db = await dynamoTable()
    table = new DynamoTable(db.table, db.client)
    for (const item of legacyItems()) await table.put(item)
    vi.stubEnv('APP_ENV', 'development')
    vi.stubEnv('APP_ORIGIN', 'https://app.example.test')
    vi.stubEnv('STORE_DRIVER', 'dynamo')
    vi.stubEnv('TABLE_NAME', db.table)
    // The function's own client (no endpoint argument) finds DynamoDB Local through these.
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', DYNAMODB_ENDPOINT)
    vi.stubEnv('AWS_REGION', 'us-east-1')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'fling')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fling')
  }, 60_000)

  afterEach(() => {
    vi.restoreAllMocks()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('stops when out of time, then runs to done, then is a no-op', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const statuses = (r: unknown) =>
      (r as { migrations: { status: string }[] }).migrations.map(m => m.status)

    // Out of time before the first page: the handler stops cleanly with work left.
    const late = await handler({ fling: 'migrate' }, context(0))
    expect(late).toMatchObject({ done: false })
    expect(statuses(late)).toContain('partial')

    const report = await handler({ fling: 'migrate' }, context(60_000))
    expect(report).toMatchObject({ done: true, dryRun: false })
    for (const status of statuses(report)) expect(['completed', 'skipped']).toContain(status)
    expect(await table.get('SITE#S1', 'SITE')).not.toBeNull()

    // Up to date: nothing runs again.
    const again = await handler({ fling: 'migrate' }, context(60_000))
    expect(again).toMatchObject({ done: true })
    for (const status of statuses(again)) expect(['up-to-date', 'skipped']).toContain(status)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"msg":"migrations"'))
  })
})
