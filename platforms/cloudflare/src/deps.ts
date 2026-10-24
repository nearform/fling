/**
 * The Cloudflare adapters for the drivers config selects (`d1`, `r2`, `workers-kv`; the Worker
 * defaults to them), handed to the core's buildDeps. Any other driver is the core's own
 * memory/fs adapter.
 */
import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { R2Blobs } from './blobs/r2.ts'
import type { Bindings } from './env.ts'
import { CachedRouteTable } from './route-table/cached.ts'
import { WorkersKvRouteTable } from './route-table/kv.ts'
import { D1Table } from './table/d1.ts'

/** What the Worker sets unless its vars say otherwise. */
export const CLOUDFLARE_DRIVERS = {
  APP_ENV: 'production',
  STORE_DRIVER: 'd1',
  STORAGE_DRIVER: 'r2',
  KVS_DRIVER: 'workers-kv',
} as const

export function buildCloudflareDeps(config: Config, env: Bindings): Deps {
  const table = new D1Table(env.DB)
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
  })
  return {
    ...deps,
    // The remote MCP's "wait until the edge routes it": nothing to wait for here, the sites host
    // answers a KV miss from D1 (CachedRouteTable), which has the route as soon as it's written.
    waitReady: async () => ({ ready: true }),
  }
}
