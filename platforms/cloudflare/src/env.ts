/**
 * What the Worker gets from wrangler.jsonc: the bindings, the instance's configuration as plain
 * vars (the same env-style keys @fling/api/config reads on every platform) and its secrets
 * (`SESSION_SECRET`, `SITE_HMAC_KEY`, `OIDC_CLIENT_SECRET`; `wrangler secret put`).
 */
import type { D1Database, Fetcher, KVNamespace, R2Bucket } from '@cloudflare/workers-types'

export interface Bindings {
  /** D1: the Table (migrations/*.sql) */
  DB: D1Database
  /** R2: site files and manifests (the Blobs port) */
  BUCKET: R2Bucket
  /** Workers KV: the route table's fast copy (D1 holds the authoritative one) */
  ROUTES: KVNamespace
  /** Static Assets: the web UI build, plus `_fling/404.html` (scripts/build.mjs) */
  ASSETS: Fetcher
}

export type Env = Bindings & Record<string, unknown>

/** The string-valued entries of the env: vars and secrets, never bindings. */
export function stringVars(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value
  return out
}
