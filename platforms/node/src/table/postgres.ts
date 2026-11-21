/**
 * Postgres Table: one table `<schema>.items (pk, sk, data, expires_at)` (schema.ts), on a Postgres
 * server through `pg` or in process through PGlite (sql.ts). The sibling of the D1 Table.
 *
 * Order: pk and sk are `COLLATE "C"`, which compares their UTF-8 bytes, so `ORDER BY sk` is the
 * byte order `compareSk` defines. A prefix is `sk >= prefix AND starts_with(sk, prefix)`: the
 * first bound lets the primary key's index start at the prefix.
 *
 * Writes: every write is one transaction that first takes a transaction-scoped advisory lock on
 * each key it writes (a 64-bit hash of pk and sk, taken in ascending order so two writers never
 * wait on each other), then reads the live items at those keys, checks the conditions and writes.
 * Every writer of a key takes its lock, so between the check and the write nothing else writes
 * the key: of N concurrent `ifAbsent` puts, conditional deletes or transactions, one wins, and
 * concurrent `add`s all count. Readers take no lock; a transaction's writes become visible
 * together when it commits. A transaction Postgres aborts as a deadlock or serialisation failure
 * (a hash collision can order locks across keys) is retried. Conditions and patches are evaluated
 * in JS, the way MemoryTable evaluates them, so `1`, `'1'` and `true` stay distinct.
 *
 * Expiry: `expires_at` mirrors expiresAt in epoch ms; reads and conditions ignore dead items, and
 * `purgeExpired` (the host's maintenance tick) deletes them.
 */
import { createHash } from 'node:crypto'
import {
  type Condition,
  ConditionFailed,
  checkExpiresAt,
  decodeCursor,
  encodeCursor,
  type Key,
  type Page,
  type Patch,
  type QueryOptions,
  type ScanOptions,
  type Table,
  type TableItem,
  TRANSACT_MAX,
  type TransactOp,
} from '@fling/api/table'
import { DEFAULT_SCHEMA, schemaName } from './schema.ts'
import type { SqlClient, SqlQueryable } from './sql.ts'

type Row = { pk: string; sk: string; data: Record<string, unknown> }

/** SQLSTATEs of a transaction Postgres aborted that is safe to run again. */
const RETRYABLE = new Set(['40P01', '40001'])
const RETRIES = 5

const expiryOf = (expiresAt: unknown) =>
  typeof expiresAt === 'string' ? Date.parse(expiresAt) : null

const keyOf = (k: Key) => `${k.pk}\0${k.sk}`

/** The advisory lock id of a key: 64 bits of its SHA-256, as Postgres's signed bigint. */
const lockId = (k: Key) =>
  BigInt.asIntN(64, createHash('sha256').update(keyOf(k)).digest().readBigUInt64BE(0))

const fromRow = (row: Row): TableItem => ({ ...row.data, pk: row.pk, sk: row.sk })

/** The item's fields as stored: everything but pk and sk, `undefined` dropped. */
function dataOf(item: TableItem): string {
  checkExpiresAt(item.expiresAt)
  const { pk: _pk, sk: _sk, ...fields } = item
  return JSON.stringify(fields)
}

function holds(cond: Condition | undefined, item: TableItem | null): boolean {
  if (!cond) return true
  switch (cond.kind) {
    case 'ifAbsent':
      return item === null
    case 'ifExists':
      return item !== null
    case 'fieldEquals':
      if (item === null) return cond.orAbsent === true
      return item[cond.field] === cond.value
  }
}

function patched(item: TableItem, patch: Patch): TableItem {
  if (Object.keys(patch.add ?? {}).some(k => patch.set && k in patch.set)) {
    throw new Error('update: a field may not be in both set and add')
  }
  const next: Record<string, unknown> = { ...item }
  for (const [k, v] of Object.entries(patch.set ?? {})) {
    if (k === 'pk' || k === 'sk') continue
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  for (const [k, n] of Object.entries(patch.add ?? {})) {
    const current = next[k] ?? 0
    if (typeof current !== 'number') throw new Error(`add: ${k} is not a number`)
    next[k] = current + n
  }
  checkExpiresAt(next.expiresAt)
  return next as TableItem
}

/** `limit` checked, as the integer the query asks for one more than. */
function limitOf(limit: number | undefined) {
  if (limit === undefined) return undefined
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return limit
}

export interface PostgresTableOptions {
  /** the schema the items table is in (default `public`) */
  schema?: string
  /** the clock expiry follows (default `Date.now`) */
  now?: () => number
}

export class PostgresTable implements Table {
  private items: string
  private now: () => number

  constructor(
    private db: SqlClient,
    opts: PostgresTableOptions = {}
  ) {
    this.items = `${schemaName(opts.schema ?? DEFAULT_SCHEMA)}.items`
    this.now = opts.now ?? Date.now
  }

  /**
   * `fn` in one transaction holding the locks of `keys`, given the live items at them (by
   * `keyOf`). Retried when Postgres aborts it as a deadlock or serialisation failure.
   */
  private async writing<T>(
    keys: Key[],
    fn: (tx: SqlQueryable, live: Map<string, TableItem>) => Promise<T>
  ): Promise<T> {
    const locks = [...new Set(keys.map(lockId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async tx => {
          await tx.query('SELECT pg_advisory_xact_lock(id) FROM unnest($1::bigint[]) AS t(id)', [
            locks.map(String),
          ])
          const { rows } = await tx.query<Row>(
            `SELECT pk, sk, data FROM ${this.items} ` +
              'WHERE (pk, sk) IN (SELECT * FROM unnest($1::text[], $2::text[])) ' +
              'AND (expires_at IS NULL OR expires_at > $3)',
            [keys.map(k => k.pk), keys.map(k => k.sk), this.now()]
          )
          return fn(tx, new Map(rows.map(r => [keyOf(r), fromRow(r)])))
        })
      } catch (err) {
        const code = (err as { code?: unknown }).code
        if (attempt < RETRIES && typeof code === 'string' && RETRYABLE.has(code)) continue
        throw err
      }
    }
  }

  private async write(tx: SqlQueryable, item: TableItem) {
    await tx.query(
      `INSERT INTO ${this.items} (pk, sk, data, expires_at) VALUES ($1, $2, $3::jsonb, $4) ` +
        'ON CONFLICT (pk, sk) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at',
      [item.pk, item.sk, dataOf(item), expiryOf(item.expiresAt)]
    )
  }

  private async remove(tx: SqlQueryable, k: Key) {
    await tx.query(`DELETE FROM ${this.items} WHERE pk = $1 AND sk = $2`, [k.pk, k.sk])
  }

  async get(pk: string, sk: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT pk, sk, data FROM ${this.items} ` +
        'WHERE pk = $1 AND sk = $2 AND (expires_at IS NULL OR expires_at > $3)',
      [pk, sk, this.now()]
    )
    return rows[0] ? fromRow(rows[0]) : null
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    const params: unknown[] = [pk, this.now()]
    const where = ['pk = $1', '(expires_at IS NULL OR expires_at > $2)']
    if (opts.skPrefix) {
      params.push(opts.skPrefix)
      where.push(`sk >= $${params.length}`, `starts_with(sk, $${params.length})`)
    }
    if (opts.cursor !== undefined) {
      params.push(decodeCursor(opts.cursor))
      where.push(`sk ${opts.reverse ? '<' : '>'} $${params.length}`)
    }
    const { rows } = await this.db.query<Row>(
      `SELECT pk, sk, data FROM ${this.items} WHERE ${where.join(' AND ')} ` +
        `ORDER BY sk ${opts.reverse ? 'DESC' : 'ASC'}${limit ? ` LIMIT ${limit + 1}` : ''}`,
      params
    )
    return page(rows, limit, row => encodeCursor(row.sk))
  }

  /** In (pk, sk) byte order; the cursor is the last item's key. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    const params: unknown[] = [this.now()]
    const where = ['(expires_at IS NULL OR expires_at > $1)']
    if (opts.cursor !== undefined) {
      const [pk, sk] = JSON.parse(decodeCursor(opts.cursor)) as [string, string]
      params.push(pk, sk)
      where.push('(pk, sk) > ($2, $3)')
    }
    const { rows } = await this.db.query<Row>(
      `SELECT pk, sk, data FROM ${this.items} WHERE ${where.join(' AND ')} ` +
        `ORDER BY pk, sk${limit ? ` LIMIT ${limit + 1}` : ''}`,
      params
    )
    return page(rows, limit, row => encodeCursor(JSON.stringify([row.pk, row.sk])))
  }

  async put(item: TableItem, cond?: Condition) {
    dataOf(item)
    await this.writing([item], async (tx, live) => {
      if (!holds(cond, live.get(keyOf(item)) ?? null)) throw new ConditionFailed()
      await this.write(tx, item)
    })
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    return this.writing([{ pk, sk }], async (tx, live) => {
      const item = live.get(keyOf({ pk, sk })) ?? null
      if (!item || !holds(cond, item)) throw new ConditionFailed()
      const next = patched(item, patch)
      await this.write(tx, next)
      return next
    })
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    return this.writing([{ pk, sk }], async (tx, live) => {
      const item = live.get(keyOf({ pk, sk })) ?? null
      if (!holds(cond, item)) throw new ConditionFailed()
      await this.remove(tx, { pk, sk })
      return item
    })
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const keys = ops.map(op => ('put' in op ? op.put : op.delete))
    if (new Set(keys.map(keyOf)).size !== keys.length) {
      throw new Error('transact ops must be on distinct items')
    }
    if (ops.length === 0) return
    for (const op of ops) if ('put' in op) dataOf(op.put)
    await this.writing(keys, async (tx, live) => {
      // Every condition is checked against the state before the transaction, before any write.
      ops.forEach((op, index) => {
        if (!holds(op.cond, live.get(keyOf(keys[index] as Key)) ?? null)) {
          throw new ConditionFailed(index)
        }
      })
      for (const op of ops) {
        if ('put' in op) await this.write(tx, op.put)
        else await this.remove(tx, op.delete)
      }
    })
  }

  /**
   * Delete dead items, `batchSize` at a time, and return how many went. Reads already ignore them;
   * this only reclaims space. The host's maintenance tick calls it.
   */
  async purgeExpired(batchSize = 500): Promise<number> {
    let total = 0
    for (;;) {
      const { rows } = await this.db.query(
        `DELETE FROM ${this.items} WHERE (pk, sk) IN (SELECT pk, sk FROM ${this.items} ` +
          `WHERE expires_at IS NOT NULL AND expires_at <= $1 LIMIT ${Math.floor(batchSize)}) ` +
          'RETURNING 1',
        [this.now()]
      )
      total += rows.length
      if (rows.length < batchSize) return total
    }
  }
}

/** `rows` holds up to limit + 1: the extra one only says there is more. */
function page(rows: Row[], limit: number | undefined, cursor: (row: Row) => string): Page {
  const more = limit !== undefined && rows.length > limit
  const kept = more ? rows.slice(0, limit) : rows
  const last = kept[kept.length - 1]
  const items = kept.map(fromRow)
  return more && last ? { items, cursor: cursor(last) } : { items }
}
