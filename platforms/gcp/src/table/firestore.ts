/**
 * Firestore Table (Native mode): every item is one document in one collection (default `items`),
 * in the database the instance names (FIRESTORE_DATABASE, default `(default)`).
 *
 * Layout of a document:
 * - its ID is a SHA-256 of pk and sk (base64url), because IDs may not hold `/` and are capped at
 *   1,500 bytes;
 * - `pk`, the partition key, a string;
 * - `s`, the sort key's UTF-8 bytes (a Bytes value). Firestore orders bytes byte by byte, which is
 *   exactly `compareSk`, so the order never rests on how a string field is compared. A prefix is
 *   the range `[prefix, prefix + 0xFF)`: no UTF-8 sequence holds 0xFF, so every key that starts
 *   with the prefix is in it, and nothing else is. Queries use the composite indexes `(pk, s)`
 *   ascending and `(pk, s)` descending (platforms/gcp/infra/data.tf);
 * - `data`, the item's other fields as JSON. JSON keeps every value the port takes as it is (NUL
 *   and lone surrogates are escaped; nested arrays, which Firestore refuses as values, are text),
 *   so no field name is reserved. It is exempt from indexing;
 * - `ttl`, a Timestamp of `expiresAt` when the item has one, for the database's TTL policy.
 *
 * Firestore indexes only the first 1,500 bytes of a value, and orders and ranges on those alone,
 * so `put` and `transact` refuse a pk or sk longer than that in UTF-8 (the core keeps every key
 * well under it: MAX_PATH_BYTES), and a query on a longer pk or prefix finds nothing, as no item
 * can have one.
 *
 * Writes that depend on what is there (every condition, `update`, a `delete` that returns the old
 * item, `transact`) run in a Firestore transaction: reads take locks, conflicting transactions are
 * retried by the client, and a false condition aborts with `ConditionFailed` (carrying the op's
 * index in `transact`). `add` is a read and a write in one transaction, so concurrent adds all
 * count. Reads are strongly consistent.
 *
 * Expiry: the TTL policy deletes dead documents, usually within a day and sometimes later, so
 * every read and every condition also treats an item past its `expiresAt` as absent, as the
 * DynamoDB adapter does.
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
  isExpired,
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
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  FieldPath,
  Firestore,
  type Query,
  Timestamp,
  type Transaction,
} from '@google-cloud/firestore'

/** The collection the items are in, unless the caller names another. */
export const DEFAULT_COLLECTION = 'items'

/** How often the client retries a transaction that lost to a concurrent one. */
const MAX_ATTEMPTS = 50

const utf8 = (s: string) => Buffer.from(s, 'utf8')
const docId = (pk: string, sk: string) =>
  createHash('sha256').update(`${pk}\u0000${sk}`).digest('base64url')

/** The most bytes of a value Firestore indexes, orders and compares. */
export const MAX_KEY_BYTES = 1500

const fits = (s: string) => Buffer.byteLength(s, 'utf8') <= MAX_KEY_BYTES

/** checkKey, and both parts within what Firestore indexes. */
function checkFirestoreKey(k: { pk: string; sk: string }): void {
  checkKey(k)
  if (!fits(k.pk) || !fits(k.sk)) {
    throw new Error(`table keys may not be over ${MAX_KEY_BYTES} bytes of UTF-8 on Firestore`)
  }
}

/** A page's limit, when there is one, is a whole number of items, at least one. */
function checkLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('limit must be a positive integer')
  }
}

/** The bytes just past every key that starts with `prefix`. */
const pastPrefix = (prefix: Buffer) => Buffer.concat([prefix, Buffer.from([0xff])])

function toDoc(item: TableItem): DocumentData {
  checkExpiresAt(item.expiresAt)
  const { pk, sk, ...fields } = item
  return {
    pk,
    s: utf8(sk),
    data: JSON.stringify(fields),
    ...(item.expiresAt === undefined
      ? {}
      : { ttl: Timestamp.fromMillis(Date.parse(item.expiresAt)) }),
  }
}

function fromDoc(doc: DocumentData): TableItem {
  const sk = Buffer.from(doc.s as Uint8Array).toString('utf8')
  return { pk: doc.pk as string, sk, ...(JSON.parse(doc.data as string) as object) }
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

/** The item `patch` makes of `item` (the port's update rules). */
function patched(item: TableItem, patch: Patch): TableItem {
  const next: Record<string, unknown> = { ...item }
  for (const [k, v] of Object.entries(patch.set ?? {})) {
    // An item's key is where it is: update never moves it (the caller sets pk and sk back).
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

/** Drop `undefined` fields, as JSON would, but before the write so `put` and `get` agree. */
function clean(item: TableItem): TableItem {
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as TableItem
}

export interface FirestoreTableOptions {
  /** the collection (default `items`) */
  collection?: string
  /** the clock expiry is read against (default Date.now) */
  now?: () => number
}

export class FirestoreTable implements Table {
  private readonly collection: string
  private readonly now: () => number

  constructor(
    private readonly db: Firestore = new Firestore(),
    opts: FirestoreTableOptions = {}
  ) {
    this.collection = opts.collection ?? DEFAULT_COLLECTION
    this.now = opts.now ?? Date.now
  }

  private ref(pk: string, sk: string): DocumentReference {
    return this.db.collection(this.collection).doc(docId(pk, sk))
  }

  /** The live item of a snapshot, or null. */
  private live(snap: DocumentSnapshot): TableItem | null {
    const data = snap.data()
    if (!data) return null
    const item = fromDoc(data)
    return isExpired(item, this.now()) ? null : item
  }

  private run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(work, { maxAttempts: MAX_ATTEMPTS })
  }

  async get(pk: string, sk: string) {
    if (!storable({ pk, sk })) return null
    return this.live(await this.ref(pk, sk).get())
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const skPrefix = opts.skPrefix ?? ''
    if (!storableKey(pk) || !storableKey(skPrefix) || !fits(pk) || !fits(skPrefix)) {
      return { items: [] }
    }
    checkLimit(opts.limit)
    let base: Query = this.db.collection(this.collection).where('pk', '==', pk)
    if (opts.skPrefix) {
      const prefix = utf8(opts.skPrefix)
      base = base.where('s', '>=', prefix).where('s', '<', pastPrefix(prefix))
    }
    base = base.orderBy('s', opts.reverse ? 'desc' : 'asc')
    const items: TableItem[] = []
    let after: Buffer | undefined =
      opts.cursor === undefined ? undefined : utf8(decodeCursor(opts.cursor))
    const now = this.now()
    for (;;) {
      // One more than the page still needs, so a full page knows whether anything follows.
      const want = opts.limit === undefined ? 500 : opts.limit - items.length + 1
      let q = base.limit(want)
      if (after) q = q.startAfter(after)
      const res = await q.get()
      for (const doc of res.docs) {
        const item = fromDoc(doc.data())
        after = doc.get('s') as Buffer
        if (isExpired(item, now)) continue
        if (opts.limit !== undefined && items.length === opts.limit) {
          const last = items[items.length - 1] as TableItem
          return { items, cursor: encodeCursor(last.sk) }
        }
        items.push(item)
      }
      if (res.size < want) return { items }
    }
  }

  /** Migrations only (see the Table port): in document ID order; the cursor is the last ID. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    checkLimit(opts.limit)
    const items: TableItem[] = []
    let after = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor)
    const now = this.now()
    const base = this.db.collection(this.collection).orderBy(FieldPath.documentId())
    for (;;) {
      const want = opts.limit === undefined ? 500 : opts.limit - items.length
      let q = base.limit(want)
      if (after !== undefined) q = q.startAfter(after)
      const res = await q.get()
      for (const doc of res.docs) {
        after = doc.id
        const item = fromDoc(doc.data())
        if (!isExpired(item, now)) items.push(item)
      }
      if (res.size < want) return { items }
      if (opts.limit !== undefined && items.length >= opts.limit) {
        return { items, cursor: encodeCursor(after as string) }
      }
    }
  }

  async put(item: TableItem, cond?: Condition) {
    checkFirestoreKey(item)
    const doc = toDoc(clean(item))
    const ref = this.ref(item.pk, item.sk)
    if (!cond) {
      await ref.set(doc)
      return
    }
    await this.run(async tx => {
      if (!holds(cond, this.live(await tx.get(ref)))) throw new ConditionFailed()
      tx.set(ref, doc)
    })
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    if (!storable({ pk, sk })) throw new ConditionFailed()
    const ref = this.ref(pk, sk)
    return this.run(async tx => {
      const item = this.live(await tx.get(ref))
      if (!item || !holds(cond, item)) throw new ConditionFailed()
      const next = { ...patched(item, patch), pk, sk }
      tx.set(ref, toDoc(next))
      return next
    })
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    if (!storable({ pk, sk })) {
      if (!holdsWhenAbsent(cond)) throw new ConditionFailed()
      return null
    }
    const ref = this.ref(pk, sk)
    return this.run(async tx => {
      const snap = await tx.get(ref)
      const item = this.live(snap)
      if (!holds(cond, item)) throw new ConditionFailed()
      if (snap.exists) tx.delete(ref)
      return item
    })
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const keys = ops.map(op => ('put' in op ? op.put : op.delete))
    for (const key of keys) checkFirestoreKey(key)
    const ids = keys.map(k => docId(k.pk, k.sk))
    if (new Set(ids).size !== ids.length) throw new Error('transact ops must be on distinct items')
    const docs = ops.map(op => ('put' in op ? toDoc(clean(op.put)) : null))
    if (ops.length === 0) return
    const refs = keys.map(k => this.ref(k.pk, k.sk))
    await this.run(async tx => {
      const snaps = await tx.getAll(...refs)
      ops.forEach((op, index) => {
        if (!holds(op.cond, this.live(snaps[index] as DocumentSnapshot))) {
          throw new ConditionFailed(index)
        }
      })
      refs.forEach((ref, index) => {
        const doc = docs[index]
        if (doc) tx.set(ref, doc)
        else tx.delete(ref)
      })
    })
  }
}
