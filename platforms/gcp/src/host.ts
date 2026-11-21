/**
 * Fling on Google Cloud: the shared Node host (platforms/node/src/host.ts) with this platform's
 * adapters, as the Cloud Run service runs it (main.ts):
 *
 * - **Table**: FirestoreTable, in FIRESTORE_DATABASE (default `(default)`), collection TABLE_NAME
 *   (default `items`).
 * - **Route table**: the Table itself (TableRouteTable), behind the Node host's short per-process
 *   cache (CachedRouteTable): a new key is seen at once, a changed one within the cache's TTL.
 * - **Blobs**: GcsBlobs on SITES_BUCKET, binding uploads by MD5, with the core's HostUploads on
 *   the app host for a client that sends no MD5.
 * - **Live rooms**: the Node host's in-process hub. One process has every socket only when the
 *   service runs one instance, so Terraform sets LIVE_URL only with `max_instances = 1`; with more,
 *   `live` is off (no LIVE_URL) and review pages poll.
 * - **Mail**: the shared SMTP mailer (MAIL_DRIVER=smtp); Google Cloud sends no mail itself.
 * - **Ticks and migrations**: the host's endpoints, for callers with a Google ID token from one of
 *   TICK_SERVICE_ACCOUNTS (ticks.ts): Cloud Scheduler's notify and maintain jobs, and the deploy
 *   running the data migrations. No timers run in the process: Cloud Run gives an instance CPU
 *   only while it serves a request.
 * - **Site servers**: none yet (SERVERS must be off; gcpConfig refuses otherwise).
 */
import type { Blobs } from '@fling/api/blobs'
import { HostUploads } from '@fling/api/blobs/host-uploads'
import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { MemoryLiveHub } from '@fling/api/live-memory'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import type { Table } from '@fling/api/table'
import type { Deps } from '@fling/api/types'
import {
  createNodeHost,
  type NodeHost,
  type PageFiles,
  type TickAuthorizer,
} from '@fling/platform-node/host'
import { smtpMailerFor } from '@fling/platform-node/mail/smtp'
import { CachedRouteTable } from '@fling/platform-node/route-table/cached'
import { SITE_HMAC_KVS_KEY } from '@fling/shared/route-keys'
import { googleIdTokenTicks } from './ticks.ts'

export interface GcpHostOptions {
  config: Config
  table: Table
  /** the sites bucket's Blobs, before the host's upload routes are added as its fallback */
  blobs: (fallback: HostUploads) => Blobs
  /** the service accounts whose ID tokens may call the tick endpoints; none: they answer 404 */
  tickServiceAccounts: string[]
  /** the web build (apps/web), as the image carries it */
  web?: { uiDir: string; pages: PageFiles }
  /** the largest request body taken (Cloud Run's HTTP/1 limit is 32 MiB, the host's default) */
  maxBodyBytes?: number
  /** the tick check (default: Google ID tokens for the app origin, from tickServiceAccounts) */
  authorize?: TickAuthorizer
}

export interface GcpHost {
  host: NodeHost
  deps: Deps
  live: MemoryLiveHub
  close(): Promise<void>
}

export async function createGcpHost(opts: GcpHostOptions): Promise<GcpHost> {
  const { config, table } = opts
  const uploads = new HostUploads(
    { put: (...a) => blobs.put(...a), get: k => blobs.get(k) },
    { secret: config.secrets.sessionSecret, baseUrl: config.appOrigin }
  )
  const blobs = opts.blobs(uploads)
  // One cache for the API's writes and the sites host's reads, so this process sees its writes at once.
  const routes = new CachedRouteTable(new TableRouteTable(table))
  const live = new MemoryLiveHub()
  const mailer = smtpMailerFor(config)
  const deps = buildDeps(config, {
    store: new Records(table),
    blobs,
    routeTable: routes,
    live,
    ...(mailer ? { mailer } : {}),
  })
  await routes.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)

  const authorize =
    opts.authorize ??
    (opts.tickServiceAccounts.length > 0
      ? googleIdTokenTicks({
          audience: config.appOrigin,
          serviceAccounts: opts.tickServiceAccounts,
        })
      : undefined)
  const host = createNodeHost({
    deps,
    table,
    uploads,
    live,
    ...(opts.web ? { uiDir: opts.web.uiDir, pages: opts.web.pages } : {}),
    ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(authorize ? { ticks: { authorize } } : {}),
  })
  return {
    host,
    deps,
    live,
    async close() {
      await live.close()
      mailer?.close()
    },
  }
}
