/**
 * The migration runner on a MemoryTable: order, checkpoints, resuming after a deadline or a crash,
 * the lock's lease, opt-in migrations and dry runs. Migration 0001 has its own tests.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LeaseLost,
  type Migration,
  migrationState,
  runMigrations,
} from '../src/migrations/runner.ts'
import { MemoryTable } from '../src/table/memory.ts'
import type { Table, TableItem } from '../src/table/types.ts'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function world(items = 25) {
  let now = T0
  const clock = () => now
  const table = new MemoryTable(clock)
  const seed = async () => {
    for (let i = 0; i < items; i++) {
      await table.put({ pk: `ITEM#${String(i).padStart(3, '0')}`, sk: 'X', n: i })
    }
  }
  return {
    table,
    clock,
    seed,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** Marks each ITEM it sees (`seen` += 1), counting what it did. */
function marker(id: string, opts: { auto?: boolean; onPage?: (n: number) => void } = {}) {
  let pages = 0
  const applied: TableItem[][] = []
  const m: Migration = {
    id,
    title: `marker ${id}`,
    auto: opts.auto ?? true,
    async apply(items, ctx) {
      opts.onPage?.(++pages)
      applied.push(items)
      for (const item of items) {
        if (!item.pk.startsWith('ITEM#')) continue
        await ctx.table.update(item.pk, item.sk, { add: { [`seen${id}`]: 1 } })
        ctx.count('marked')
      }
    },
  }
  return { m, applied }
}

async function all(table: Table) {
  return (await table.scan()).items
}

describe('runMigrations', () => {
  it('runs pending migrations in order, then is a no-op', async () => {
    const w = world()
    await w.seed()
    const order: string[] = []
    const a = marker('0001', { onPage: () => order.push('0001') })
    const b = marker('0002', { onPage: () => order.push('0002') })
    const first = await runMigrations(w.table, { migrations: [a.m, b.m], pageSize: 10 })
    expect(first.done).toBe(true)
    expect(first.migrations.map(m => [m.id, m.status, m.counts.marked])).toEqual([
      ['0001', 'completed', 25],
      ['0002', 'completed', 25],
    ])
    expect(order.indexOf('0002')).toBeGreaterThan(order.lastIndexOf('0001'))
    expect((await migrationState(w.table, '0001'))?.status).toBe('done')
    // no lock left behind
    expect(await w.table.get('MIGRATION#0001', 'LOCK')).toBeNull()

    const pagesBefore = a.applied.length
    const again = await runMigrations(w.table, { migrations: [a.m, b.m], pageSize: 10 })
    expect(again.done).toBe(true)
    expect(again.migrations.map(m => m.status)).toEqual(['up-to-date', 'up-to-date'])
    expect(a.applied.length).toBe(pagesBefore)
    for (const item of await all(w.table)) {
      if (item.pk.startsWith('ITEM#')) expect([item.seen0001, item.seen0002]).toEqual([1, 1])
    }
  })

  it('is done with nothing to run', async () => {
    const w = world()
    expect(await runMigrations(w.table, { migrations: [] })).toEqual({
      done: true,
      dryRun: false,
      migrations: [],
    })
  })

  it('refuses migrations out of order', async () => {
    const w = world()
    await expect(
      runMigrations(w.table, { migrations: [marker('0002').m, marker('0001').m] })
    ).rejects.toThrow(/ascending/)
  })

  it('skips migrations that are not auto unless asked for by id', async () => {
    const w = world()
    await w.seed()
    const optIn = marker('0002', { auto: false })
    const run = await runMigrations(w.table, { migrations: [marker('0001').m, optIn.m] })
    expect(run.done).toBe(true)
    expect(run.migrations.map(m => m.status)).toEqual(['completed', 'skipped'])
    expect(optIn.applied).toEqual([])
    const asked = await runMigrations(w.table, {
      migrations: [marker('0001').m, optIn.m],
      only: ['0002'],
    })
    expect(asked.migrations.map(m => m.status)).toEqual(['skipped', 'completed'])
  })

  it('stops at the deadline between pages and resumes from the checkpoint', async () => {
    const w = world()
    await w.seed()
    const a = marker('0001', { onPage: () => w.advance(1000) })
    const b = marker('0002')
    const opts = { migrations: [a.m, b.m], pageSize: 10, now: w.clock }
    const first = await runMigrations(w.table, { ...opts, deadline: T0 + 1500 })
    expect(first.done).toBe(false)
    expect(first.migrations.map(m => [m.status, m.pages])).toEqual([
      ['partial', 2],
      ['pending', 0],
    ])
    expect(b.applied).toEqual([])
    expect(await w.table.get('MIGRATION#0001', 'LOCK')).toBeNull()

    const second = await runMigrations(w.table, opts)
    expect(second.done).toBe(true)
    expect(second.migrations[0]).toMatchObject({ status: 'completed', pages: 3, scanned: 25 })
    // Pages already checkpointed were not applied again.
    expect(a.applied.flat().filter(i => i.pk.startsWith('ITEM#'))).toHaveLength(25)
  })

  it('a failing page releases the lock; the next run resumes after the last checkpoint', async () => {
    const w = world()
    await w.seed()
    let fail = true
    const a = marker('0001', {
      onPage: n => {
        if (n === 3 && fail) {
          fail = false
          throw new Error('boom')
        }
      },
    })
    await expect(runMigrations(w.table, { migrations: [a.m], pageSize: 10 })).rejects.toThrow(
      'boom'
    )
    expect(await w.table.get('MIGRATION#0001', 'LOCK')).toBeNull()
    expect(await migrationState(w.table, '0001')).toMatchObject({ status: 'running', pages: 2 })
    const run = await runMigrations(w.table, { migrations: [a.m], pageSize: 10 })
    expect(run.migrations[0]).toMatchObject({ status: 'completed', scanned: 25 })
    for (const item of await all(w.table)) {
      if (item.pk.startsWith('ITEM#')) expect(item.seen0001).toBe(1)
    }
  })

  it("a crashed run's lock holds until its lease runs out, then the next run takes over", async () => {
    const w = world()
    await w.seed()
    // A run that died after checkpointing page 1, still holding the lock.
    const crashed = marker('0001')
    await runMigrations(w.table, {
      migrations: [crashed.m],
      pageSize: 10,
      now: w.clock,
      deadline: T0, // stop before any page
    })
    await w.table.put({
      pk: 'MIGRATION#0001',
      sk: 'LOCK',
      owner: 'dead-run',
      expiresAt: new Date(T0 + 60_000).toISOString(),
    })
    const a = marker('0001')
    const opts = { migrations: [a.m], pageSize: 10, now: w.clock }
    const busy = await runMigrations(w.table, opts)
    expect(busy.done).toBe(false)
    expect(busy.migrations[0]).toMatchObject({
      status: 'busy',
      lockedBy: 'dead-run',
      lockedUntil: new Date(T0 + 60_000).toISOString(),
    })
    expect(a.applied).toEqual([])
    w.advance(60_000)
    expect((await runMigrations(w.table, opts)).migrations[0]?.status).toBe('completed')
  })

  it('a run that outlived its lease stops at its next checkpoint', async () => {
    const w = world()
    await w.seed()
    const a = marker('0001', {
      onPage: n => {
        if (n === 2) w.advance(120_001) // paused past the lease; someone else may have it now
      },
    })
    const run = runMigrations(w.table, {
      migrations: [a.m],
      pageSize: 10,
      now: w.clock,
      leaseMs: 120_000,
    })
    await expect(run).rejects.toBeInstanceOf(LeaseLost)
    expect(await migrationState(w.table, '0001')).toMatchObject({ pages: 1 })
  })

  it('concurrent runs: one does the work, the others report busy', async () => {
    const w = world()
    await w.seed()
    const a = marker('0001')
    const runs = await Promise.all(
      Array.from({ length: 3 }, () => runMigrations(w.table, { migrations: [a.m], pageSize: 5 }))
    )
    const statuses = runs.map(r => r.migrations[0]?.status).sort()
    expect(statuses.filter(s => s === 'completed')).toHaveLength(1)
    for (const item of await all(w.table)) {
      if (item.pk.startsWith('ITEM#')) expect(item.seen0001).toBe(1)
    }
  })

  it('a dry run reports and writes nothing, not even its own state', async () => {
    const w = world()
    await w.seed()
    const before = await all(w.table)
    const a = marker('0001')
    const run = await runMigrations(w.table, { migrations: [a.m], dryRun: true, pageSize: 10 })
    expect(run).toMatchObject({ done: true, dryRun: true })
    expect(run.migrations[0]).toMatchObject({
      status: 'completed',
      scanned: 25,
      counts: { marked: 25, 'dry-run writes': 25 },
    })
    expect(await all(w.table)).toEqual(before)
  })
})

describe('scan is for migrations only', () => {
  it('nothing in apps/api/src outside migrations/ and table/ calls it', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url))
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path) : [path]
      })
    const offenders = files(src)
      .filter(f => !/^(migrations|table)\//.test(relative(src, f)))
      .filter(f => /\.scan\s*\(/.test(readFileSync(f, 'utf8')))
      .map(f => relative(src, f))
    expect(offenders).toEqual([])
  })
})
