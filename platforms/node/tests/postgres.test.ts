/**
 * The conformance suites against PostgresTable: on PGlite in every `pnpm gate`, and on a Postgres
 * server where FLING_TEST_POSTGRES_URL is set (CI), where the races run on concurrent connections.
 * Plus the migrations and the purge, which are this adapter's own.
 */
import { readFileSync } from 'node:fs'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import {
  migrationsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '@fling/conformance'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PostgresFanout, pgliteNotifier, pgNotifier } from '../src/live/postgres-fanout.ts'
import { type Database, pgDatabase, pgPoolConfig } from '../src/table/database.ts'
import { PostgresTable } from '../src/table/postgres.ts'
import { databases, freshSchema, POSTGRES_URL } from './services.ts'

const dbs = databases()
afterAll(() => dbs.close())

/** The migrations drizzle-kit generated. */
const JOURNAL = JSON.parse(
  readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')
) as { entries: { tag: string }[] }

const rows = async <R>(db: Database, query: ReturnType<typeof sql>) =>
  ((await db.db.execute(query)) as unknown as { rows: R[] }).rows

const suites = (name: string, open: () => Promise<Database>) => {
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

describe('PostgresTable migrations and purge', () => {
  it('applies each migration once, however often it runs', async () => {
    const db = await dbs.pglite()
    const schema = await freshSchema(db)
    expect(await db.migrate(schema)).toBe(0)
    const applied = await rows<{ hash: string }>(
      db,
      sql`SELECT hash FROM ${sql.identifier(schema)}.fling_migrations`
    )
    expect(applied).toHaveLength(JOURNAL.entries.length)
  })

  it('takes over a database whose items table was made before drizzle-kit, data and all', async () => {
    const db = await dbs.pglite()
    const schema = 'before_drizzle'
    const s = sql.identifier(schema)
    await db.db.execute(sql`CREATE SCHEMA ${s}`)
    await db.db.execute(
      sql`CREATE TABLE ${s}.items (pk text COLLATE "C" NOT NULL, sk text COLLATE "C" NOT NULL, data jsonb NOT NULL, expires_at bigint, PRIMARY KEY (pk, sk))`
    )
    await db.db.execute(
      sql`CREATE INDEX items_expires_at ON ${s}.items (expires_at) WHERE expires_at IS NOT NULL`
    )
    await db.db.execute(sql`INSERT INTO ${s}.items (pk, sk, data) VALUES ('P', 'A', '{"v":1}')`)
    expect(await db.migrate(schema)).toBe(JOURNAL.entries.length)
    const table = new PostgresTable(db, { schema })
    expect(await table.get('P', 'A')).toEqual({ pk: 'P', sk: 'A', v: 1 })
  })

  it('refuses a schema name that is not a plain identifier', async () => {
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
      await expect(db.migrate(schema)).rejects.toThrow(/schema/)
      expect(() => new PostgresTable(db, { schema })).toThrow(/schema/)
      expect(() => new PostgresFanout(pgliteNotifier(null as never), { schema })).toThrow(/schema/)
    }
    // The live channel is `fling_live_<schema>`, an identifier too: 52 characters at most.
    expect(
      () => new PostgresFanout(pgliteNotifier(null as never), { schema: 's'.repeat(53) })
    ).toThrow(/identifier/)
    expect(await db.migrate('a'.repeat(63))).toBe(JOURNAL.entries.length)
  })

  it('gives a transaction no transaction of its own (Postgres has no BEGIN inside BEGIN)', async () => {
    const db = await dbs.pglite()
    await db.transaction(async tx => {
      // @ts-expect-error: nesting must not compile
      void tx.transaction
    })
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
    await db.migrate('user')
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
    const raw = await rows<{ sk: string; data: unknown }>(
      db,
      sql`SELECT sk, data FROM ${sql.identifier(schema)}.items ORDER BY sk`
    )
    expect(raw).toEqual([
      {
        sk: 'odd',
        data: { '~fling~esc': 'item', d: { v: { '~fling~esc': 's', u: [97, 0, 98] } } },
      },
      { sk: 'plain', data: { v: 'ab' } },
    ])
  })
})

describe.runIf(POSTGRES_URL)('migrations beside another migrator (Postgres)', () => {
  it('waits for the lock another host holds, then migrates', async () => {
    const db = await dbs.postgres()
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 1 })
    const other = await pool.connect()
    await other.query('SELECT pg_advisory_lock(7316843257)')
    const schema = `t_lock_${Date.now()}`
    let done = false
    const migrating = db.migrate(schema).then(n => {
      done = true
      return n
    })
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(done).toBe(false)
    await other.query('SELECT pg_advisory_unlock(7316843257)')
    other.release()
    await pool.end()
    expect(await migrating).toBe(JOURNAL.entries.length)
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

/** A `pg` Pool whose one client answers `query` with `answer` (by the SQL's text): an error to throw, or rows. */
function fakePool(answer: (text: string) => unknown) {
  const client = {
    on: vi.fn(),
    release: vi.fn(),
    query: vi.fn(async (q: string | { text: string }) => {
      const out = answer(typeof q === 'string' ? q : q.text)
      if (out instanceof Error) throw out
      const rows = Array.isArray(out) ? out : []
      return { rows, fields: [], command: '', rowCount: rows.length }
    }),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
  return { pool, client }
}

describe('the pg driver', () => {
  it('discards a connection whose ROLLBACK failed, and throws the error that caused it', async () => {
    const rollback = new Error('connection lost')
    const { pool, client } = fakePool(text => (/rollback/i.test(text) ? rollback : null))
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' })
    await expect(
      pgDatabase(pool).transaction(async () => {
        throw deadlock
      })
    ).rejects.toBe(deadlock)
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ cause: rollback }))
  })

  it('refuses to migrate, taking no lock, when the session does not stick (a transaction pooler)', async () => {
    let pid = 0
    const sent: string[] = []
    const { pool, client } = fakePool(text => {
      sent.push(text)
      if (/server_encoding/.test(text)) return [{ server_encoding: 'UTF8' }]
      // Each statement on another server connection, its own search_path.
      if (/pg_backend_pid/.test(text)) return [{ pid: ++pid, path: '"$user", public' }]
      return null
    })
    await expect(pgDatabase(pool).migrate('s1')).rejects.toThrow(/session-mode/)
    expect(sent.some(t => /advisory_lock/.test(t))).toBe(false)
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it('destroys a listening connection whose LISTEN failed, and tries again only while listening', async () => {
    vi.useFakeTimers()
    try {
      const refused = new Error('LISTEN refused')
      const { pool, client } = fakePool(() => refused)
      const stop = await pgNotifier(pool).listen('fling_live_x', () => {})
      expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ cause: refused }))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(client.release).toHaveBeenCalledTimes(2)
      await stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(client.release).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the pg pool settings', () => {
  const url = 'postgres://fling:pw@db.example.test:25060/fling'
  const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

  it('verifies TLS against DATABASE_CA_CERT when it is set, and is the URL alone otherwise', () => {
    expect(pgPoolConfig(url)).toEqual({ connectionString: url })
    expect(pgPoolConfig(url, '  ')).toEqual({ connectionString: url })
    expect(pgPoolConfig(url, ca).ssl).toEqual({ ca, rejectUnauthorized: true })
  })

  it('refuses a URL whose sslmode would replace the CA', () => {
    expect(() => pgPoolConfig(`${url}?sslmode=require`, ca)).toThrow(/sslmode/)
  })
})
