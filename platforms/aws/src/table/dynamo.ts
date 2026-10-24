/**
 * DynamoDB Table: one table, partition key `PK` (S) and sort key `SK` (S), no GSIs; `pk`/`sk`
 * are stored as `PK`/`SK`. An item with `expiresAt` also gets `ttl` (epoch seconds, rounded up):
 * enable DynamoDB TTL on the attribute `ttl`. TTL deletion lags by up to ~48 h, so dead items are
 * also filtered out of reads here and treated as absent by conditions (comparing the ISO
 * `expiresAt` strings, which sort chronologically).
 *
 * This is the layout the DynamoDB store has always written, so existing items read as-is.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  type Condition,
  ConditionFailed,
  checkExpiresAt,
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
} from '@fling/api/table'

type Attrs = Record<string, unknown>

/** DynamoDB TTL value (epoch seconds) for an ISO expiry. */
const ttlOf = (expiresAt: string) => Math.ceil(Date.parse(expiresAt) / 1000)

/** Attribute names this adapter owns; items may not carry them as fields. */
const RESERVED = ['PK', 'SK', 'ttl']

function toAttrs(item: TableItem): Attrs {
  checkExpiresAt(item.expiresAt)
  const { pk, sk, ...fields } = item
  for (const name of RESERVED) {
    if (name in fields) throw new Error(`"${name}" is reserved by DynamoTable`)
  }
  return {
    PK: pk,
    SK: sk,
    ...fields,
    ...(item.expiresAt === undefined ? {} : { ttl: ttlOf(item.expiresAt) }),
  }
}

function fromAttrs(attrs: Attrs): TableItem {
  const { PK, SK, ttl: _ttl, ...fields } = attrs
  return { pk: PK as string, sk: SK as string, ...fields }
}

/** Builds one expression's placeholder maps. */
class Expr {
  names: Record<string, string> = {}
  values: Record<string, unknown> = {}
  private n = 0

  name(field: string) {
    const key = `#n${this.n++}`
    this.names[key] = field
    return key
  }

  value(v: unknown) {
    const key = `:v${this.n++}`
    this.values[key] = v
    return key
  }

  /** Spread into a command (DynamoDB rejects empty maps). */
  get maps() {
    return {
      ...(Object.keys(this.names).length ? { ExpressionAttributeNames: this.names } : {}),
      ...(Object.keys(this.values).length ? { ExpressionAttributeValues: this.values } : {}),
    }
  }
}

const isNamed = (err: unknown, name: string) => err instanceof Error && err.name === name

/** `CancellationReasons[i].Code` of a cancelled transaction. */
const cancellationCodes = (err: unknown): (string | undefined)[] =>
  ((err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map(
    r => r.Code
  )

export class DynamoTable implements Table {
  private doc: DynamoDBDocumentClient

  constructor(
    private table: string,
    client = new DynamoDBClient({}),
    private now: () => number = Date.now
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  /** Condition text for "there is a live item" / "there is none". */
  private liveness(e: Expr) {
    const exp = e.name('expiresAt')
    const now = e.value(new Date(this.now()).toISOString())
    return {
      exists: `(attribute_exists(PK) AND (attribute_not_exists(${exp}) OR ${exp} > ${now}))`,
      absent: `(attribute_not_exists(PK) OR ${exp} <= ${now})`,
    }
  }

  private condition(e: Expr, cond: Condition): string {
    const { exists, absent } = this.liveness(e)
    switch (cond.kind) {
      case 'ifAbsent':
        return absent
      case 'ifExists':
        return exists
      case 'fieldEquals': {
        const f = e.name(cond.field)
        const test =
          cond.value === undefined ? `attribute_not_exists(${f})` : `${f} = ${e.value(cond.value)}`
        const equal = `(${exists} AND ${test})`
        return cond.orAbsent ? `(${absent} OR ${equal})` : equal
      }
    }
  }

  /** ConditionExpression + maps for an optional condition. */
  private conditional(cond: Condition | undefined) {
    if (!cond) return {}
    const e = new Expr()
    return { ConditionExpression: this.condition(e, cond), ...e.maps }
  }

  private async send<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (isNamed(err, 'ConditionalCheckFailedException')) throw new ConditionFailed()
      throw err
    }
  }

  async get(pk: string, sk: string) {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk }, ConsistentRead: true })
    )
    return res.Item && !isExpired(res.Item, this.now()) ? fromAttrs(res.Item) : null
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Page> {
    const e = new Expr()
    let keyCondition = `PK = ${e.value(pk)}`
    if (opts.skPrefix) keyCondition += ` AND begins_with(SK, ${e.value(opts.skPrefix)})`
    const items: TableItem[] = []
    let start: Attrs | undefined =
      opts.cursor === undefined ? undefined : { PK: pk, SK: decodeCursor(opts.cursor) }
    const now = this.now()
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: keyCondition,
          ...e.maps,
          ExclusiveStartKey: start,
          ScanIndexForward: !opts.reverse,
          ConsistentRead: true,
          // Ask only for what the page still needs; dead items filtered below may leave it short,
          // and the loop then fetches more.
          ...(opts.limit === undefined ? {} : { Limit: opts.limit - items.length }),
        })
      )
      for (const item of res.Items ?? []) if (!isExpired(item, now)) items.push(fromAttrs(item))
      start = res.LastEvaluatedKey
    } while (start && (opts.limit === undefined || items.length < opts.limit))
    const last = items[items.length - 1]
    return start && last ? { items, cursor: encodeCursor(last.sk) } : { items }
  }

  /** Migrations only (see the Table port). The cursor is DynamoDB's LastEvaluatedKey. */
  async scan(opts: ScanOptions = {}): Promise<Page> {
    const items: TableItem[] = []
    let start: Attrs | undefined =
      opts.cursor === undefined ? undefined : JSON.parse(decodeCursor(opts.cursor))
    const now = this.now()
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          ExclusiveStartKey: start,
          ConsistentRead: true,
          ...(opts.limit === undefined ? {} : { Limit: opts.limit - items.length }),
        })
      )
      for (const item of res.Items ?? []) if (!isExpired(item, now)) items.push(fromAttrs(item))
      start = res.LastEvaluatedKey
    } while (start && (opts.limit === undefined || items.length < opts.limit))
    return start ? { items, cursor: encodeCursor(JSON.stringify(start)) } : { items }
  }

  async put(item: TableItem, cond?: Condition) {
    await this.send(() =>
      this.doc.send(
        new PutCommand({ TableName: this.table, Item: toAttrs(item), ...this.conditional(cond) })
      )
    )
  }

  async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    const e = new Expr()
    const sets: string[] = []
    const removes: string[] = []
    const adds: string[] = []
    for (const [field, v] of Object.entries(patch.set ?? {})) {
      if (RESERVED.includes(field) || field === 'pk' || field === 'sk') {
        throw new Error(`"${field}" cannot be updated`)
      }
      if (v === undefined) removes.push(e.name(field))
      else sets.push(`${e.name(field)} = ${e.value(v)}`)
      if (field === 'expiresAt') {
        checkExpiresAt(v)
        if (typeof v === 'string') sets.push(`${e.name('ttl')} = ${e.value(ttlOf(v))}`)
        else removes.push(e.name('ttl'))
      }
    }
    for (const [field, n] of Object.entries(patch.add ?? {})) {
      adds.push(`${e.name(field)} ${e.value(n)}`)
    }
    const update = [
      sets.length ? `SET ${sets.join(', ')}` : '',
      removes.length ? `REMOVE ${removes.join(', ')}` : '',
      adds.length ? `ADD ${adds.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' ')
    // An update never creates an item: the live item must exist, and `cond` must hold.
    const exists = this.liveness(e).exists
    const condition = cond ? `${exists} AND ${this.condition(e, cond)}` : exists
    const res = await this.send(() =>
      this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: pk, SK: sk },
          ...(update ? { UpdateExpression: update } : {}),
          ConditionExpression: condition,
          ...e.maps,
          ReturnValues: 'ALL_NEW',
        })
      )
    )
    return fromAttrs(res.Attributes ?? { PK: pk, SK: sk })
  }

  async delete(pk: string, sk: string, cond?: Condition) {
    const res = await this.send(() =>
      this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: pk, SK: sk },
          ...this.conditional(cond),
          ReturnValues: 'ALL_OLD',
        })
      )
    )
    const old = res.Attributes
    return old && !isExpired(old, this.now()) ? fromAttrs(old) : null
  }

  async transact(ops: TransactOp[]) {
    if (ops.length > TRANSACT_MAX) throw new Error(`transact takes at most ${TRANSACT_MAX} ops`)
    const items = () =>
      ops.map(op =>
        'put' in op
          ? { Put: { TableName: this.table, Item: toAttrs(op.put), ...this.conditional(op.cond) } }
          : {
              Delete: {
                TableName: this.table,
                Key: { PK: op.delete.pk, SK: op.delete.sk },
                ...this.conditional(op.cond),
              },
            }
      )
    // A transaction that collides with another one in flight is cancelled with
    // TransactionConflict (nothing written, no condition failed): retry it, so callers only ever
    // see success or ConditionFailed.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items() }))
        return
      } catch (err) {
        if (!(err instanceof Error) || err.name !== 'TransactionCanceledException') throw err
        const codes = cancellationCodes(err)
        const failed = codes.indexOf('ConditionalCheckFailed')
        if (failed >= 0) throw new ConditionFailed(failed)
        if (codes.length === 0 && err.message.includes('ConditionalCheckFailed')) {
          throw new ConditionFailed()
        }
        if (!codes.includes('TransactionConflict') || attempt >= 8) throw err
        await new Promise(r => setTimeout(r, 20 * 2 ** attempt * Math.random()))
      }
    }
  }
}
