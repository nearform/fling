/**
 * The Node host as a process of its own, configured from the environment like every platform
 * (@fling/api/config), with this package's adapters:
 *
 * - **Table**: PostgresTable on `DATABASE_URL` (`postgres://…`), in `DATABASE_SCHEMA`; without
 *   one, on PGlite (Postgres in process) under `<FS_ROOT>/pglite`, for one process on one machine.
 *   Its schema migrations, then the data migrations, run on start, as a deploy runs them.
 * - **Route table**: the Table itself (TableRouteTable), cached for a few seconds per process.
 * - **Blobs**: the filesystem under `FS_ROOT` (default `.fling-node`), its signed routes on the app
 *   host.
 * - **Live rooms**: in process, fanned out through Postgres LISTEN/NOTIFY when the Table is on a
 *   server (several processes share it); `LIVE_URL` is `ws(s)://<app host>/api/live`.
 * - **Mail**: `MAIL_DRIVER=smtp` through SmtpMailer, or the core's `file` and `memory`.
 * - **Site servers** (SERVERS on): Node child processes, as in dev.
 * - **Ticks**: in process, the notifications every minute and maintenance hourly; and the
 *   endpoints (host.ts) for an outside scheduler when TICK_SECRET is set. Repeated ticks are safe.
 *
 * `PORT` (default 8080) is where it listens, `MAX_REQUEST_BYTES` (default 32 MiB) the largest
 * request body it takes; the web build (apps/web: `dist`, `dist-404`,
 * `dist-review`, `sites-robots.txt`) is read from this checkout. The e2e runs it as the `node`
 * local runtime (packages/e2e/src/local.ts).
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { FsBlobs } from '@fling/api/blobs/fs'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { MemoryLiveHub } from '@fling/api/live-memory'
import { MIGRATIONS, runMigrations } from '@fling/api/migrations'
import { TableRouteTable } from '@fling/api/route-table/table'
import { MemoryServerLogs } from '@fling/api/servers/memory-logs'
import { NodeSiteServers } from '@fling/api/servers/node'
import { restartOptions } from '@fling/api/servers/node/restart'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { SITE_HMAC_KVS_KEY } from '@fling/shared/route-keys'
import pg from 'pg'
import { createNodeHost, sharedSecretTicks } from './host.ts'
import { PostgresFanout, pgNotifier } from './live/postgres-fanout.ts'
import { smtpMailerFor } from './mail/smtp.ts'
import { CachedRouteTable } from './route-table/cached.ts'
import { pgDatabase, pgliteDatabase } from './table/database.ts'
import { PostgresTable } from './table/postgres.ts'
import { drain, maintain } from './ticks.ts'

/** The drivers this process implements, whatever the environment names. */
export const NODE_DRIVERS = {
  STORE_DRIVER: 'postgres',
  STORAGE_DRIVER: 'fs',
  KVS_DRIVER: 'table',
} as const

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const web = (...p: string[]) => resolve(repo, 'apps', 'web', ...p)

const env = { ...process.env, ...NODE_DRIVERS }
const config: Config = { ...loadBaseConfig(env), secrets: secretsFromEnv(env) }
const port = Number(process.env.PORT ?? 8080)
const fsRoot = resolve(config.fsRoot ?? '.fling-node')
mkdirSync(fsRoot, { recursive: true })
const schema = config.databaseSchema

// The Table: a Postgres server, or Postgres in process.
const url = config.secrets.databaseUrl
const pool = url ? new pg.Pool({ connectionString: url }) : undefined
const lite = url ? undefined : await PGlite.create(resolve(fsRoot, 'pglite'))
const database = pool ? pgDatabase(pool) : pgliteDatabase(lite as PGlite)
const applied = await database.migrate(schema)
const table = new PostgresTable(database.db, { schema })
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
const blobs = new FsBlobs(fsRoot, config.appOrigin, config.secrets.sessionSecret)
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
  setInterval(() => void maintain(ready, table).catch(() => {}), 60 * 60_000),
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
