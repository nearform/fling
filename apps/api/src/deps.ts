/**
 * Build deps from config. The core only knows the dev/test adapters (Records on a memory table,
 * fs blobs, memory route table, no live hub, memory and file mailers); a platform entry (e.g. platforms/aws) passes its own adapters for the
 * drivers config selects. A cloud driver with no adapter supplied is an error, never a silent
 * fall back to memory.
 */
import { join } from 'node:path'
import type { IdentityProvider } from './auth/identity.ts'
import { identityProviderFor } from './auth/oidc.ts'
import { FsBlobs } from './blobs/fs.ts'
import type { Blobs } from './blobs/types.ts'
import type { Config } from './config.ts'
import { type LiveHub, noLiveHub } from './live.ts'
import { FileMailer } from './mail/file.ts'
import { MemoryMailer } from './mail/memory.ts'
import type { Mailer } from './mail/types.ts'
import { MemoryRouteTable } from './route-table/memory.ts'
import type { RouteTable } from './route-table/types.ts'
import { Records } from './store/records.ts'
import type { Store } from './store/types.ts'
import { MemoryTable } from './table/memory.ts'
import { type Deps, systemClock } from './types.ts'

export interface Adapters {
  store?: Store
  blobs?: Blobs
  routeTable?: RouteTable
  identity?: IdentityProvider | null
  /** the live rooms' hub; without one (or with live rooms off) publishing does nothing */
  live?: LiveHub
  /** the cloud's mailer, for the `ses` and `cloudflare` mail drivers */
  mailer?: Mailer
}

const missing = (driver: string): never => {
  throw new Error(`The ${driver} driver needs its platform adapter (see platforms/)`)
}

export function buildDeps(
  config: Config,
  opts: Adapters & { fsRoot?: string; apiBaseUrl?: string } = {}
): Deps {
  const store: Store =
    opts.store ??
    (config.storeDriver === 'memory' ? new Records(new MemoryTable()) : missing(config.storeDriver))
  const blobs: Blobs =
    opts.blobs ??
    (config.storageDriver === 'fs'
      ? new FsBlobs(
          opts.fsRoot ?? config.fsRoot ?? '.fling-dev',
          opts.apiBaseUrl ?? config.appOrigin,
          config.secrets.sessionSecret
        )
      : missing(config.storageDriver))
  const routeTable: RouteTable =
    opts.routeTable ??
    (config.kvsDriver === 'memory' ? new MemoryRouteTable() : missing(config.kvsDriver))
  const identity = opts.identity !== undefined ? opts.identity : identityProviderFor(config)
  const live = config.live ? (opts.live ?? noLiveHub) : noLiveHub
  const mailer = mailerFor(config, opts)
  return {
    config,
    store,
    blobs,
    routeTable,
    identity,
    live,
    ...(mailer ? { mailer } : {}),
    clock: systemClock,
  }
}

/** The mailer the mail driver names: the core's memory or file one, else the platform's. */
function mailerFor(config: Config, opts: Adapters & { fsRoot?: string }): Mailer | undefined {
  const driver = config.mail?.driver
  if (!driver) return undefined
  if (opts.mailer) return opts.mailer
  if (driver === 'memory') return new MemoryMailer()
  if (driver === 'file')
    return new FileMailer(join(opts.fsRoot ?? config.fsRoot ?? '.fling-dev', 'mail'))
  return missing(`${driver} mail`)
}
