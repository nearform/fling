/**
 * The Node host as a process of its own, configured from the environment like every platform
 * (@fling/api/config), with this package's adapters:
 *
 * - **Table**: PostgresTable on `DATABASE_URL` (`postgres://…`, its TLS verified against
 *   `DATABASE_CA_CERT` when set), in `DATABASE_SCHEMA`; without
 *   one, on PGlite (Postgres in process) under `<FS_ROOT>/pglite`, for one process on one machine.
 *   Its schema migrations, then the data migrations, run on start, as a deploy runs them.
 * - **Route table**: the Table itself (TableRouteTable), cached for a few seconds per process.
 * - **Blobs** (`STORAGE_DRIVER`, blobs.ts): the filesystem under `FS_ROOT` (default `.fling-node`),
 *   its signed routes on the app host; or (`s3`) any S3-compatible store, from `SITES_BUCKET` and
 *   `S3_*`, with the host's upload routes for a file a store bound by MD5 can't take directly.
 * - **Live rooms**: in process, fanned out through Postgres LISTEN/NOTIFY when the Table is on a
 *   server (several processes share it); `LIVE_URL` is `ws(s)://<app host>/api/live`.
 * - **Mail**: `MAIL_DRIVER=smtp` through SmtpMailer, or the core's `file` and `memory`.
 * - **Site servers** (SERVERS on): Node child processes, as in dev.
 * - **Ticks**: in process, the notifications every minute and maintenance hourly; and the
 *   endpoints (host.ts) for an outside scheduler when TICK_SECRET is set. Repeated ticks are safe.
 *
 * `PORT` (default 8080) is where it listens, `MAX_REQUEST_BYTES` (default 32 MiB) the largest
 * request body it takes; the web build (apps/web: `dist`, `dist-404`, `dist-review`,
 * `sites-robots.txt`) is read from `WEB_DIR` (default: this checkout's apps/web, as the image
 * built by scripts/build.mjs and the Dockerfile sets it). `/healthz` answers on any host that is
 * neither the app's nor a site's, for a load balancer's or an orchestrator's probe. The e2e runs
 * it as the `node` local runtime (packages/e2e/src/local.ts).
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { MemoryLiveHub } from '@fling/api/live-memory'
import { MAINTAIN_BUDGET_MS, MAINTAIN_EVERY_MS } from '@fling/api/maintenance'
import { MIGRATIONS, runMigrations } from '@fling/api/migrations'
import { TableRouteTable } from '@fling/api/route-table/table'
import { MemoryServerLogs } from '@fling/api/servers/memory-logs'
import { NodeSiteServers } from '@fling/api/servers/node'
import { restartOptions } from '@fling/api/servers/node/restart'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { SITE_HMAC_KVS_KEY } from '@fling/shared/route-keys'
import pg from 'pg'
import { nodeBlobs, storageDriver } from './blobs.ts'
import { createNodeHost, sharedSecretTicks } from './host.ts'
import { PostgresFanout, pgNotifier } from './live/postgres-fanout.ts'
import { smtpMailerFor } from './mail/smtp.ts'
import { CachedRouteTable } from './route-table/cached.ts'
import { pgDatabase, pgliteDatabase, pgPoolConfig } from './table/database.ts'
import { PostgresTable } from './table/postgres.ts'
import { drain, maintain } from './ticks.ts'

/** The drivers this process implements, whatever the environment names (and the store it names). */
export const NODE_DRIVERS = {
  STORE_DRIVER: 'postgres',
  KVS_DRIVER: 'table',
} as const

const webDir =
  process.env.WEB_DIR?.trim() ||
  resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'apps', 'web')
const web = (...p: string[]) => resolve(webDir, ...p)

const env = { ...process.env, ...NODE_DRIVERS, STORAGE_DRIVER: storageDriver(process.env) }
const config: Config = { ...loadBaseConfig(env), secrets: secretsFromEnv(env) }
const port = Number(process.env.PORT ?? 8080)
const fsRoot = resolve(config.fsRoot ?? '.fling-node')
mkdirSync(fsRoot, { recursive: true })
const schema = config.databaseSchema

// The Table: a Postgres server, or Postgres in process.
const url = config.secrets.databaseUrl
const pool = url ? new pg.Pool(pgPoolConfig(url, process.env.DATABASE_CA_CERT)) : undefined
const lite = url ? undefined : await PGlite.create(resolve(fsRoot, 'pglite'))
const database = pool ? pgDatabase(pool) : pgliteDatabase(lite as PGlite)
const applied = await database.migrate(schema)
const table = new PostgresTable(database, { schema })
const migrated = await runMigrations(table, { migrations: MIGRATIONS })
console.log(
  JSON.stringify({
    level: 'info',
    msg: 'migrations',
    schema: `${applied} applied`,
    data: migrated.migrations.map(m => `${m.id} ${m.status}`),
  })
)

// One cache for the API's writes and the sites host's reads, so this process sees its writes at once.
const routes = new CachedRouteTable(new TableRouteTable(table))
const { blobs, uploads } = nodeBlobs(config, env, fsRoot)
// Several processes share a Postgres server, so their rooms fan out through it; PGlite is one.
const live = new MemoryLiveHub(
  pool ? { fanout: new PostgresFanout(pgNotifier(pool), { schema }) } : {}
)
const serverLogs = new MemoryServerLogs()
let deps: Deps | undefined
const servers = new NodeSiteServers({
  blobs,
  workDir: resolve(fsRoot, 'servers'),
  filesDir: version => resolve(fsRoot, version.files),
  logs: serverLogs,
  optionsFor: restartOptions(() => deps as Deps),
})
const mailer = smtpMailerFor(config)
deps = buildDeps(config, {
  store: new Records(table),
  blobs,
  routeTable: routes,
  live,
  fsRoot,
  serverLogs,
  ...(mailer ? { mailer } : {}),
  ...(config.servers.publish.kind === 'off' ? {} : { servers }),
})
await routes.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)

const host = createNodeHost({
  deps,
  table,
  uiDir: web('dist'),
  pages: {
    notFound: web('dist-404', '404.html'),
    reviewShell: web('dist-review', 'review-shell.html'),
    robots: web('sites-robots.txt'),
  },
  live,
  ...(uploads ? { uploads } : {}),
  ...(process.env.MAX_REQUEST_BYTES ? { maxBodyBytes: Number(process.env.MAX_REQUEST_BYTES) } : {}),
  ...(config.secrets.tickSecret
    ? { ticks: { authorize: sharedSecretTicks(config.secrets.tickSecret) } }
    : {}),
})
const listening = await host.listen(port)
console.log(
  JSON.stringify({
    level: 'info',
    msg: 'fling node host',
    port: listening.port,
    app: config.appOrigin,
    sites: `*.${config.sitesDomain}`,
  })
)

// The ticks, in process: safe beside an outside scheduler, since every tick is safe to repeat.
const ready = deps
const timers = [
  ...(ready.mailer ? [setInterval(() => void drain(ready).catch(() => {}), 60_000)] : []),
  setInterval(
    () => void maintain(ready, table, Date.now() + MAINTAIN_BUDGET_MS).catch(() => {}),
    MAINTAIN_EVERY_MS
  ),
]

async function shutdown() {
  for (const t of timers) clearInterval(t)
  await listening.close()
  await servers.close()
  await live.close()
  mailer?.close()
  await database.close()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown())
