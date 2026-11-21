/**
 * The conformance suites against PostgresTable: on PGlite in every `pnpm gate`, and on a Postgres
 * server where FLING_TEST_POSTGRES_URL is set (CI), where the races run on concurrent connections.
 * Plus the schema migrations and the purge, which are this adapter's own.
 */
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import {
  migrationsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '@fling/conformance'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresTable } from '../src/table/postgres.ts'
import { migrateSchema, SCHEMA_MIGRATIONS } from '../src/table/schema.ts'
import type { SqlClient } from '../src/table/sql.ts'
import { databases, freshSchema, POSTGRES_URL } from './services.ts'

const dbs = databases()
afterAll(() => dbs.close())

const suites = (name: string, open: () => Promise<SqlClient>) => {
  let shared: Promise<string> | undefined
  const table = async () => {
    const db = await open()
    shared ??= freshSchema(db)
    return new PostgresTable(db, { schema: await shared })
  }
  tableConformance(name, table)
  storeConformance(`Records on ${name}`, async () => new Records(await table()))
  // Migrations scan the whole table: an empty one per test.
  migrationsConformance(name, async () => {
    const db = await open()
    return new PostgresTable(db, { schema: await freshSchema(db) })
  })
  routeTableConformance(
    `TableRouteTable on ${name}`,
    async () => new TableRouteTable(await table())
  )
}

suites('PostgresTable (PGlite)', dbs.pglite)
if (POSTGRES_URL) suites('PostgresTable (Postgres)', dbs.postgres)

describe('PostgresTable schema and purge', () => {
  it('applies each schema migration once, however often it runs', async () => {
    const db = await dbs.pglite()
    const schema = await freshSchema(db)
    expect(await migrateSchema(db, schema)).toEqual([])
    const ids = (await db.query<{ id: string }>(`SELECT id FROM ${schema}.fling_schema`)).rows
    expect(ids.map(r => r.id).sort()).toEqual(SCHEMA_MIGRATIONS.map(m => m.id).sort())
  })

  it('refuses a schema name it cannot inline', async () => {
    const db = await dbs.pglite()
    await expect(migrateSchema(db, 'x; DROP TABLE items')).rejects.toThrow(/schema/)
    expect(() => new PostgresTable(db, { schema: 'Bad-Name' })).toThrow(/schema/)
  })

  it('purges dead items and keeps the rest', async () => {
    const db = await dbs.pglite()
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    const table = new PostgresTable(db, { schema: await freshSchema(db), now: () => now })
    await table.put({ pk: 'P', sk: 'dead', expiresAt: '2030-01-01T00:01:00.000Z' })
    await table.put({ pk: 'P', sk: 'later', expiresAt: '2031-01-01T00:00:00.000Z' })
    await table.put({ pk: 'P', sk: 'kept' })
    now += 120_000
    expect(await table.purgeExpired(1)).toBe(1)
    expect(await table.purgeExpired()).toBe(0)
    expect((await table.query('P')).items.map(i => i.sk)).toEqual(['kept', 'later'])
  })
})
