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
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresFanout, pgliteNotifier } from '../src/live/postgres-fanout.ts'
import { ident, int, qualified } from '../src/table/ident.ts'
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

  it('refuses a schema name that is not a plain identifier, and quotes the rest', async () => {
    const db = await dbs.pglite()
    const hostile = [
      'x; DROP TABLE items',
      'x"; DROP TABLE items; --',
      'User',
      'Bad-Name',
      'a'.repeat(64),
      '',
    ]
    for (const schema of hostile) {
      await expect(migrateSchema(db, schema)).rejects.toThrow(/schema/)
      expect(() => new PostgresTable(db, { schema })).toThrow(/schema/)
      expect(() => new PostgresFanout(pgliteNotifier(db as never), { schema })).toThrow(/schema/)
    }
    expect(ident('user')).toBe('"user"')
    expect(() => ident('a"b')).toThrow(/identifier/)
    expect(qualified('public', 'items')).toBe('"public"."items"')
    expect(() => int(1.5)).toThrow(/integer/)
    // The live channel is `fling_live_<schema>`, an identifier too: 52 characters at most.
    expect(
      () => new PostgresFanout(pgliteNotifier(db as never), { schema: 's'.repeat(53) })
    ).toThrow(/identifier/)
    expect(await migrateSchema(db, 'a'.repeat(63))).toEqual(SCHEMA_MIGRATIONS.map(m => m.id))
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
    expect(await table.purgeExpired(0)).toBe(0)
  })

  it('keeps a schema whose name is a reserved word apart', async () => {
    const db = await dbs.pglite()
    await migrateSchema(db, 'user')
    const table = new PostgresTable(db, { schema: 'user' })
    await table.put({ pk: 'P', sk: 'A', v: 1 })
    expect(await table.get('P', 'A')).toEqual({ pk: 'P', sk: 'A', v: 1 })
  })

  it('stores a string jsonb cannot hold escaped, and only such items', async () => {
    const db = await dbs.pglite()
    const schema = await freshSchema(db)
    const table = new PostgresTable(db, { schema })
    await table.put({ pk: 'P', sk: 'odd', v: 'a\u0000b' })
    await table.put({ pk: 'P', sk: 'plain', v: 'ab' })
    const raw = await db.query<{ sk: string; data: unknown }>(
      `SELECT sk, data FROM "${schema}".items ORDER BY sk`
    )
    expect(raw.rows).toEqual([
      { sk: 'odd', data: { v: { '~fling~esc': 's', u: [97, 0, 98] } } },
      { sk: 'plain', data: { v: 'ab' } },
    ])
  })
})

describe.runIf(POSTGRES_URL)('PostgresTable purge against a writer (Postgres)', () => {
  it('keeps an item put again while the purge waited for it', async () => {
    const db = await dbs.postgres()
    let now = Date.parse('2030-01-01T00:00:00.000Z')
    const schema = await freshSchema(db)
    const table = new PostgresTable(db, { schema, now: () => now })
    await table.put({ pk: 'LEASE', sk: 'L', owner: 'a', expiresAt: '2030-01-01T00:01:00.000Z' })
    now += 120_000
    // A writer takes the dead lease (ifAbsent over it) and holds its row until it commits.
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 })
    const writer = await pool.connect()
    await writer.query('BEGIN')
    await writer.query(
      `UPDATE "${schema}".items SET data = '{"owner":"b","expiresAt":"2031-01-01T00:00:00.000Z"}', ` +
        `expires_at = $1 WHERE pk = 'LEASE' AND sk = 'L'`,
      [Date.parse('2031-01-01T00:00:00.000Z')]
    )
    const purge = table.purgeExpired()
    await new Promise(resolve => setTimeout(resolve, 200))
    await writer.query('COMMIT')
    writer.release()
    await pool.end()
    expect(await purge).toBe(0)
    expect(await table.get('LEASE', 'L')).toMatchObject({ owner: 'b' })
  })
})
