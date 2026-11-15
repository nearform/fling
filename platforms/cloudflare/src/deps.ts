/**
 * The Cloudflare adapters for the drivers config selects (`d1`, `r2`, `workers-kv`; the Worker
 * defaults to them), the live rooms' Durable Objects and, with MAIL_DRIVER=cloudflare, the Email
 * Service mailer over the `EMAIL` binding, and, with SERVERS on, site servers on the Worker Loader
 * (`LOADER`) with their logs in R2 (src/servers/), handed to the core's buildDeps. Any other driver
 * is the core's own memory/fs adapter.
 */
import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { R2Blobs } from './blobs/r2.ts'
import type { Bindings } from './env.ts'
import { DurableObjectLiveHub } from './live.ts'
import { CloudflareMailer } from './mail/email.ts'
import { CachedRouteTable } from './route-table/cached.ts'
import { WorkersKvRouteTable } from './route-table/kv.ts'
import { serverLogsIn } from './servers/logs.ts'
import { CloudflareSiteServers, type ServerBindings } from './servers/runtime.ts'
import { D1Table } from './table/d1.ts'

/** What the Worker sets unless its vars say otherwise. */
export const CLOUDFLARE_DRIVERS = {
  APP_ENV: 'production',
  STORE_DRIVER: 'd1',
  STORAGE_DRIVER: 'r2',
  KVS_DRIVER: 'workers-kv',
} as const

/**
 * The site servers SERVERS asks for, on the Worker Loader. Throws when it is on and the Worker
 * has no `worker_loaders` binding: the deploy config renders one only with INSTANCE.SERVERS.
 */
function siteServers(config: Config, env: Bindings, bindings?: ServerBindings) {
  if (config.servers.publish.kind === 'off') return undefined
  if (!env.LOADER || !bindings) {
    throw new Error(
      'SERVERS is on, but the Worker has no Worker Loader binding (LOADER): see DEPLOY.md, Site servers'
    )
  }
  return new CloudflareSiteServers({
    loader: env.LOADER,
    bucket: env.BUCKET,
    bindings,
    key: config.secrets.siteSecretsKey ?? '',
    rateLimit: env.SERVER_RATE_LIMIT,
    baseRps: config.servers.limits.rps,
  })
}

export function buildCloudflareDeps(
  config: Config,
  env: Bindings,
  opts: { serverBindings?: ServerBindings } = {}
): Deps {
  const table = new D1Table(env.DB)
  const servers = siteServers(config, env, opts.serverBindings)
  const deps = buildDeps(config, {
    store: config.storeDriver === 'd1' ? new Records(table) : undefined,
    blobs:
      config.storageDriver === 'r2'
        ? new R2Blobs(env.BUCKET, {
            secret: config.secrets.sessionSecret,
            baseUrl: config.appOrigin,
          })
        : undefined,
    routeTable:
      config.kvsDriver === 'workers-kv'
        ? new CachedRouteTable(new WorkersKvRouteTable(env.ROUTES), new TableRouteTable(table))
        : undefined,
    live: new DurableObjectLiveHub(env.LIVE_ROOMS),
    mailer:
      config.mail?.driver === 'cloudflare' && env.EMAIL
        ? new CloudflareMailer(env.EMAIL)
        : undefined,
    ...(servers ? { servers, serverLogs: serverLogsIn(env.BUCKET) } : {}),
  })
  return {
    ...deps,
    // The remote MCP's "wait until the edge routes it": nothing to wait for here, the sites host
    // answers a KV miss from D1 (CachedRouteTable), which has the route as soon as it's written.
    waitReady: async () => ({ ready: true }),
  }
}
