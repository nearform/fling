/**
 * The Postgres database the Node platform keeps its Table in, as Drizzle sees it, on one of two
 * drivers: a `pg` Pool (`pgDatabase`: a Postgres server, managed or self-hosted) and PGlite
 * (`pgliteDatabase`: Postgres compiled to WebAssembly, in process, which the tests and the local
 * runtime use). PostgresTable is written once over `FlingDatabase`, what both drivers give.
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

export interface Database {
  db: FlingDatabase
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
  await db.execute(sql`SELECT pg_advisory_lock(${MIGRATE_LOCK})`)
  try {
    const before = await migrations(db, name)
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(name)}`)
    await db.execute(sql`SET search_path TO ${sql.identifier(name)}`)
    await run({
      migrationsFolder: MIGRATIONS,
      migrationsSchema: name,
      migrationsTable: MIGRATIONS_TABLE,
    })
    return (await migrations(db, name)) - before
  } finally {
    await db.execute(sql`RESET search_path`)
    await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK})`)
  }
}

/** A `pg` Pool as a Database. */
export function pgDatabase(pool: pg.Pool): Database {
  return {
    db: nodePg(pool) as unknown as FlingDatabase,
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

/** A PGlite database as a Database. PGlite is one connection, so it runs one query at a time. */
export function pgliteDatabase(lite: PGlite): Database {
  const db = pglite(lite)
  return {
    db: db as unknown as FlingDatabase,
    migrate: (schema = DEFAULT_SCHEMA) =>
      migrating(db as unknown as FlingDatabase, schema, config => migratePglite(db, config)),
    close: () => lite.close(),
  }
}
