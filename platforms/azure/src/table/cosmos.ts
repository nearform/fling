/**
 * Cosmos DB Table: the Table port on one Cosmos DB for NoSQL container, every item in **one
 * logical partition** (the partition key path `/p`, always `PARTITION`). Cosmos DB has no
 * transactions across logical partitions, and `transact` spans several pks; with one partition,
 * every write is one transactional batch. The price is Cosmos DB's cap on a logical partition:
 * 20 GB and 10,000 RU/s, the ceiling of an instance on this Table (docs/platforms/azure.md).
 *
 * Documents: `{ id, p, pk, sk, skx, j, x?, ttl? }`.
 * - `id` is the hex SHA-256 of pk and sk: an id may not hold `/`, `\`, `?` or `#` and is at most
 *   255 characters, and hex sorts the same under any collation, which the scan's paging needs.
 * - `skx` is sk's UTF-8 bytes in lower-case hex. `query` orders and ranges on it, so the order is
 *   sk's byte order (`compareSk`) whatever collation Cosmos DB compares strings with: two hex
 *   digits per byte, digits below letters. A prefix is the range `[hex(prefix), hex(prefix)+'g')`,
 *   and a cursor (the last sk returned) is `skx > hex(sk)`, NULs and all.
 * - `j` is the item's other fields as JSON text. Cosmos DB refuses a document holding a lone
 *   surrogate, which items may; as text, every string is stored as it was. Nothing is queried
 *   by field, so the fields need no indexing (the container's indexing policy leaves `/j` out).
 * - `x` is expiresAt in epoch ms, which reads and conditions compare, and `ttl` the seconds until
 *   an hour after then, so the container's TTL (on, `default_ttl = -1`) purges dead items. Cosmos
 *   DB counts `ttl` from its own clock, so the hour keeps a skewed host clock from having an item
 *   purged while it is live, and a write that read the dead item from racing its purge. An expiry
 *   beyond the longest `ttl` Cosmos DB takes gets none: the item stays until it is written again.
 *   Purges lag, so a dead item is also invisible to every read and condition here.
 *
 * Writes: every write (put, update, delete, transact) reads the items it touches, checks its
 * conditions on them in JS, and commits one transactional batch whose operations are bound to
 * what it read: a Replace or Delete with the read document's ETag (`ifMatch`), a Create where
 * there was none. If anything wrote one of those items in between, the batch fails whole (412 or
 * 409, nothing written) and the write starts again from the reads; so of N racing writers exactly
 * one wins, a loser that finds the condition false then fails it, and concurrent adds all count.
 * A delete whose condition holds because there is no item (`ifAbsent`, `orAbsent`) creates a dead
 * placeholder in the batch, so a concurrent create fails one of them. A put without a condition
 * is an Upsert, which needs no read.
 *
 * Consistency: the account is set to Strong (one region; infra/data.tf), so a read made by any
 * replica of the host sees every committed write. A batch takes at most 100 operations, above
 * TRANSACT_MAX (25), and 2 MB of documents, which a `transact` of large items can pass: such a
 * batch is refused before it is sent, with an error naming the limit.
 */
import { createHash } from 'node:crypto'
import type { Container, ItemDefinition, OperationInput, SqlParameter } from '@azure/cosmos'
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

/** The one partition key value every item has. */
export const PARTITION = 'fling'

/** The container's partition key path (infra/data.tf creates the container with it). */
export const PARTITION_KEY_PATH = '/p'

/** A document as stored. */
interface Doc extends ItemDefinition {
  id: string
  p: string
  pk: string
  sk: string
  skx: string
  j: string
  x?: number
  ttl?: number
  _etag?: string
}

/** sk's UTF-8 bytes as lower-case hex: its byte order under any string comparison. */
export const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex')

/** The document id of a key. */
export const idOf = (k: Key) =>
  createHash('sha256').update(k.pk).update('\0').update(k.sk).digest('hex')

/** The longest item TTL Cosmos DB takes (a 32-bit integer of seconds, 68 years). */
const TTL_MAX = 2 ** 31 - 1

/** How long after its expiry Cosmos DB purges a dead item, in seconds. */
const PURGE_MARGIN = 3600

/** How long a placeholder (a delete's hold on a key's absence) stays, in seconds. */
const PLACEHOLDER_TTL = 60

/** The most document bytes one transactional batch takes. */
const BATCH_MAX_BYTES = 2 * 1024 * 1024

/** How many times a write starts again after losing a race before it gives up. */
const ATTEMPTS = 40

const pause = (attempt: number) =>
  new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(200, 4 * 2 ** attempt)))

const statusOf = (err: unknown) =>
  (err as { code?: unknown; statusCode?: unknown } | null)?.code ??
  (err as { statusCode?: unknown } | null)?.statusCode

/** A batch status that means another writer got there first: read again and retry. */
const LOST_RACE = new Set([404, 409, 412])

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
  return next as TableItem
}

/** One write of a batch, before it is bound to what was read. */
type Write =
  | { kind: 'put'; item: TableItem; cond?: Condition }
  | { kind: 'update'; key: Key; patch: Patch; cond?: Condition }
  | { kind: 'delete'; key: Key; cond?: Condition }

const keyOfWrite = (w: Write): Key => (w.kind === 'put' ? w.item : w.key)

/** A write needs the item read first unless it is a put without a condition (an Upsert). */
const needsRead = (w: Write) => !(w.kind === 'put' && !w.cond)

/** Retry the whole write: another writer changed an item between our read and our batch. */
class LostRace extends Error {}

export interface CosmosTableOptions {
  now?: () => number
}

export class CosmosTable implements Table {
  constructor(
    private container: Container,
    private opts: CosmosTableOptions = {}
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }

  private docOf(item: TableItem): Doc {
    checkExpiresAt(item.expiresAt)
    const { pk, sk, ...fields } = item
    const doc: Doc = {
      id: idOf(item),
      p: PARTITION,
      pk,
      sk,
      skx: hexOf(sk),
      j: JSON.stringify(fields),
    }
    if (typeof item.expiresAt === 'string') {
      doc.x = Date.parse(item.expiresAt)
      const ttl = Math.max(0, Math.ceil((doc.x - this.now()) / 1000)) + PURGE_MARGIN
      if (ttl <= TTL_MAX) doc.ttl = ttl
    }
    return doc
  }

  private live(doc: Doc | undefined, now = this.now()): TableItem | null {
    if (!doc || (typeof doc.x === 'number' && doc.x <= now)) return null
    return { ...(JSON.parse(doc.j) as Record<string, unknown>), pk: doc.pk, sk: doc.sk }
  }

  /** The document at a key, live or dead, or undefined. */
  private async read(k: Key): Promise<Doc | undefined> {
    const res = await this.container.item(idOf(k), PARTITION).read<Doc>()
    if (res.statusCode === 404) return undefined
    const doc = res.resource
    // A hash collision would be another key's document; never treat it as this one.
    return doc && doc.pk === k.pk && doc.sk === k.sk ? doc : undefined
  }

  async get(pk: string, sk: string) {
    if (!storable({ pk, sk })) return null
    return this.live(await this.read({ pk, sk }))
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    const now = this.now()
    if (!storableKey(pk) || !storableKey(opts.skPrefix ?? '')) return { items: [] }
    const lo = hexOf(opts.skPrefix ?? '')
    const parameters: SqlParameter[] = [
      { name: '@p', value: PARTITION },
      { name: '@pk', value: pk },
      { name: '@lo', value: lo },
      { name: '@hi', value: `${lo}g` },
      { name: '@now', value: now },
    ]
    let after = ''
    if (opts.cursor !== undefined) {
      after = opts.reverse ? ' AND c.skx < @after' : ' AND c.skx > @after'
      parameters.push({ name: '@after', value: hexOf(decodeCursor(opts.cursor)) })
    }
    if (limit !== undefined) parameters.push({ name: '@n', value: limit })
    const query = [
      `SELECT ${limit === undefined ? '' : 'TOP @n '}* FROM c`,
      'WHERE c.p = @p AND c.pk = @pk AND c.skx >= @lo AND c.skx < @hi',
      `AND (NOT IS_DEFINED(c.x) OR c.x > @now)${after}`,
      // pk leads the ORDER BY so the composite (pk, skx) indexes serve it (infra/data.tf).
      `ORDER BY c.pk ASC, c.skx ${opts.reverse ? 'DESC' : 'ASC'}`,
    ].join(' ')
    const docs = await this.all(query, parameters)
    const items = docs.flatMap(d => this.live(d, now) ?? [])
    const last = docs[docs.length - 1]
    return limit !== undefined && docs.length >= limit && last
      ? { items, cursor: encodeCursor(last.sk) }
      : { items }
  }

  /** Migrations only (see the Table port): every live item, in id order; the cursor is an id. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const limit = limitOf(opts.limit)
    const now = this.now()
    const parameters: SqlParameter[] = [
      { name: '@p', value: PARTITION },
      { name: '@now', value: now },
      { name: '@after', value: opts.cursor === undefined ? '' : decodeCursor(opts.cursor) },
    ]
    if (limit !== undefined) parameters.push({ name: '@n', value: limit })
    const query = [
      `SELECT ${limit === undefined ? '' : 'TOP @n '}* FROM c`,
      'WHERE c.p = @p AND c.id > @after AND (NOT IS_DEFINED(c.x) OR c.x > @now)',
      'ORDER BY c.id ASC',
    ].join(' ')
    const docs = await this.all(query, parameters)
    const items = docs.flatMap(d => this.live(d, now) ?? [])
    const last = docs[docs.length - 1]
    return limit !== undefined && docs.length >= limit && last
      ? { items, cursor: encodeCursor(last.id) }
      : { items }
  }

  private async all(query: string, parameters: SqlParameter[]): Promise<Doc[]> {
    const { resources } = await this.container.items
      .query<Doc>({ query, parameters }, { partitionKey: PARTITION })
      .fetchAll()
    return resources
  }

  async put(item: TableItem, cond?: Condition) {
    checkKey(item)
    await this.write([{ kind: 'put', item, ...(cond ? { cond } : {}) }])
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    if (!storable({ pk, sk })) throw new ConditionFailed()
    const [after] = await this.write([
      { kind: 'update', key: { pk, sk }, patch, ...(cond ? { cond } : {}) },
    ])
    return after as TableItem
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    if (!storable({ pk, sk })) {
      if (!holdsWhenAbsent(cond)) throw new ConditionFailed()
      return null
    }
    const [before] = await this.write([
      { kind: 'delete', key: { pk, sk }, ...(cond ? { cond } : {}) },
    ])
    return before ?? null
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const keys = ops.map(op => ('put' in op ? op.put : op.delete)).map(k => `${k.pk}\0${k.sk}`)
    if (new Set(keys).size !== keys.length)
      throw new Error('transact ops must be on distinct items')
    for (const op of ops) checkKey('put' in op ? op.put : op.delete)
    await this.write(
      ops.map(op =>
        'put' in op
          ? { kind: 'put' as const, item: op.put, ...(op.cond ? { cond: op.cond } : {}) }
          : { kind: 'delete' as const, key: op.delete, ...(op.cond ? { cond: op.cond } : {}) }
      ),
      true
    )
  }

  /**
   * Reads, checks and commits `writes` as one batch, again from the reads while it loses races.
   * Returns, per write, the item after an update and the live item before a delete.
   */
  private async write(writes: Write[], indexed = false): Promise<(TableItem | null)[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(writes, indexed)
      } catch (err) {
        if (!(err instanceof LostRace)) throw err
        if (attempt >= ATTEMPTS) throw new Error('Cosmos DB write kept losing races; try again')
        await pause(attempt)
      }
    }
  }

  private async attempt(writes: Write[], indexed: boolean): Promise<(TableItem | null)[]> {
    const docs = await Promise.all(
      writes.map(w => (needsRead(w) ? this.read(keyOfWrite(w)) : undefined))
    )
    const now = this.now()
    const batch: OperationInput[] = []
    const results: (TableItem | null)[] = []
    writes.forEach((w, i) => {
      const doc = docs[i]
      const live = this.live(doc, now)
      const fail = () => new ConditionFailed(indexed ? i : undefined)
      if (w.kind === 'update' ? live === null || !holds(w.cond, live) : !holds(w.cond, live)) {
        throw fail()
      }
      const bound = doc?._etag ? { ifMatch: doc._etag } : {}
      if (w.kind === 'put') {
        const body = this.docOf(w.item)
        if (!w.cond) batch.push({ operationType: 'Upsert', resourceBody: body })
        else if (doc)
          batch.push({ operationType: 'Replace', id: body.id, resourceBody: body, ...bound })
        else batch.push({ operationType: 'Create', resourceBody: body })
        results.push(null)
      } else if (w.kind === 'update') {
        const next = patched(live as TableItem, w.patch)
        const body = this.docOf(next)
        batch.push({ operationType: 'Replace', id: body.id, resourceBody: body, ...bound })
        results.push(next)
      } else {
        if (doc) batch.push({ operationType: 'Delete', id: doc.id, ...bound })
        else if (w.cond)
          batch.push({ operationType: 'Create', resourceBody: this.placeholder(w.key) })
        results.push(live)
      }
    })
    if (batch.length > 0) await this.commit(batch)
    return results
  }

  /** A dead document holding a key's absence for one batch; the container's TTL removes it. */
  private placeholder(k: Key): Doc {
    return {
      id: idOf(k),
      p: PARTITION,
      pk: k.pk,
      sk: k.sk,
      skx: hexOf(k.sk),
      j: '{}',
      x: 0,
      ttl: PLACEHOLDER_TTL,
    }
  }

  private async commit(batch: OperationInput[]) {
    const bytes = batch.reduce(
      (n, op) =>
        n + ('resourceBody' in op ? Buffer.byteLength(JSON.stringify(op.resourceBody)) : 0),
      0
    )
    if (bytes > BATCH_MAX_BYTES) {
      throw new Error(`a Cosmos DB batch takes at most 2 MB of items; this one is ${bytes} bytes`)
    }
    let res: Awaited<ReturnType<Container['items']['batch']>>
    try {
      res = await this.container.items.batch(batch, PARTITION)
    } catch (err) {
      if (LOST_RACE.has(statusOf(err) as number)) throw new LostRace()
      throw err
    }
    const statuses = (res.result ?? []).map(r => r.statusCode)
    if (res.code !== undefined && res.code >= 200 && res.code < 300 && res.code !== 207) return
    if (statuses.some(s => LOST_RACE.has(s))) throw new LostRace()
    throw new Error(`Cosmos DB batch failed (${res.code}: ${statuses.join(', ')})`)
  }
}

/** `limit` checked. */
function limitOf(limit: number | undefined) {
  if (limit === undefined) return undefined
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  return limit
}
