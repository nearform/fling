/**
 * What D1Table relies on from D1 beyond the conformance suite: that a failing statement rolls back
 * a whole batch (including writes that already ran), that TEXT sort keys order by UTF-8 bytes, the
 * schema migration as wrangler splits it, and the expired-item purge.
 */
import type { D1Database } from '@cloudflare/workers-types'
import { ConditionFailed, compareSk, fieldEquals, ifAbsent } from '@fling/api/table'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { D1Table } from '../src/table/d1.ts'
import { type Local, local, statements } from './miniflare.ts'

const PAST = '2001-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

let cf: Local
let db: D1Database
beforeAll(async () => {
  cf = await local()
  db = cf.db
}, 60_000)
afterAll(() => cf?.mf.dispose())

const pk = () => `T#${crypto.randomUUID()}`
const insert = (p: string, sk: string) =>
  db.prepare("INSERT INTO items (pk, sk, data) VALUES (?, ?, '{}')").bind(p, sk)
const guard = (ok: boolean) => db.prepare(`INSERT INTO conditions (ok) SELECT ${ok ? 1 : 0}`)
const count = async (p: string) =>
  (await db.prepare('SELECT count(*) AS n FROM items WHERE pk = ?').bind(p).first<{ n: number }>())
    ?.n

describe('D1 batch atomicity (the guard pattern D1Table is built on)', () => {
  it('a failing guard after writes rolls back the writes that already ran', async () => {
    const p = pk()
    await insert(p, 'existing').run()
    const err = await db
      .batch([
        insert(p, 'a'),
        db.prepare('DELETE FROM items WHERE pk = ? AND sk = ?').bind(p, 'existing'),
        guard(false),
        insert(p, 'b'),
      ])
      .catch(e => e)
    expect(String(err?.message)).toContain('fling: condition failed')
    expect(await count(p)).toBe(1)
    expect(await db.prepare('SELECT sk FROM items WHERE pk = ?').bind(p).first('sk')).toBe(
      'existing'
    )
  })

  it('any failing statement (a constraint) rolls back the batch too', async () => {
    const p = pk()
    await insert(p, 'taken').run()
    await expect(db.batch([insert(p, 'a'), insert(p, 'taken')])).rejects.toThrow()
    expect(await count(p)).toBe(1)
  })

  it('a passing guard stores nothing; the writes commit', async () => {
    const p = pk()
    await db.batch([guard(true), insert(p, 'a'), guard(true)])
    expect(await count(p)).toBe(1)
    expect(await db.prepare('SELECT count(*) AS n FROM conditions').first('n')).toBe(0)
  })

  it('a conditional single write is as atomic: a lost race changes nothing', async () => {
    const table = new D1Table(db)
    const p = pk()
    await table.put({ pk: p, sk: 'A', owner: 'x' })
    await expect(
      table.put({ pk: p, sk: 'A', owner: 'y' }, fieldEquals('owner', 'y'))
    ).rejects.toBeInstanceOf(ConditionFailed)
    expect(await table.get(p, 'A')).toEqual({ pk: p, sk: 'A', owner: 'x' })
  })
})

describe('D1Table specifics', () => {
  it('orders TEXT sort keys by UTF-8 bytes, including the BMP private use area', async () => {
    const table = new D1Table(db)
    const p = pk()
    // U+E000 sorts after 😀 in UTF-16 (JS `<`) but before it in UTF-8.
    const sks = ['a', '', '�', '😀', 'é', 'Z', '\u0000x']
    for (const sk of sks) await table.put({ pk: p, sk })
    const got = (await table.query(p)).items.map(i => i.sk)
    expect(got).toEqual([...sks].sort(compareSk))
    expect(got.indexOf('')).toBeLessThan(got.indexOf('😀'))
  })

  it('fieldEquals tells 1, "1" and true apart', async () => {
    const table = new D1Table(db)
    const p = pk()
    await table.put({ pk: p, sk: 'n', v: 1 })
    await table.put({ pk: p, sk: 'b', v: true })
    for (const [sk, wrong] of [
      ['n', '1'],
      ['n', true],
      ['b', 1],
      ['b', 'true'],
    ] as const) {
      await expect(table.put({ pk: p, sk }, fieldEquals('v', wrong))).rejects.toBeInstanceOf(
        ConditionFailed
      )
    }
  })

  it('add to a field that is not a number throws and changes nothing', async () => {
    const table = new D1Table(db)
    const p = pk()
    await table.put({ pk: p, sk: 'A', n: 'x', m: 1 })
    await expect(table.update(p, 'A', { add: { n: 1, m: 1 } })).rejects.toThrow(/not a number/)
    expect(await table.get(p, 'A')).toEqual({ pk: p, sk: 'A', n: 'x', m: 1 })
  })

  it('purgeExpired deletes dead items only, in batches', async () => {
    const fresh = await cf.freshDb()
    let now = Date.parse('2050-01-01T00:00:00.000Z')
    const table = new D1Table(fresh, () => now)
    const p = pk()
    for (let i = 0; i < 7; i++) await table.put({ pk: p, sk: `dead${i}`, expiresAt: PAST })
    await table.put({ pk: p, sk: 'later', expiresAt: FUTURE })
    await table.put({ pk: p, sk: 'forever' }, ifAbsent)
    expect(await table.purgeExpired(3)).toBe(7)
    expect(await fresh.prepare('SELECT count(*) AS n FROM items').first('n')).toBe(2)
    now = Date.parse('2100-01-01T00:00:00.000Z')
    expect(await table.purgeExpired()).toBe(1)
    expect((await table.query(p)).items.map(i => i.sk)).toEqual(['forever'])
  })
})

describe('migration statements', () => {
  it('splits on `;` at line ends but keeps a trigger body whole', () => {
    const sql = [
      '-- comment',
      'CREATE TABLE a (x INTEGER);',
      '',
      'CREATE TRIGGER t BEFORE INSERT ON a',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END;',
      'CREATE INDEX i ON a (x);',
    ].join('\n')
    expect(statements(sql)).toEqual([
      'CREATE TABLE a (x INTEGER)',
      'CREATE TRIGGER t BEFORE INSERT ON a\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'CREATE INDEX i ON a (x)',
    ])
  })
})
