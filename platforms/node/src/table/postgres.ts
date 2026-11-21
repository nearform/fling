/**
 * Postgres Table: one table `<schema>.items (pk, sk, data, expires_at)` (items.ts), through Drizzle
 * on a Postgres server (`pg`) or in process (PGlite) (database.ts). The sibling of the D1 Table.
 *
 * Order: pk and sk are `COLLATE "C"`, which compares their UTF-8 bytes, so `ORDER BY sk` is the
 * byte order `compareSk` defines. A prefix is `sk >= prefix AND starts_with(sk, prefix)`: the
 * first bound lets the primary key's index start at the prefix.
 *
 * Writes: every write is one READ COMMITTED transaction that first takes a transaction-scoped
 * advisory lock on each key it writes (a 64-bit hash of pk and sk, taken in ascending order so two
 * writers never wait on each other), then reads the live items at those keys, checks the
 * conditions and writes. Every writer of a key takes its lock, so between the check and the write
 * nothing else writes the key: of N concurrent `ifAbsent` puts, conditional deletes or
 * transactions, one wins, and concurrent `add`s all count. READ COMMITTED, whatever the server's
 * default, because the read after the lock must see what committed before it. Readers take no
 * lock; a transaction's writes become visible together when it commits. A transaction Postgres
 * aborts as a deadlock or serialisation failure (a hash collision can order locks across keys) is
 * retried after a jittered pause. Conditions and patches are evaluated in JS, the way MemoryTable
 * evaluates them, so `1`, `'1'` and `true` stay distinct.
 *
 * Expiry: `expires_at` mirrors expiresAt in epoch ms; reads and conditions ignore dead items, and
 * `purgeExpired` (the host's maintenance tick) deletes them, checking each one is still dead as it
 * deletes it, so an item put again meanwhile stays.
 *
 * SQL: Drizzle's query builder writes every statement it can, with values as parameters. The `sql`
 * template (whose values are parameters too) writes the rest: the advisory lock, `starts_with`, a
 * `::jsonb` cast and the purge's `(pk, sk) IN (…)`. tests/sql-guard.test.ts keeps it that way.
 *
 * Strings: jsonb holds neither NUL nor a lone surrogate, which the other backends store. A string
 * (value or field name) holding one is stored as `{"~fling~esc": "s", "u": [its UTF-16 code
 * units]}`, and an object whose field names need it, or that has a `~fling~esc` field of its own,
 * as `{"~fling~esc": "o", "e": [[name, value], …]}`, and the whole item is then stored as
 * `{"~fling~esc": "item", "d": …}`, the marker reads look for; reads undo it. Only items that need
 * it pay for it, on write and on read. Keys are never escaped (that would change their order): one
 * that isn't `storableKey` reads as absent, as on every backend, and a cursor holding a NUL is
 * compared up to the NUL, which orders the same against keys that hold none.
 */
import { createHash } from 'node:crypto'
import {
  type Condition,
  ConditionFailed,
  checkExpiresAt,
  checkKey,
  decodeCursor,
  encodeCursor,
  holdsWhenAbsent,
  type Key,
  type Page,
  type Patch,
  type QueryOptions,
  type ScanOptions,
  storable,
  storableKey,
  type Table,
  type TableItem,
  TRANSACT_MAX,
  type TransactOp,
} from '@fling/api/table'
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { Database, FlingDatabase } from './database.ts'
import { DEFAULT_SCHEMA, type ItemsTable, itemsIn } from './items.ts'

type Row = { pk: string; sk: string; data: Record<string, unknown> }

/** SQLSTATEs of a transaction Postgres aborted that is safe to run again. */
const RETRYABLE = new Set(['40P01', '40001'])
const RETRIES = 5
/** The first retry's pause; each one after waits up to twice as long, at random (full jitter). */
const BACKOFF_MS = 5

const pause = (attempt: number) =>
  new Promise(resolve => setTimeout(resolve, Math.random() * BACKOFF_MS * 2 ** attempt))

/** The field (`~fling~esc`) that marks a string or an object stored escaped (see the header). */
const ESC = '~fling~esc'
/** NUL or a lone surrogate: what a key may not hold, and what jsonb can't. */
const needsEscape = (s: string) => !storableKey(s)
/** What the JSON of an item that may need escaping holds: a NUL, a surrogate escape, or ESC. */
const MAY_NEED_ESCAPE = /\\u0000|\\ud[89a-f]|~fling~esc/i

function escaped(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!needsEscape(value)) return value
    return { [ESC]: 's', u: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) }
  }
  if (Array.isArray(value)) return value.map(v => (v === undefined ? null : escaped(v)))
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.some(([k]) => k === ESC || needsEscape(k))) {
    return { [ESC]: 'o', e: entries.map(([k, v]) => [escaped(k), escaped(v)]) }
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, escaped(v)]))
}

function unescaped(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unescaped)
  if (value === null || typeof value !== 'object') return value
  const v = value as Record<string, unknown>
  if (v[ESC] === 's' && Array.isArray(v.u)) {
    let out = ''
    for (let i = 0; i < v.u.length; i += 4096) {
      out += String.fromCharCode(...(v.u.slice(i, i + 4096) as number[]))
    }
    return out
  }
  if (v[ESC] === 'o' && Array.isArray(v.e)) {
    return Object.fromEntries(
      (v.e as [unknown, unknown][]).map(([k, x]) => [unescaped(k) as string, unescaped(x)])
    )
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unescaped(x)]))
}

/** A cursor's sk as Postgres can compare it: up to its first NUL, if it has one. */
function cursorBound(
  sk: string,
  reverse: boolean | undefined
): { op: typeof gt | typeof lt | typeof lte; sk: string } {
  const nul = sk.indexOf('\0')
  if (nul === -1) return { op: reverse ? lt : gt, sk }
  // No stored sk holds a NUL, so `> a\0…` is `> a`, and `< a\0…` is `<= a`.
  return { op: reverse ? lte : gt, sk: sk.slice(0, nul) }
}

const expiryOf = (expiresAt: unknown) =>
  typeof expiresAt === 'string' ? Date.parse(expiresAt) : null

const keyOf = (k: Key) => `${k.pk}\0${k.sk}`

/** The advisory lock id of a key: 64 bits of its SHA-256, as Postgres's signed bigint. */
const lockId = (k: Key) =>
  BigInt.asIntN(64, createHash('sha256').update(keyOf(k)).digest().readBigUInt64BE(0))

const fromRow = (row: Row): TableItem => {
  // Only an escaped item has ESC at its top (dataOf): every other row is read as it is.
  const fields = row.data[ESC] === 'item' ? (unescaped(row.data.d) as Row['data']) : row.data
  return { ...fields, pk: row.pk, sk: row.sk }
}

/** The item's fields as stored, as JSON: everything but pk and sk, `undefined` dropped. */
function dataOf(item: TableItem): string {
  checkExpiresAt(item.expiresAt)
  const { pk: _pk, sk: _sk, ...fields } = item
  const json = JSON.stringify(fields)
  return MAY_NEED_ESCAPE.test(json) ? JSON.stringify({ [ESC]: 'item', d: escaped(fields) }) : json
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

/** `limit` checked. */
function limitOf(limit: number | undefined) {
  if (limit === undefined) return undefined
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return limit
}

/** The SQLSTATE of a failed query: Drizzle wraps the driver's error (`cause`). */
function sqlState(err: unknown): string | undefined {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

export interface PostgresTableOptions {
  /** the schema the items table is in (default `public`) */
  schema?: string
  /** the clock expiry follows (default `Date.now`) */
  now?: () => number
}

export class PostgresTable implements Table {
  private items: ItemsTable
  private now: () => number

  constructor(
    private database: Database,
    opts: PostgresTableOptions = {}
  ) {
    this.items = itemsIn(opts.schema ?? DEFAULT_SCHEMA)
    this.now = opts.now ?? Date.now
  }

  private columns() {
    return { pk: this.items.pk, sk: this.items.sk, data: this.items.data }
  }

  /** Not expired at `now`. */
  private live(): SQL {
    return or(isNull(this.items.expiresAt), gt(this.items.expiresAt, this.now())) as SQL
  }

  private at(k: Key): SQL {
    return and(eq(this.items.pk, k.pk), eq(this.items.sk, k.sk)) as SQL
  }

  /**
   * `fn` in one transaction holding the locks of `keys`, given the live items at them (by
   * `keyOf`). Retried when Postgres aborts it as a deadlock or serialisation failure.
   */
  private async writing<T>(
    keys: Key[],
    fn: (tx: FlingDatabase, live: Map<string, TableItem>) => Promise<T>
  ): Promise<T> {
    const locks = [...new Set(keys.map(lockId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.database.transaction(async tx => {
          for (const id of locks) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${String(id)}::bigint)`)
          }
          const rows = await tx
            .select(this.columns())
            .from(this.items)
            .where(and(or(...keys.map(k => this.at(k))), this.live()))
          return fn(tx, new Map(rows.map(r => [keyOf(r), fromRow(r)])))
        })
      } catch (err) {
        const code = sqlState(err)
        if (attempt < RETRIES && code !== undefined && RETRYABLE.has(code)) {
          await pause(attempt)
          continue
        }
        throw err
      }
    }
  }

  private async write(tx: FlingDatabase, item: TableItem) {
    await tx
      .insert(this.items)
      .values({
        pk: item.pk,
        sk: item.sk,
        data: sql`${dataOf(item)}::jsonb`,
        expiresAt: expiryOf(item.expiresAt),
      })
      .onConflictDoUpdate({
        target: [this.items.pk, this.items.sk],
        set: { data: sql`excluded.data`, expiresAt: sql`excluded.expires_at` },
      })
  }

  private async remove(tx: FlingDatabase, k: Key) {
    await tx.delete(this.items).where(this.at(k))
  }

  async get(pk: string, sk: string) {
    if (!storable({ pk, sk })) return null
    const [row] = await this.database.db
      .select(this.columns())
      .from(this.items)
      .where(and(this.at({ pk, sk }), this.live()))
    return row ? fromRow(row) : null
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    if (!storableKey(pk) || !storableKey(opts.skPrefix ?? '')) return { items: [] }
    const where: SQL[] = [eq(this.items.pk, pk), this.live()]
    if (opts.skPrefix) {
      where.push(
        gte(this.items.sk, opts.skPrefix),
        sql`starts_with(${this.items.sk}, ${opts.skPrefix})`
      )
    }
    if (opts.cursor !== undefined) {
      const bound = cursorBound(decodeCursor(opts.cursor), opts.reverse)
      where.push(bound.op(this.items.sk, bound.sk))
    }
    const q = this.database.db
      .select(this.columns())
      .from(this.items)
      .where(and(...where))
      .orderBy(opts.reverse ? desc(this.items.sk) : asc(this.items.sk))
    const rows = limit ? await q.limit(limit + 1) : await q
    return page(rows, limit, row => encodeCursor(row.sk))
  }

  /** In (pk, sk) byte order; the cursor is the last item's key. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    const where: SQL[] = [this.live()]
    if (opts.cursor !== undefined) {
      const [pk, sk] = JSON.parse(decodeCursor(opts.cursor)) as [string, string]
      where.push(
        or(gt(this.items.pk, pk), and(eq(this.items.pk, pk), gt(this.items.sk, sk))) as SQL
      )
    }
    const q = this.database.db
      .select(this.columns())
      .from(this.items)
      .where(and(...where))
      .orderBy(asc(this.items.pk), asc(this.items.sk))
    const rows = limit ? await q.limit(limit + 1) : await q
    return page(rows, limit, row => encodeCursor(JSON.stringify([row.pk, row.sk])))
  }

  async put(item: TableItem, cond?: Condition) {
    checkKey(item)
    dataOf(item)
    await this.writing([item], async (tx, live) => {
      if (!holds(cond, live.get(keyOf(item)) ?? null)) throw new ConditionFailed()
      await this.write(tx, item)
    })
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    if (!storable({ pk, sk })) throw new ConditionFailed()
    return this.writing([{ pk, sk }], async (tx, live) => {
      const item = live.get(keyOf({ pk, sk })) ?? null
      if (!item || !holds(cond, item)) throw new ConditionFailed()
      const next = patched(item, patch)
      await this.write(tx, next)
      return next
    })
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    if (!storable({ pk, sk })) {
      if (!holdsWhenAbsent(cond)) throw new ConditionFailed()
      return null
    }
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
    for (const k of keys) checkKey(k)
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
   * this only reclaims space. The host's maintenance tick calls it. The DELETE checks expiry again
   * on each row it deletes: an item put again since the subquery read it (an `ifAbsent` over a
   * dead lease) is live, and stays.
   */
  async purgeExpired(batchSize = 500): Promise<number> {
    const size = Math.max(1, Math.floor(batchSize) || 1)
    const { pk, sk, expiresAt } = this.items
    let total = 0
    for (;;) {
      const dead = () => and(isNotNull(expiresAt), lte(expiresAt, this.now())) as SQL
      const batch = this.database.db.select({ pk, sk }).from(this.items).where(dead()).limit(size)
      const rows = await this.database.db
        .delete(this.items)
        .where(and(sql`(${pk}, ${sk}) IN ${batch}`, dead()))
        .returning({ pk })
      total += rows.length
      if (rows.length < size) return total
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
