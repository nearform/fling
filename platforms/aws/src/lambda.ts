/**
 * Lambda entry (function URL behind CloudFront). Deps are built once per cold start: config from
 * env, secrets from SSM, and the KVS `cfg:site-hmac` key is brought in line with the SSM
 * site-hmac-key so the edge verifies the same `fling_site` cookies we mint.
 *
 * One non-HTTP event: `{"fling":"migrate"}` runs the pending data migrations (deploy.yml invokes it
 * after updating the code; see @fling/api/migrations) until shortly before the invocation's
 * timeout and returns the runner's report; invoke again until `done`. Optional `only: ["NNNN"]`
 * runs those migrations (opt-in ones included), `dryRun: true` writes nothing. Only callers with
 * lambda:InvokeFunction can send it: a function URL request is always an HTTP event whose body is
 * a string, so no visitor can.
 */
import { createApp } from '@fling/api/app'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { MIGRATIONS, type RunReport, runMigrations } from '@fling/api/migrations'
import { SITE_HMAC_KVS_KEY } from '@fling/shared'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import { handle } from 'hono/aws-lambda'
import { buildAwsDeps } from './deps.ts'
import { loadSecretsFromSsm } from './secrets.ts'
import { DynamoTable } from './table/dynamo.ts'

async function init() {
  const base = loadBaseConfig(process.env)
  const secrets = base.ssmPrefix
    ? await loadSecretsFromSsm(base.ssmPrefix)
    : secretsFromEnv(process.env)
  const config: Config = { ...base, secrets }
  const deps = buildAwsDeps(config)
  if ((await deps.routeTable.get(SITE_HMAC_KVS_KEY)) !== secrets.siteHmacKey) {
    await deps.routeTable.put(SITE_HMAC_KVS_KEY, secrets.siteHmacKey)
  }
  return handle(createApp(deps))
}

export interface MigrateEvent {
  fling: 'migrate'
  only?: string[]
  dryRun?: boolean
}

const isMigrate = (event: unknown): event is MigrateEvent =>
  typeof event === 'object' &&
  event !== null &&
  (event as { fling?: unknown }).fling === 'migrate' &&
  !('requestContext' in event)

/** Leave this much of the invocation for the last page and the response. */
const MIGRATE_MARGIN_MS = 20_000

export async function migrate(event: MigrateEvent, context: LambdaContext): Promise<RunReport> {
  const base = loadBaseConfig(process.env)
  if (base.storeDriver !== 'dynamo' || !base.tableName) {
    throw new Error('Migrations need the dynamo store driver and TABLE_NAME')
  }
  const remaining = context.getRemainingTimeInMillis()
  const report = await runMigrations(new DynamoTable(base.tableName), {
    migrations: MIGRATIONS,
    only: event.only,
    dryRun: event.dryRun === true,
    deadline: Date.now() + Math.max(remaining - MIGRATE_MARGIN_MS, remaining / 2),
    log: line => console.log(JSON.stringify({ level: 'info', msg: 'migrate', line })),
  })
  console.log(JSON.stringify({ level: 'info', msg: 'migrations', ...report }))
  return report
}

let ready: ReturnType<typeof init> | undefined

export const handler = async (event: LambdaEvent | MigrateEvent, context: LambdaContext) => {
  if (isMigrate(event)) return migrate(event, context)
  ready ??= init().catch(err => {
    ready = undefined // retry the cold start on the next invocation
    throw err
  })
  return (await ready)(event, context)
}
