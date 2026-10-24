/**
 * Data migrations: written once against the Table port, so every platform runs the same ones.
 * Each is a file `migrations/NNNN-<what>.ts` listed in order in `migrations/index.ts`, and walks
 * the whole table with `scan` (which nothing else may use), a page at a time.
 *
 * Every migration must be:
 * - idempotent: a page may be applied again (after a crash between applying it and checkpointing
 *   it), and a whole migration may be run again;
 * - safe while the API serves traffic: conditional writes, never a blind overwrite of something
 *   the API may have written since the page was read;
 * - written in its own terms: its keys and shapes spelled out in the file, not imported from
 *   Records, so it keeps meaning what it meant when the code around it moves on.
 *
 * The runner keeps two items per migration:
 *
 *   pk               sk      item
 *   MIGRATION#NNNN   STATE   { status: running | done, cursor, scanned, pages, counts, … }
 *   MIGRATION#NNNN   LOCK    { owner, acquiredAt, expiresAt }: a lease
 *
 * The lock is taken with a conditional put (absent, or expired: an expired item is absent to
 * conditions) and renewed in the same transaction as each checkpoint, conditional on still owning
 * it. A crashed run's lease simply runs out and the next run takes over from its last
 * checkpoint; a run that lost its lease (paused past it) fails its next checkpoint and stops.
 *
 * `runMigrations` runs the pending ones in order, stopping at the first it can't finish (out of
 * time, or locked by another run), and is a no-op when everything is done. With `deadline` it
 * stops cleanly between pages so a time-boxed caller (a Lambda invoke) can call again until
 * `done`. A dry run reads everything and writes nothing (not even the runner's own items).
 */
import { randomUUID } from 'node:crypto'
import {
  ConditionFailed,
  fieldEquals,
  ifAbsent,
  type Page,
  type Patch,
  type ScanOptions,
  type Table,
  type TableItem,
  type TransactOp,
} from '../table/types.ts'

export interface MigrationContext {
  /** The table to read and write. In a dry run, writes are counted and dropped. */
  table: Table
  dryRun: boolean
  /** Add to a named counter, reported with progress and kept in the checkpoint. */
  count(what: string, n?: number): void
}

export interface Migration {
  /** `NNNN`, as in the file name; runs in this order */
  id: string
  title: string
  /**
   * false: never run by default, only when asked for by id (`only`): a step that needs a human
   * decision first (e.g. a contract step deleting what an older release still reads).
   */
  auto: boolean
  /** Apply one page of a whole-table scan. Idempotent (see above). */
  apply(items: TableItem[], ctx: MigrationContext): Promise<void>
}

export interface RunOptions {
  migrations: readonly Migration[]
  /** run only these ids (in migration order), including ones that are not `auto` */
  only?: readonly string[]
  dryRun?: boolean
  /** epoch ms: don't start a page after this (the run is checkpointed and can continue later) */
  deadline?: number
  /** items per scan page (default 100) */
  pageSize?: number
  /** lease on a migration's lock, renewed every page (default 2 min) */
  leaseMs?: number
  now?: () => number
  log?: (line: string) => void
  /** lock owner id (default: random per run) */
  owner?: string
}

export type MigrationStatus =
  /** done before this run */
  | 'up-to-date'
  /** finished in this run */
  | 'completed'
  /** stopped at the deadline; call again */
  | 'partial'
  /** another run holds the lock */
  | 'busy'
  /** not `auto` and not asked for */
  | 'skipped'
  /** not reached: an earlier migration did not finish */
  | 'pending'

export interface MigrationReport {
  id: string
  title: string
  status: MigrationStatus
  scanned: number
  pages: number
  counts: Record<string, number>
  /** busy: who holds the lock, until when */
  lockedBy?: string
  lockedUntil?: string
}

export interface RunReport {
  /** every selected migration is done (dry run: was walked to the end) */
  done: boolean
  dryRun: boolean
  migrations: MigrationReport[]
}

interface State {
  status: 'running' | 'done'
  cursor?: string
  scanned: number
  pages: number
  counts: Record<string, number>
  startedAt: string
  updatedAt: string
  finishedAt?: string
}

const stateKey = (id: string) => ({ pk: `MIGRATION#${id}`, sk: 'STATE' })
const lockKey = (id: string) => ({ pk: `MIGRATION#${id}`, sk: 'LOCK' })

/** The migration's checkpoint, or null if it never ran. */
export async function migrationState(table: Table, id: string): Promise<State | null> {
  const { pk, sk } = stateKey(id)
  return (await table.get(pk, sk)) as State | null
}

/** Reads pass through; writes are counted and dropped (conditions are not evaluated). */
class DryRunTable implements Table {
  writes = 0
  constructor(private inner: Table) {}
  get(pk: string, sk: string) {
    return this.inner.get(pk, sk)
  }
  query(pk: string, opts?: Parameters<Table['query']>[1]) {
    return this.inner.query(pk, opts)
  }
  scan(opts?: ScanOptions): Promise<Page> {
    return this.inner.scan(opts)
  }
  async put() {
    this.writes++
  }
  async update(pk: string, sk: string, _patch: Patch) {
    this.writes++
    const item = await this.inner.get(pk, sk)
    if (!item) throw new ConditionFailed()
    return item
  }
  async delete(pk: string, sk: string) {
    this.writes++
    return this.inner.get(pk, sk)
  }
  async transact(ops: TransactOp[]) {
    this.writes += ops.length
  }
}

export class LeaseLost extends Error {
  override name = 'LeaseLost'
}

export async function runMigrations(table: Table, opts: RunOptions): Promise<RunReport> {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const iso = () => new Date(now()).toISOString()
  const dryRun = opts.dryRun ?? false
  const pageSize = opts.pageSize ?? 100
  const leaseMs = opts.leaseMs ?? 120_000
  const owner = opts.owner ?? randomUUID()
  const lease = () => new Date(now() + leaseMs).toISOString()
  const ids = [...opts.migrations].map(m => m.id)
  if (new Set(ids).size !== ids.length || ids.some((id, i) => i > 0 && id <= (ids[i - 1] ?? ''))) {
    throw new Error(`Migrations must have unique ids in ascending order: ${ids.join(', ')}`)
  }

  const reports: MigrationReport[] = []
  let blocked = false
  for (const m of opts.migrations) {
    const selected = opts.only ? opts.only.includes(m.id) : m.auto
    const report: MigrationReport = {
      id: m.id,
      title: m.title,
      status: 'pending',
      scanned: 0,
      pages: 0,
      counts: {},
    }
    reports.push(report)
    if (!selected) {
      report.status = 'skipped'
      continue
    }
    if (blocked) continue

    const done = await migrationState(table, m.id)
    if (done?.status === 'done') {
      Object.assign(report, { status: 'up-to-date', ...pick(done) })
      continue
    }

    if (dryRun) {
      const dry = new DryRunTable(table)
      const finished = await walk(m, dry, report, undefined, async () => {})
      report.counts['dry-run writes'] = dry.writes
      if (finished) report.status = 'completed'
      else {
        report.status = 'partial'
        blocked = true
      }
      continue
    }

    // Take the lock: absent, or its lease ran out.
    const lk = lockKey(m.id)
    try {
      await table.put(
        { ...lk, type: 'migration-lock', owner, acquiredAt: iso(), expiresAt: lease() },
        ifAbsent
      )
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      const held = await table.get(lk.pk, lk.sk)
      report.status = 'busy'
      report.lockedBy = String(held?.owner ?? 'unknown')
      report.lockedUntil = String(held?.expiresAt ?? '')
      log(`${m.id} ${m.title}: locked by ${report.lockedBy} until ${report.lockedUntil}`)
      blocked = true
      continue
    }

    try {
      // Read the checkpoint under the lock: a run that just finished or got further wins.
      const start = await migrationState(table, m.id)
      if (start?.status === 'done') {
        Object.assign(report, { status: 'up-to-date', ...pick(start) })
        await release(table, m.id, owner)
        continue
      }
      const startedAt = start?.startedAt ?? iso()
      Object.assign(report, pick(start ?? { scanned: 0, pages: 0, counts: {} }))
      if (start?.cursor) log(`${m.id} ${m.title}: resuming after ${start.pages} page(s)`)

      const checkpoint = async (cursor: string | undefined, finished: boolean) => {
        const state: State = {
          status: finished ? 'done' : 'running',
          ...(cursor === undefined ? {} : { cursor }),
          scanned: report.scanned,
          pages: report.pages,
          counts: report.counts,
          startedAt,
          updatedAt: iso(),
          ...(finished ? { finishedAt: iso() } : {}),
        }
        const holds = fieldEquals('owner', owner)
        try {
          await table.transact([
            { put: { ...stateKey(m.id), type: 'migration', id: m.id, title: m.title, ...state } },
            finished
              ? { delete: lk, cond: holds }
              : {
                  put: {
                    ...lk,
                    type: 'migration-lock',
                    owner,
                    acquiredAt: iso(),
                    expiresAt: lease(),
                  },
                  cond: holds,
                },
          ])
        } catch (err) {
          if (err instanceof ConditionFailed) {
            throw new LeaseLost(`Migration ${m.id}: lost the lock (lease ran out); stopping`)
          }
          throw err
        }
      }

      const finished = await walk(m, table, report, start?.cursor, checkpoint)
      if (finished) {
        report.status = 'completed'
        log(`${m.id} ${m.title}: done, ${report.scanned} items scanned ${fmt(report.counts)}`)
      } else {
        report.status = 'partial'
        blocked = true
        await release(table, m.id, owner)
        log(`${m.id} ${m.title}: out of time after page ${report.pages}; run again to continue`)
      }
    } catch (err) {
      if (!(err instanceof LeaseLost)) await release(table, m.id, owner).catch(() => {})
      throw err
    }
  }

  const unfinished: MigrationStatus[] = ['pending', 'partial', 'busy']
  const done = reports.every(r => r.status === 'skipped' || !unfinished.includes(r.status))
  return { done, dryRun, migrations: reports }

  /** Scan from `cursor`, applying and checkpointing page by page; true when it reached the end. */
  async function walk(
    m: Migration,
    t: Table,
    report: MigrationReport,
    cursor: string | undefined,
    checkpoint: (cursor: string | undefined, finished: boolean) => Promise<void>
  ): Promise<boolean> {
    const ctx: MigrationContext = {
      table: t,
      dryRun,
      count(what, n = 1) {
        report.counts[what] = (report.counts[what] ?? 0) + n
      },
    }
    for (;;) {
      if (opts.deadline !== undefined && now() >= opts.deadline) return false
      const page = await t.scan({ limit: pageSize, cursor })
      // The runner's own items are not data.
      const items = page.items.filter(i => !i.pk.startsWith('MIGRATION#'))
      await m.apply(items, ctx)
      report.scanned += items.length
      report.pages++
      cursor = page.cursor
      await checkpoint(cursor, cursor === undefined)
      log(
        `${m.id} ${m.title}${dryRun ? ' (dry run)' : ''}: page ${report.pages}, ` +
          `${report.scanned} items scanned ${fmt(report.counts)}`
      )
      if (cursor === undefined) return true
    }
  }
}

async function release(table: Table, id: string, owner: string) {
  const { pk, sk } = lockKey(id)
  try {
    await table.delete(pk, sk, fieldEquals('owner', owner))
  } catch (err) {
    if (!(err instanceof ConditionFailed)) throw err
  }
}

const pick = (s: Pick<State, 'scanned' | 'pages' | 'counts'>) => ({
  scanned: s.scanned,
  pages: s.pages,
  counts: { ...s.counts },
})

const fmt = (counts: Record<string, number>) => JSON.stringify(counts)
