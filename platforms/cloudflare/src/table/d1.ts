/**
 * D1 Table: one SQL table `items (pk, sk, data, expires_at)` (migrations/0001_init.sql). `data` is
 * the item's JSON without pk/sk; `expires_at` mirrors expiresAt in epoch ms so reads filter dead
 * items in SQL and `purgeExpired` (the Worker's cron) can delete them.
 *
 * Order: pk and sk are TEXT with BINARY collation, which SQLite compares with memcmp over the UTF-8
 * bytes, so `ORDER BY sk` is the byte order `compareSk` defines. A prefix is the range
 * `[prefix, prefix || x'FF')`: 0xFF never occurs in UTF-8, so every extension of the prefix sorts
 * below the upper bound.
 *
 * Conditions: a conditional write is a D1 `batch()` (one SQL transaction, rolled back when any
 * statement fails) of guard statements followed by the writes. A guard is
 * `INSERT INTO conditions (ok) SELECT <condition>`, whose trigger raises when the condition is
 * false, so the whole batch is rolled back: that is how `transact` writes all or nothing, and why a
 * single put/update/delete can't race between its check and its write (D1 runs one batch at a
 * time). Field conditions compare `json_type` too, so `1`, `'1'` and `true` stay distinct.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import {
  type Condition,
  ConditionFailed,
  checkExpiresAt,
  decodeCursor,
  encodeCursor,
  type Page,
  type Patch,
  type QueryOptions,
  type Scalar,
  type ScanOptions,
  type Table,
  type TableItem,
  TRANSACT_MAX,
  type TransactOp,
} from '@fling/api/table'

/** The message of the `conditions_check` trigger (migrations/0001_init.sql). */
const CONDITION_FAILED = 'fling: condition failed'

type Row = { pk?: string; sk: string; data: string; expires_at?: number | null }

const expiryOf = (expiresAt: unknown) =>
  typeof expiresAt === 'string' ? Date.parse(expiresAt) : null

/** A JSON path for a top-level field, inlined into SQL (field names are code, never input). */
function path(field: string) {
  if (!/^[A-Za-z0-9_$-]+$/.test(field)) throw new Error(`D1Table: unsupported field name ${field}`)
  return `'$."${field}"'`
}

const fromRow = (pk: string, row: Row): TableItem => ({ ...JSON.parse(row.data), pk, sk: row.sk })

function toRow(item: TableItem) {
  checkExpiresAt(item.expiresAt)
  const { pk, sk, ...fields } = item
  return { pk, sk, data: JSON.stringify(fields), expiresAt: expiryOf(item.expiresAt) }
}

/** `limit` inlined as an integer literal (a bound JS number may arrive as REAL). */
function limitSql(limit: number | undefined) {
  if (limit === undefined) return ''
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return ` LIMIT ${limit + 1}`
}

const isConditionFailed = (err: unknown) =>
  err instanceof Error && err.message.includes(CONDITION_FAILED)

export class D1Table implements Table {
  constructor(
    private db: D1Database,
    private now: () => number = Date.now
  ) {}

  /** SQL true when the live item at (pk, sk) exists and `where` (over its row) holds. */
  private live(pk: string, sk: string, where = '', params: unknown[] = []) {
    return {
      sql:
        'EXISTS (SELECT 1 FROM items WHERE pk = ? AND sk = ? AND ' +
        `(expires_at IS NULL OR expires_at > ?)${where ? ` AND ${where}` : ''})`,
      params: [pk, sk, this.now(), ...params],
    }
  }

  /** SQL true when `cond` holds for the item at (pk, sk). */
  private holds(pk: string, sk: string, cond: Condition): { sql: string; params: unknown[] } {
    switch (cond.kind) {
      case 'ifExists':
        return this.live(pk, sk)
      case 'ifAbsent': {
        const live = this.live(pk, sk)
        return { sql: `NOT ${live.sql}`, params: live.params }
      }
      case 'fieldEquals': {
        const match = fieldMatch(cond.field, cond.value)
        const live = this.live(pk, sk, match.sql, match.params)
        if (!cond.orAbsent) return live
        const any = this.live(pk, sk)
        return { sql: `(${live.sql} OR NOT ${any.sql})`, params: [...live.params, ...any.params] }
      }
    }
  }

  private guard(pk: string, sk: string, cond: Condition): D1PreparedStatement {
    const { sql, params } = this.holds(pk, sk, cond)
    return this.db.prepare(`INSERT INTO conditions (ok) SELECT ${sql}`).bind(...params)
  }

  private replace(item: TableItem): D1PreparedStatement {
    const row = toRow(item)
    return this.db
      .prepare('INSERT OR REPLACE INTO items (pk, sk, data, expires_at) VALUES (?, ?, ?, ?)')
      .bind(row.pk, row.sk, row.data, row.expiresAt)
  }

  private remove(pk: string, sk: string): D1PreparedStatement {
    return this.db
      .prepare('DELETE FROM items WHERE pk = ? AND sk = ? RETURNING sk, data, expires_at')
      .bind(pk, sk)
  }

  /** Run `statements` as one transaction; a guard that fails becomes ConditionFailed. */
  private async batch(statements: D1PreparedStatement[]) {
    try {
      return await this.db.batch<Row>(statements)
    } catch (err) {
      if (isConditionFailed(err)) throw new ConditionFailed()
      throw err
    }
  }

  async get(pk: string, sk: string) {
    const row = await this.db
      .prepare(
        'SELECT sk, data FROM items WHERE pk = ? AND sk = ? AND (expires_at IS NULL OR expires_at > ?)'
      )
      .bind(pk, sk, this.now())
      .first<Row>()
    return row ? fromRow(pk, row) : null
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const where = ['pk = ?', '(expires_at IS NULL OR expires_at > ?)']
    const params: unknown[] = [pk, this.now()]
    if (opts.skPrefix) {
      where.push("sk >= ? AND sk < ? || x'FF'")
      params.push(opts.skPrefix, opts.skPrefix)
    }
    if (opts.cursor !== undefined) {
      where.push(opts.reverse ? 'sk < ?' : 'sk > ?')
      params.push(decodeCursor(opts.cursor))
    }
    const order = opts.reverse ? 'DESC' : 'ASC'
    const { results } = await this.db
      .prepare(
        `SELECT sk, data FROM items WHERE ${where.join(' AND ')} ORDER BY sk ${order}` +
          limitSql(opts.limit)
      )
      .bind(...params)
      .all<Row>()
    return this.page(
      results,
      opts.limit,
      row => encodeCursor(row.sk),
      row => fromRow(pk, row)
    )
  }

  /** In (pk, sk) byte order; the cursor is the last item's key. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const where = ['(expires_at IS NULL OR expires_at > ?)']
    const params: unknown[] = [this.now()]
    if (opts.cursor !== undefined) {
      const [pk, sk] = JSON.parse(decodeCursor(opts.cursor)) as [string, string]
      where.push('(pk, sk) > (?, ?)')
      params.push(pk, sk)
    }
    const { results } = await this.db
      .prepare(
        `SELECT pk, sk, data FROM items WHERE ${where.join(' AND ')} ORDER BY pk, sk` +
          limitSql(opts.limit)
      )
      .bind(...params)
      .all<Row>()
    return this.page(
      results,
      opts.limit,
      row => encodeCursor(JSON.stringify([row.pk, row.sk])),
      row => fromRow(row.pk as string, row)
    )
  }

  /** `rows` holds up to limit + 1: the extra one only says there is more. */
  private page(
    rows: Row[],
    limit: number | undefined,
    cursor: (row: Row) => string,
    item: (row: Row) => TableItem
  ): Page {
    const more = limit !== undefined && rows.length > limit
    const kept = more ? rows.slice(0, limit) : rows
    const last = kept[kept.length - 1]
    return more && last
      ? { items: kept.map(item), cursor: cursor(last) }
      : { items: kept.map(item) }
  }

  async put(item: TableItem, cond?: Condition) {
    const write = this.replace(item)
    if (!cond) await write.run()
    else await this.batch([this.guard(item.pk, item.sk, cond), write])
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    const set = Object.entries(patch.set ?? {}).filter(([k]) => k !== 'pk' && k !== 'sk')
    const add = Object.entries(patch.add ?? {})
    if (add.some(([k]) => patch.set && k in patch.set)) {
      throw new Error('update: a field may not be in both set and add')
    }
    let data = 'data'
    const params: unknown[] = []
    const removed = set.filter(([, v]) => v === undefined).map(([k]) => path(k))
    if (removed.length) data = `json_remove(${data}, ${removed.join(', ')})`
    const written = set.filter(([, v]) => v !== undefined)
    if (written.length) {
      data = `json_set(${data}, ${written.map(([k]) => `${path(k)}, json(?)`).join(', ')})`
      for (const [, v] of written) params.push(JSON.stringify(v))
    }
    if (add.length) {
      // A field that is not a number makes json() fail on purpose (SQL has no RAISE outside a
      // trigger); a missing one counts as 0.
      const sum = (k: string) =>
        `CASE WHEN json_type(data, ${path(k)}) IS NULL THEN 0 ` +
        `WHEN json_type(data, ${path(k)}) IN ('integer', 'real') THEN json_extract(data, ${path(k)}) ` +
        `ELSE json('add: not a number') END + ?`
      data = `json_set(${data}, ${add.map(([k]) => `${path(k)}, ${sum(k)}`).join(', ')})`
      for (const [, n] of add) params.push(n)
    }
    let expires = 'expires_at'
    if (patch.set && 'expiresAt' in patch.set) {
      checkExpiresAt(patch.set.expiresAt)
      expires = '?'
      params.push(expiryOf(patch.set.expiresAt))
    }
    const write = this.db
      .prepare(
        `UPDATE items SET data = ${data}, expires_at = ${expires} WHERE pk = ? AND sk = ? ` +
          'AND (expires_at IS NULL OR expires_at > ?) RETURNING sk, data'
      )
      .bind(...params, pk, sk, this.now())
    let rows: Row[]
    try {
      rows = cond
        ? ((await this.batch([this.guard(pk, sk, cond), write]))[1]?.results ?? [])
        : (await write.all<Row>()).results
    } catch (err) {
      if (err instanceof Error && err.message.includes('malformed JSON')) {
        throw new Error(`add: a field of ${pk}/${sk} is not a number`)
      }
      throw err
    }
    const row = rows[0]
    if (!row) throw new ConditionFailed()
    return fromRow(pk, row)
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    const write = this.remove(pk, sk)
    const rows = cond
      ? ((await this.batch([this.guard(pk, sk, cond), write]))[1]?.results ?? [])
      : (await write.all<Row>()).results
    const row = rows[0]
    const now = this.now()
    return row && (row.expires_at == null || row.expires_at > now) ? fromRow(pk, row) : null
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const keys = ops.map(op => ('put' in op ? op.put : op.delete))
    if (new Set(keys.map(k => `${k.pk}\0${k.sk}`)).size !== keys.length) {
      throw new Error('transact ops must be on distinct items')
    }
    if (ops.length === 0) return
    // Every guard runs before any write, so each sees the state before the transaction.
    const guards = ops.flatMap((op, i) => {
      const key = keys[i] as { pk: string; sk: string }
      return op.cond ? [this.guard(key.pk, key.sk, op.cond)] : []
    })
    const writes = ops.map(op =>
      'put' in op ? this.replace(op.put) : this.remove(op.delete.pk, op.delete.sk)
    )
    await this.batch([...guards, ...writes])
  }

  /**
   * Delete dead items, `batchSize` at a time, and return how many went. Reads already ignore them;
   * this only reclaims space. The Worker's scheduled handler calls it.
   */
  async purgeExpired(batchSize = 500): Promise<number> {
    let total = 0
    for (;;) {
      const { meta } = await this.db
        .prepare(
          'DELETE FROM items WHERE (pk, sk) IN (SELECT pk, sk FROM items ' +
            `WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ${Math.floor(batchSize)})`
        )
        .bind(this.now())
        .run()
      total += meta.changes
      if (meta.changes < batchSize) return total
    }
  }
}

/** SQL true when the row's `data` has `field` equal to `value` (undefined: not set). */
function fieldMatch(field: string, value: Scalar | undefined): { sql: string; params: unknown[] } {
  const p = path(field)
  if (value === undefined) return { sql: `json_type(data, ${p}) IS NULL`, params: [] }
  if (typeof value === 'boolean') return { sql: `json_type(data, ${p}) = '${value}'`, params: [] }
  const types = typeof value === 'number' ? `('integer', 'real')` : `('text')`
  return {
    sql: `json_type(data, ${p}) IN ${types} AND json_extract(data, ${p}) = ?`,
    params: [value],
  }
}
