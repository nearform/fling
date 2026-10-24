/**
 * Lambda entry (function URL behind CloudFront). Deps are built once per cold start: config from
 * env, secrets from SSM, and the KVS `cfg:site-hmac` key is brought in line with the SSM
 * site-hmac-key so the edge verifies the same `fling_site` cookies we mint.
 */
import { createApp } from '@fling/api/app'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { SITE_HMAC_KVS_KEY } from '@fling/shared'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import { handle } from 'hono/aws-lambda'
import { buildAwsDeps } from './deps.ts'
import { loadSecretsFromSsm } from './secrets.ts'

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

let ready: ReturnType<typeof init> | undefined

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  ready ??= init().catch(err => {
    ready = undefined // retry the cold start on the next invocation
    throw err
  })
  return (await ready)(event, context)
}
