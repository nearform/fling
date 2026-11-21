/**
 * The databases the Postgres suites run against: PGlite (Postgres in process, always) and, when
 * FLING_TEST_POSTGRES_URL is set, a Postgres server (CI starts one, ci.yml). To run the server
 * suites locally:
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=fling-test postgres:17
 *   FLING_TEST_POSTGRES_URL=postgres://postgres:fling-test@localhost:5432/postgres \
 *     pnpm --filter @fling/platform-node test
 *
 * Each call gets a schema of its own, named per run, so suites that need an empty table (the data
 * migrations) have one and runs never meet.
 */
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { migrateSchema } from '../src/table/schema.ts'
import { pgClient, pgliteClient, type SqlClient } from '../src/table/sql.ts'

export const POSTGRES_URL = process.env.FLING_TEST_POSTGRES_URL

const run = randomUUID().slice(0, 8)
let schemas = 0

/** A database client of each kind, opened once per test file. */
export interface Databases {
  pglite: () => Promise<SqlClient>
  postgres: () => Promise<SqlClient>
  close(): Promise<void>
}

export function databases(): Databases {
  let lite: SqlClient | undefined
  let server: SqlClient | undefined
  return {
    async pglite() {
      lite ??= pgliteClient(await PGlite.create())
      return lite
    },
    async postgres() {
      server ??= pgClient(new pg.Pool({ connectionString: POSTGRES_URL, max: 20 }))
      return server
    },
    async close() {
      await Promise.all([lite?.close(), server?.close()])
    },
  }
}

/** A new schema with the items table in it. */
export async function freshSchema(db: SqlClient): Promise<string> {
  const schema = `t_${run}_${schemas++}`
  await migrateSchema(db, schema)
  return schema
}
