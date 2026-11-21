/**
 * The Postgres schema PostgresTable reads and writes, as Drizzle tables. drizzle-kit generates the
 * migrations from `items` (drizzle.config.ts → drizzle/), and database.ts applies them into the
 * instance's own schema (`DATABASE_SCHEMA`); `itemsIn` is the same table in that schema, for
 * queries. The Postgres sibling of the D1 schema (platforms/cloudflare/migrations/*.sql); Fling's
 * data migrations (@fling/api/migrations) run on top. New record kinds need no schema change.
 *
 * Every item is one row: `data` is the item without pk and sk (expiresAt included, as an
 * attribute); `expires_at` is its expiresAt in epoch ms (NULL: never), kept in a column so reads
 * filter dead items and the purge finds them. pk and sk compare with the "C" collation: their
 * UTF-8 bytes, the order `compareSk` defines (database.ts refuses a database not in UTF-8).
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  customType,
  index,
  jsonb,
  type PgTableFn,
  pgSchema,
  pgTable,
  primaryKey,
} from 'drizzle-orm/pg-core'

/** text compared by its bytes: `COLLATE "C"`. */
const bytewise = customType<{ data: string }>({ dataType: () => 'text COLLATE "C"' })

const columns = () => ({
  pk: bytewise('pk').notNull(),
  sk: bytewise('sk').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
})

const define = <S extends string | undefined>(table: PgTableFn<S>) =>
  table('items', columns(), t => [
    primaryKey({ name: 'items_pkey', columns: [t.pk, t.sk] }),
    index('items_expires_at').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
  ])

/** The table as drizzle-kit sees it: in no schema, so its migrations name none. */
export const items = define(pgTable)

/** The default schema; an instance may use its own (`DATABASE_SCHEMA`). */
export const DEFAULT_SCHEMA = 'public'

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * A schema name an instance may configure, returned as it is: lower-case letters, digits and `_`,
 * at most 63 (Postgres's limit). Drizzle quotes it wherever it appears; the rule keeps a
 * configuration mistake from becoming a schema nobody meant.
 */
export function schemaName(schema: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`database schema must be lower-case letters, digits and _: ${schema}`)
  }
  return schema
}

/** `items` in `schema`. */
export function itemsIn(schema: string) {
  const name = schemaName(schema)
  return name === DEFAULT_SCHEMA ? items : define(pgSchema(name).table)
}

export type ItemsTable = ReturnType<typeof itemsIn>
