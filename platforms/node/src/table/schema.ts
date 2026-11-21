/**
 * The schema PostgresTable reads and writes, as numbered schema migrations applied in order. They
 * are the Postgres sibling of the D1 schema (platforms/cloudflare/migrations/*.sql); Fling's data
 * migrations (@fling/api/migrations) run on top. New record kinds need no schema migration. A
 * schema change is a new entry at the end, additive only; never edit one that has run.
 *
 * `migrateSchema` applies the ones a database lacks, recorded in `<schema>.fling_schema`. It holds
 * an advisory lock while it does, so hosts starting together apply each one once. It refuses a
 * database whose encoding is not UTF-8: `COLLATE "C"` is byte order only over UTF-8, and byte
 * order is the order the Table port promises.
 */
import { ident, isIdentifier } from './ident.ts'
import type { SqlClient } from './sql.ts'

export interface SchemaMigration {
  id: string
  sql: string
}

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: '0001_init',
    // Every item: `data` is the item without pk and sk (expiresAt included, as an attribute);
    // `expires_at` is its expiresAt in epoch ms (NULL: never), kept in a column so reads filter
    // dead items and the purge finds them. pk and sk compare with the "C" collation: their UTF-8
    // bytes, the order `compareSk` defines.
    sql: `
      CREATE TABLE items (
        pk text COLLATE "C" NOT NULL,
        sk text COLLATE "C" NOT NULL,
        data jsonb NOT NULL,
        expires_at bigint,
        PRIMARY KEY (pk, sk)
      );
      CREATE INDEX items_expires_at ON items (expires_at) WHERE expires_at IS NOT NULL;
    `,
  },
]

/** The default schema; an instance may use its own (`DATABASE_SCHEMA`). */
export const DEFAULT_SCHEMA = 'public'

/** A schema name the Table can use (`ident`'s rule), returned as it is. */
export function schemaName(schema: string): string {
  if (!isIdentifier(schema)) {
    throw new Error(`database schema must be lower-case letters, digits and _: ${schema}`)
  }
  return schema
}

/** Fixed key of the advisory lock schema migrations hold (any 64-bit number nothing else uses). */
const MIGRATE_LOCK = 7_316_843_257

/** Apply the schema migrations `schema` lacks; returns the ids applied. */
export async function migrateSchema(
  client: SqlClient,
  schema: string = DEFAULT_SCHEMA,
  migrations: SchemaMigration[] = SCHEMA_MIGRATIONS
): Promise<string[]> {
  schemaName(schema)
  const [encoding] = (await client.query<{ server_encoding: string }>('SHOW server_encoding')).rows
  if (encoding?.server_encoding !== 'UTF8') {
    throw new Error(`the database's encoding must be UTF8, not ${encoding?.server_encoding}`)
  }
  return client.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATE_LOCK])
    await tx.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`)
    await tx.query(
      `CREATE TABLE IF NOT EXISTS ${ident(schema)}.${ident('fling_schema')} ` +
        '(id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    )
    const done = new Set(
      (
        await tx.query<{ id: string }>(`SELECT id FROM ${ident(schema)}.${ident('fling_schema')}`)
      ).rows.map(r => r.id)
    )
    const applied: string[] = []
    for (const m of migrations) {
      if (done.has(m.id)) continue
      await tx.query(`SET LOCAL search_path TO ${ident(schema)}`)
      // The one multi-statement script: a constant of SCHEMA_MIGRATIONS (tests pass their own),
      // never text built from config or a request.
      await tx.exec(m.sql)
      await tx.query(`INSERT INTO ${ident(schema)}.${ident('fling_schema')} (id) VALUES ($1)`, [
        m.id,
      ])
      applied.push(m.id)
    }
    return applied
  })
}
