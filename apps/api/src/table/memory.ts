/**
 * In-memory Table for dev and tests. Single-threaded, so every operation is atomic; `now` is
 * injectable so expiry follows a test's clock.
 */
import {
  type Condition,
  ConditionFailed,
  checkExpiresAt,
  compareSk,
  decodeCursor,
  encodeCursor,
  isExpired,
  type Page,
  type Patch,
  type QueryOptions,
  type ScanOptions,
  type Table,
  type TableItem,
  TRANSACT_MAX,
  type TransactOp,
} from './types.ts'

const clone = <T>(v: T): T => structuredClone(v)

/** Drop `undefined` fields (as a backend serialising the item would). */
function clean(item: TableItem): TableItem {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) if (v !== undefined) out[k] = clone(v)
  return out as TableItem
}

function scanKey(cursor: string) {
  const [pk, sk] = JSON.parse(decodeCursor(cursor)) as [string, string]
  return { pk, sk }
}

export class MemoryTable implements Table {
  /** pk → sk → item */
  private items = new Map<string, Map<string, TableItem>>()

  constructor(private now: () => number = Date.now) {}

  private live(pk: string, sk: string): TableItem | null {
    const item = this.items.get(pk)?.get(sk)
    return item && !isExpired(item, this.now()) ? item : null
  }

  private holds(cond: Condition | undefined, item: TableItem | null): boolean {
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

  private write(item: TableItem) {
    const part = this.items.get(item.pk) ?? new Map<string, TableItem>()
    this.items.set(item.pk, part)
    part.set(item.sk, item)
  }

  private remove(pk: string, sk: string) {
    const part = this.items.get(pk)
    part?.delete(sk)
    if (part?.size === 0) this.items.delete(pk)
  }

  async get(pk: string, sk: string) {
    const item = this.live(pk, sk)
    return item ? clone(item) : null
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const prefix = opts.skPrefix ?? ''
    const after = opts.cursor === undefined ? undefined : decodeCursor(opts.cursor)
    const dir = opts.reverse ? -1 : 1
    const now = this.now()
    const matches = [...(this.items.get(pk)?.values() ?? [])]
      .filter(i => i.sk.startsWith(prefix) && !isExpired(i, now))
      .filter(i => after === undefined || dir * compareSk(i.sk, after) > 0)
      .sort((a, b) => dir * compareSk(a.sk, b.sk))
    const limit = opts.limit ?? matches.length
    const items = matches.slice(0, limit).map(clone)
    const last = items[items.length - 1]
    return matches.length > limit && last ? { items, cursor: encodeCursor(last.sk) } : { items }
  }

  /** In (pk, sk) byte order; the cursor is the last item's key. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const after = opts.cursor === undefined ? undefined : scanKey(opts.cursor)
    const now = this.now()
    const order = (a: TableItem, b: { pk: string; sk: string }) =>
      compareSk(a.pk, b.pk) || compareSk(a.sk, b.sk)
    const matches = [...this.items.values()]
      .flatMap(part => [...part.values()])
      .filter(i => !isExpired(i, now) && (after === undefined || order(i, after) > 0))
      .sort(order)
    const limit = opts.limit ?? matches.length
    const items = matches.slice(0, limit).map(clone)
    const last = items[items.length - 1]
    return matches.length > limit && last
      ? { items, cursor: encodeCursor(JSON.stringify([last.pk, last.sk])) }
      : { items }
  }

  async put(item: TableItem, cond?: Condition) {
    checkExpiresAt(item.expiresAt)
    if (!this.holds(cond, this.live(item.pk, item.sk))) throw new ConditionFailed()
    this.write(clean(item))
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    const item = this.live(pk, sk)
    if (!item || !this.holds(cond, item)) throw new ConditionFailed()
    const next: Record<string, unknown> = { ...item }
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      if (v === undefined) delete next[k]
      else next[k] = clone(v)
    }
    for (const [k, n] of Object.entries(patch.add ?? {})) {
      const current = next[k] ?? 0
      if (typeof current !== 'number') throw new Error(`add: ${k} is not a number`)
      next[k] = current + n
    }
    next.pk = pk
    next.sk = sk
    checkExpiresAt(next.expiresAt)
    this.write(next as TableItem)
    return clone(next as TableItem)
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    const item = this.live(pk, sk)
    if (!this.holds(cond, item)) throw new ConditionFailed()
    this.remove(pk, sk)
    return item ? clone(item) : null
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const keys = ops.map(op => ('put' in op ? op.put : op.delete)).map(k => `${k.pk}\0${k.sk}`)
    if (new Set(keys).size !== keys.length)
      throw new Error('transact ops must be on distinct items')
    // Check every condition before writing anything.
    ops.forEach((op, index) => {
      const key = 'put' in op ? op.put : op.delete
      if ('put' in op) checkExpiresAt(op.put.expiresAt)
      if (!this.holds(op.cond, this.live(key.pk, key.sk))) throw new ConditionFailed(index)
    })
    for (const op of ops) {
      if ('put' in op) this.write(clean(op.put))
      else this.remove(op.delete.pk, op.delete.sk)
    }
  }
}
