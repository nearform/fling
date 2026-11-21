/**
 * The environment the Cloud Run service runs with, made into the core's config:
 *
 * - `instance.json` next to the bundle (the instance's own values, written by scripts/build.mjs
 *   from GCP_DEPLOY_CONFIG's `INSTANCE`), under the service's own environment (Terraform's
 *   platform values: APP_ORIGIN, SITES_DOMAIN, SITES_BUCKET, MAIL_*…);
 * - the drivers this platform implements, whatever the environment names;
 * - the secrets, which Cloud Run puts in the environment from Secret Manager when an instance
 *   starts (each one's `latest` version). A secret Terraform made for someone to fill holds the
 *   placeholder `unset` until they do, and reads as not set.
 */
import { readFileSync } from 'node:fs'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'

export type Env = Record<string, string | undefined>

/** The drivers this platform implements. */
export const GCP_DRIVERS = {
  STORE_DRIVER: 'firestore',
  STORAGE_DRIVER: 'gcs',
  KVS_DRIVER: 'table',
} as const

/** What a secret Terraform created for someone to fill holds until they do. */
export const UNSET_SECRET = 'unset'

/** `instance.json` at `url`, if the build wrote one. */
export function instanceFileEnv(url: URL): Env {
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

/** The environment with the placeholder secrets dropped and this platform's drivers set. */
export function gcpEnv(env: Env): Env {
  const out: Env = {}
  for (const [k, v] of Object.entries(env)) if (v?.trim() !== UNSET_SECRET) out[k] = v
  return { ...out, ...GCP_DRIVERS }
}

/** The core's config, with its secrets, from the (already merged) environment. */
export function gcpConfig(env: Env): Config {
  const e = gcpEnv(env)
  const config: Config = { ...loadBaseConfig(e), secrets: secretsFromEnv(e) }
  if (config.servers.publish.kind !== 'off') {
    throw new Error('SERVERS: site servers are not available on Google Cloud yet; leave it off')
  }
  return config
}

/** The service accounts whose ID tokens may call the tick endpoints (TICK_SERVICE_ACCOUNTS). */
export const tickServiceAccounts = (env: Env) =>
  (env.TICK_SERVICE_ACCOUNTS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
