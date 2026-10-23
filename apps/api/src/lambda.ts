/**
 * Lambda entry (function URL behind CloudFront). Deps are built once per cold start: config from
 * env, secrets from SSM, and the KVS `cfg:site-hmac` key is brought in line with the SSM
 * site-hmac-key so the edge verifies the same `fling_site` cookies we mint.
 */
import { SITE_HMAC_KVS_KEY } from '@fling/shared'
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda'
import { handle } from 'hono/aws-lambda'
import { createApp } from './app.ts'
import { type Config, loadBaseConfig, secretsFromEnv } from './config.ts'
import { buildDeps } from './deps.ts'
import { loadSecretsFromSsm } from './secrets.ts'

async function init() {
  const base = loadBaseConfig(process.env)
  const secrets = base.ssmPrefix
    ? await loadSecretsFromSsm(base.ssmPrefix)
    : secretsFromEnv(process.env)
  const config: Config = { ...base, secrets }
  const deps = buildDeps(config)
  if ((await deps.kvs.get(SITE_HMAC_KVS_KEY)) !== secrets.siteHmacKey) {
    await deps.kvs.put(SITE_HMAC_KVS_KEY, secrets.siteHmacKey)
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
