/**
 * Lambda entry (function URL behind CloudFront). Deps are built once per cold start: config from
 * env, secrets from SSM, and the KVS `cfg:site-hmac` key is brought in line with the SSM
 * site-hmac-key so the edge verifies the same `fling_site` cookies we mint.
 *
 * API Gateway WebSocket events (the live rooms' `$connect`, `$default`, `$disconnect`, infra/live.tf)
 * go to live.ts with the same deps.
 *
 * One non-HTTP event: `{"fling":"migrate"}` runs the pending data migrations (deploy.yml invokes it
 * after updating the code; see @fling/api/migrations) until shortly before the invocation's
 * timeout and returns the runner's report; invoke again until `done`. Optional `only: ["NNNN"]`
 * runs those migrations (opt-in ones included), `dryRun: true` writes nothing. Only callers with
 * lambda:InvokeFunction can send it: a function URL request is always an HTTP event whose body is
 * a string, so no visitor can. The same holds for `{"fling":"notify"}`, the scheduler's one-minute
 * tick, which drains the notifications outbox (@fling/api/notifications) and returns its result.
 *
 * Instance values (INSTANCE_NAME, ALLOWED_EMAIL_DOMAINS, BRAND_*, …) can also ship inside the zip as
 * `instance.json` (a flat object of env-style keys, written by scripts/build.mjs from
 * FLING_INSTANCE_CONFIG): the deploy supplies them without touching the function's configuration.
 * The function's own environment wins over the file.
 */
import { readFileSync } from 'node:fs'
import { createApp } from '@fling/api/app'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { MIGRATIONS, type RunReport, runMigrations } from '@fling/api/migrations'
import { type DrainResult, drain } from '@fling/api/notifications'
import { SITE_HMAC_KVS_KEY } from '@fling/shared'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import { handle } from 'hono/aws-lambda'
import { buildAwsDeps } from './deps.ts'
import { handleLiveEvent, isLiveEvent, type LiveEvent } from './live.ts'
import { loadSecretsFromSsm } from './secrets.ts'
import { DynamoTable } from './table/dynamo.ts'

type Env = Record<string, string | undefined>

/** `instance.json` next to the bundle, if the build wrote one. */
export function instanceFileEnv(url = new URL('./instance.json', import.meta.url)): Env {
  let raw: string
  try {
    raw = readFileSync(url, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('instance.json must be a JSON object')
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
}

const runtimeEnv = (): Env => ({ ...instanceFileEnv(), ...process.env })

async function init() {
  const env = runtimeEnv()
  const base = loadBaseConfig(env)
  const secrets = base.ssmPrefix ? await loadSecretsFromSsm(base.ssmPrefix) : secretsFromEnv(env)
  const config: Config = { ...base, secrets }
  const { deps, live } = buildAwsDeps(config)
  if ((await deps.routeTable.get(SITE_HMAC_KVS_KEY)) !== secrets.siteHmacKey) {
    await deps.routeTable.put(SITE_HMAC_KVS_KEY, secrets.siteHmacKey)
  }
  return { http: handle(createApp(deps)), deps, live }
}

export interface MigrateEvent {
  fling: 'migrate'
  only?: string[]
  dryRun?: boolean
}

/** The scheduler's one-minute tick: drain the notifications outbox. */
export interface NotifyEvent {
  fling: 'notify'
}

const isFlingEvent = (event: unknown, name: string) =>
  typeof event === 'object' &&
  event !== null &&
  (event as { fling?: unknown }).fling === name &&
  !('requestContext' in event)

const isNotify = (event: unknown): event is NotifyEvent => isFlingEvent(event, 'notify')

/** Leave this much of the invocation when draining. */
const NOTIFY_MARGIN_MS = 5_000

const isMigrate = (event: unknown): event is MigrateEvent => isFlingEvent(event, 'migrate')

/** Leave this much of the invocation for the last page and the response. */
const MIGRATE_MARGIN_MS = 20_000

export async function migrate(event: MigrateEvent, context: LambdaContext): Promise<RunReport> {
  const base = loadBaseConfig(runtimeEnv())
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

export const handler = async (
  event: LambdaEvent | MigrateEvent | NotifyEvent | LiveEvent,
  context: LambdaContext
) => {
  if (isMigrate(event)) return migrate(event, context)
  ready ??= init().catch(err => {
    ready = undefined // retry the cold start on the next invocation
    throw err
  })
  const { http, deps, live } = await ready
  if (isNotify(event)) {
    const result: DrainResult = await drain(deps, {
      deadline: Date.now() + context.getRemainingTimeInMillis() - NOTIFY_MARGIN_MS,
    })
    console.log(JSON.stringify({ level: 'info', msg: 'notify drain', ...result }))
    return result
  }
  if (isLiveEvent(event)) return live ? handleLiveEvent(event, deps, live) : { statusCode: 404 }
  return http(event as LambdaEvent, context)
}
