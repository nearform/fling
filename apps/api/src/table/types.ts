/**
 * Table port: the one storage primitive the domain persistence (`store/records.ts`) is written
 * against. Implementations: `memory.ts` (dev/tests) here, DynamoDB in platforms/aws; every one
 * passes `tableConformance` in @fling/conformance.
 *
 * A table is a set of items addressed by a partition key `pk` and a sort key `sk`. Access is by
 * key only: one item by (pk, sk), or the items of one pk whose sk starts with a prefix. There are
 * no secondary indexes; a second access path is an explicit index item written in the same
 * `transact` as the item it points at.
 *
 * Ordering: `query` returns items in ascending **byte order of the UTF-8 encoding of sk** (what
 * DynamoDB does for string sort keys). This is not JavaScript's `<` on strings, which compares
 * UTF-16 code units and puts U+E000–U+FFFF after astral characters; use `compareSk`.
 *
 * `scan` walks the whole table. It exists for data migrations (`migrations/`) and nothing else:
 * domain code reaches items by key, so a backend never has to make scans cheap, and
 * tests/no-scan.test.ts fails if anything outside migrations/ and table/ calls it.
 *
 * Expiry: an item with `expiresAt` (an ISO 8601 UTC timestamp exactly as `Date#toISOString`
 * writes it) is dead from that instant. Dead items are invisible to every read and every condition
 * (`ifAbsent` succeeds over one) even while the backend has not purged them yet.
 */

/** Attribute values are anything JSON can carry, except that `undefined` fields are dropped. */
export type TableItem = {
  pk: string
  sk: string
  /** expiry (see above); also a normal attribute, returned with the item */
  expiresAt?: string
  [field: string]: unknown
}

export type Key = { pk: string; sk: string }

/** A scalar a condition can compare a field with. */
export type Scalar = string | number | boolean

/**
 * A write's precondition, evaluated atomically with the write against the live item at its key.
 * - `ifAbsent`: there is no live item.
 * - `ifExists`: there is a live item.
 * - `fieldEquals`: there is a live item and `field` equals `value` (`undefined`: the field is not
 *   set). With `orAbsent`, also true when there is no live item.
 */
export type Condition =
  | { kind: 'ifAbsent' }
  | { kind: 'ifExists' }
  | { kind: 'fieldEquals'; field: string; value: Scalar | undefined; orAbsent?: boolean }

export const ifAbsent: Condition = { kind: 'ifAbsent' }
export const ifExists: Condition = { kind: 'ifExists' }
export const fieldEquals = (
  field: string,
  value: Scalar | undefined,
  opts: { orAbsent?: boolean } = {}
): Condition => ({ kind: 'fieldEquals', field, value, ...opts })

/** A write's condition was false (in `transact`: some op's was; nothing was written). */
export class ConditionFailed extends Error {
  override name = 'ConditionFailed'
  constructor(
    /** in `transact`, the index of the op whose condition failed, when the backend says */
    readonly index?: number
  ) {
    super(index === undefined ? 'Condition failed' : `Condition failed (op ${index})`)
  }
}

/**
 * `set` writes fields (an `undefined` value removes the field); `add` adds to numeric fields,
 * treating a missing one as 0. A field may not be in both.
 */
export interface Patch {
  set?: Record<string, unknown>
  add?: Record<string, number>
}

export interface QueryOptions {
  /** only items whose sk starts with this (byte-wise; '' or absent: all of the pk) */
  skPrefix?: string
  /** at most this many items per page (absent: all of them, in one page) */
  limit?: number
  /** from a previous page of the same query */
  cursor?: string
  /** descending sk order */
  reverse?: boolean
}

export interface ScanOptions {
  /** at most this many items per page (absent: all of them, in one page) */
  limit?: number
  /** from a previous page of the scan */
  cursor?: string
}

export interface Page {
  items: TableItem[]
  /**
   * Set when more items may follow: pass it back as `cursor` for the next page. It can be set
   * when the next page turns out empty; absent means there is nothing more.
   */
  cursor?: string
}

export type TransactOp = { put: TableItem; cond?: Condition } | { delete: Key; cond?: Condition }

export interface Table {
  /** The live item, or null. */
  get(pk: string, sk: string): Promise<TableItem | null>
  /** Live items of one pk in sk byte order (see above), optionally one page at a time. */
  query(pk: string, opts?: QueryOptions): Promise<Page>
  /**
   * MIGRATIONS ONLY. Every live item in the table, a page at a time, in an order that is
   * unspecified but stable: following the cursors visits each item that exists throughout the
   * scan exactly once (items written or deleted meanwhile may or may not be seen).
   */
  scan(opts?: ScanOptions): Promise<Page>
  /** Create or replace the whole item. Throws `ConditionFailed`. */
  put(item: TableItem, cond?: Condition): Promise<void>
  /**
   * Change fields of the live item and return it as it now is. There must be a live item (an
   * update never creates one): otherwise, or when `cond` is false, throws `ConditionFailed`.
   */
  update(pk: string, sk: string, patch: Patch, cond?: Condition): Promise<TableItem>
  /** Delete the item. Returns it if it was live, else null. Throws `ConditionFailed`. */
  delete(pk: string, sk: string, cond?: Condition): Promise<TableItem | null>
  /**
   * All the ops or none: if any condition is false nothing is written and `ConditionFailed` is
   * thrown. At most 25 ops, each on a different item.
   */
  transact(ops: TransactOp[]): Promise<void>
}

/** Max ops in one `transact` (the lowest common limit across backends). */
export const TRANSACT_MAX = 25

const utf8 = new TextEncoder()

/** Compare sort keys in UTF-8 byte order (the order `query` returns). */
export function compareSk(a: string, b: string): number {
  if (a === b) return 0
  const x = utf8.encode(a)
  const y = utf8.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  }
  return x.length - y.length
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Throws unless `expiresAt` is absent or a `Date#toISOString` timestamp. */
export function checkExpiresAt(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`expiresAt must be an ISO timestamp like 2026-01-01T00:00:00.000Z`)
  }
}

/** Whether an item is dead at `now` (epoch ms). */
export const isExpired = (item: { expiresAt?: unknown }, now: number) =>
  typeof item.expiresAt === 'string' && Date.parse(item.expiresAt) <= now

/** Cursors are opaque to callers; adapters that page by sk can share this encoding. */
export const encodeCursor = (sk: string) => Buffer.from(sk, 'utf8').toString('base64url')
export const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8')
