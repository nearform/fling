/**
 * The little of a Postgres client PostgresTable needs: parameterised queries, multi-statement
 * scripts (the schema migrations) and a transaction on one connection. Two clients implement it:
 * a `pg` Pool (`pgClient`: a Postgres server, managed or self-hosted) and PGlite (`pgliteClient`:
 * Postgres compiled to WebAssembly, in process, which the tests and the local runtime use). Both
 * speak the same SQL with `$1` placeholders and answer `{ rows }`, so the adapter is written once.
 */
import type { PGlite, Transaction } from '@electric-sql/pglite'
import type pg from 'pg'

export interface SqlQueryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  /** statements separated by `;`, no parameters */
  exec(sql: string): Promise<void>
}

export interface SqlClient extends SqlQueryable {
  /** `fn` in one transaction on one connection: committed when it resolves, rolled back when it throws */
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>
  /** release the connections (a pool's, or PGlite's database) */
  close(): Promise<void>
}

const onConnection = (c: pg.PoolClient | pg.Pool): SqlQueryable => ({
  query: async <R>(sql: string, params?: unknown[]) => ({
    rows: (await c.query(sql, params as unknown[])).rows as R[],
  }),
  exec: async sql => void (await c.query(sql)),
})

/** A `pg` Pool as an SqlClient. */
export function pgClient(pool: pg.Pool): SqlClient {
  return {
    ...onConnection(pool),
    async transaction(fn) {
      const conn = await pool.connect()
      try {
        await conn.query('BEGIN')
        const result = await fn(onConnection(conn))
        await conn.query('COMMIT')
        return result
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        conn.release()
      }
    },
    close: () => pool.end(),
  }
}

const onPglite = (db: PGlite | Transaction): SqlQueryable => ({
  query: async <R>(sql: string, params?: unknown[]) => ({
    rows: (await db.query<R>(sql, params)).rows,
  }),
  exec: async sql => void (await db.exec(sql)),
})

/** A PGlite database as an SqlClient. PGlite runs one transaction at a time. */
export function pgliteClient(db: PGlite): SqlClient {
  return {
    ...onPglite(db),
    transaction: fn => db.transaction(tx => fn(onPglite(tx))),
    close: () => db.close(),
  }
}
