/**
 * The Postgres database the Node platform keeps its Table in, as Drizzle sees it, on one of two
 * drivers: a `pg` Pool (`pgDatabase`: a Postgres server, managed or self-hosted) and PGlite
 * (`pgliteDatabase`: Postgres compiled to WebAssembly, in process, which the tests and the local
 * runtime use). PostgresTable is written once over `Database`, what both drivers give: Drizzle's
 * Postgres database and a READ COMMITTED transaction on one connection.
 *
 * `DATABASE_URL` must reach Postgres directly or through a pooler in session mode. A pooler in
 * transaction mode (PgBouncer's, or a provider's "transaction" endpoint) hands each statement
 * outside a transaction to any server connection, which breaks what holds a connection: the
 * migrator's lock and search_path, and LISTEN. `migrate` checks that its statements stay on one
 * server connection with its search_path, and fails saying so when they don't.
 *
 * `migrate` applies the migrations drizzle-kit generated (drizzle/) that the instance's schema
 * lacks, recorded in `<schema>.fling_migrations`. They name no schema, so it runs them with the
 * schema as the connection's search_path, on one connection, under a session advisory lock: hosts
 * starting together apply each one once. It refuses a database whose encoding is not UTF-8:
 * `COLLATE "C"` is byte order only over UTF-8, and byte order is what the Table port promises.
 *
 * The first migration creates its table and index only if they don't exist, so a database whose
 * items table was made before the schema came from drizzle-kit is taken as it is.
 */
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle as nodePg } from 'drizzle-orm/node-postgres'
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as pglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import type pg from 'pg'
import { DEFAULT_SCHEMA, schemaName } from './items.ts'

/** What PostgresTable needs of a database: Drizzle's Postgres database, on either driver. */
export type FlingDatabase = PgDatabase<PgQueryResultHKT>

/** The database inside `Database.transaction`: no `transaction` of its own, so none nests. */
export type FlingTransaction = Omit<FlingDatabase, 'transaction'>

export interface Database {
  db: FlingDatabase
  /**
   * `fn` in one READ COMMITTED transaction on one connection: committed when it resolves, rolled
   * back when it throws, with `fn`'s error
   */
  transaction<T>(fn: (tx: FlingTransaction) => Promise<T>): Promise<T>
  /** apply the migrations `schema` lacks (see the header); returns how many it applied */
  migrate(schema?: string): Promise<number>
  /** release the connections (a pool's, or PGlite's database) */
  close(): Promise<void>
}

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))
const MIGRATIONS_TABLE = 'fling_migrations'
/** Fixed key of the advisory lock migrations hold (any 64-bit number nothing else uses). */
const MIGRATE_LOCK = 7_316_843_257

/** The rows `db.execute` answered, on either driver (both answer `{ rows }`). */
const rowsOf = <R>(result: unknown) => (result as { rows: R[] }).rows

/** How many migrations `schema` has had (0 before its first). */
async function migrations(db: FlingDatabase, schema: string): Promise<number> {
  const found = rowsOf(
    await db.execute(
      sql`SELECT 1 FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ${MIGRATIONS_TABLE}`
    )
  )
  if (found.length === 0) return 0
  const [row] = rowsOf<{ n: number }>(
    await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(schema)}.${sql.identifier(MIGRATIONS_TABLE)}`
    )
  )
  return row?.n ?? 0
}

/** `run` on one connection, as `schema`'s migrator: UTF-8 checked, locked, search_path set. */
async function migrating(
  db: FlingDatabase,
  schema: string,
  run: (config: {
    migrationsFolder: string
    migrationsSchema: string
    migrationsTable: string
  }) => Promise<void>
) {
  const name = schemaName(schema)
  const [encoding] = rowsOf<{ server_encoding?: string }>(
    await db.execute(sql`SHOW server_encoding`)
  )
  if (encoding?.server_encoding !== 'UTF8') {
    throw new Error(`the database's encoding must be UTF8, not ${encoding?.server_encoding}`)
  }
  // The session must stick before anything is taken in it: behind a pooler in transaction mode
  // the lock could be taken on one server connection and never let go on another.
  await db.execute(sql`SET search_path TO ${sql.identifier(name)}`)
  const pid = await stickySession(db)
  let locked = false
  try {
    locked = await lock(db, pid)
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(name)}`)
    const before = await migrations(db, name)
    const [session] = rowsOf<{ schema: string | null }>(
      await db.execute(sql`SELECT current_schema() AS schema`)
    )
    if (session?.schema !== name) throw new Error(SESSION_LOST)
    await run({
      migrationsFolder: MIGRATIONS,
      migrationsSchema: name,
      migrationsTable: MIGRATIONS_TABLE,
    })
    return (await migrations(db, name)) - before
  } finally {
    await db.execute(sql`RESET search_path`)
    if (locked) await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK})`)
  }
}

const SESSION_LOST =
  'the database connection does not keep its session (a pooler in transaction mode?): ' +
  'DATABASE_URL must be a direct or session-mode connection'

/** The server connection's pid, once two reads find it and its search_path the same. */
async function stickySession(db: FlingDatabase): Promise<number> {
  const read = async () =>
    rowsOf<{ pid: number; path: string }>(
      await db.execute(sql`SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path`)
    )[0]
  const [a, b] = [await read(), await read()]
  if (!a || !b || a.pid !== b.pid || a.path !== b.path) throw new Error(SESSION_LOST)
  return a.pid
}

/** How long a migrator waits for another one (a host starting beside it) to finish. */
const LOCK_WAIT_MS = 5 * 60_000
const LOCK_POLL_MS = 500

/**
 * The migrations' session advisory lock, on server connection `pid`, polled with
 * `pg_try_advisory_lock` until LOCK_WAIT_MS: true once held; throws past the deadline, saying
 * another migrator holds it.
 */
async function lock(db: FlingDatabase, pid: number): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const [row] = rowsOf<{ ok: boolean; pid: number }>(
      await db.execute(
        sql`SELECT pg_try_advisory_lock(${MIGRATE_LOCK}) AS ok, pg_backend_pid() AS pid`
      )
    )
    if (row?.pid !== pid) throw new Error(SESSION_LOST)
    if (row.ok) return true
    if (Date.now() > deadline) {
      throw new Error(
        `another host has held the migrations' lock for ${LOCK_WAIT_MS / 60_000} minutes: ` +
          'if none is migrating, a connection still holds it (pg_locks, advisory)'
      )
    }
    await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
  }
}

/**
 * The `pg` Pool's settings for `DATABASE_URL`, with `DATABASE_CA_CERT` (PEM) when the server's
 * certificate is signed by a CA Node does not trust (a managed Postgres's own, such as
 * DigitalOcean's): TLS then verifies against that CA. node-postgres lets the URL's `sslmode`
 * replace the TLS settings it is given, so a URL with any `ssl…` parameter beside it is refused
 * rather than verified less.
 */
export function pgPoolConfig(url: string, caCert?: string): pg.PoolConfig {
  const ca = caCert?.trim()
  if (!ca) return { connectionString: url }
  if (/[?&]ssl\w*=/i.test(url)) {
    throw new Error(
      'DATABASE_CA_CERT is set: leave sslmode and every other ssl… parameter out of DATABASE_URL'
    )
  }
  return { connectionString: url, ssl: { ca, rejectUnauthorized: true } }
}

/** A `pg` Pool as a Database. */
export function pgDatabase(pool: pg.Pool): Database {
  return {
    db: nodePg(pool) as unknown as FlingDatabase,
    // Drizzle's own pool transaction hands a connection whose ROLLBACK failed back to the pool,
    // and throws the ROLLBACK's error; here such a connection is discarded, and `fn`'s error (a
    // deadlock PostgresTable retries, say) is the one thrown.
    async transaction(fn) {
      const conn = await pool.connect()
      const tx = nodePg(conn) as unknown as FlingDatabase
      let broken: Error | undefined
      try {
        await tx.execute(sql`BEGIN ISOLATION LEVEL READ COMMITTED`)
        const result = await fn(tx)
        await tx.execute(sql`COMMIT`)
        return result
      } catch (err) {
        await tx.execute(sql`ROLLBACK`).catch((rollback: Error) => {
          broken = rollback
        })
        throw err
      } finally {
        conn.release(broken)
      }
    },
    async migrate(schema = DEFAULT_SCHEMA) {
      const conn = await pool.connect()
      let broken: Error | undefined
      try {
        const db = nodePg(conn)
        return await migrating(db as unknown as FlingDatabase, schema, config =>
          migrateNodePg(db, config)
        )
      } catch (err) {
        // A connection left mid-migration (its search_path or lock unknown) is discarded.
        broken = err as Error
        throw err
      } finally {
        conn.release(broken)
      }
    },
    close: () => pool.end(),
  }
}

/**
 * Each PGlite's migrations so far, one after another: PGlite is one session, which its advisory
 * lock can't keep two migrators of apart (each would set the other's search_path).
 */
const pgliteMigrations = new WeakMap<PGlite, Promise<unknown>>()

/** A PGlite database as a Database. PGlite is one connection, so it runs one query at a time. */
export function pgliteDatabase(lite: PGlite): Database {
  const db = pglite(lite)
  return {
    db: db as unknown as FlingDatabase,
    transaction: fn =>
      db.transaction(tx => fn(tx as unknown as FlingDatabase), {
        isolationLevel: 'read committed',
      }),
    migrate(schema = DEFAULT_SCHEMA) {
      const run = (pgliteMigrations.get(lite) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          migrating(db as unknown as FlingDatabase, schema, config => migratePglite(db, config))
        )
      pgliteMigrations.set(lite, run)
      return run
    },
    close: () => lite.close(),
  }
}
