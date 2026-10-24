/**
 * Table conformance: the semantics `Records` is written against (see @fling/api/table), down to
 * sort-key byte order, prefix boundaries, paging, expiry, every condition, transaction atomicity
 * and the races conditional writes exist for. Each test works in its own random partition, so a
 * shared table needs no cleanup.
 */
import { randomUUID } from 'node:crypto'
import {
  ConditionFailed,
  fieldEquals,
  ifAbsent,
  ifExists,
  type Table,
  type TableItem,
} from '@fling/api/table'
import { describe, expect, it } from 'vitest'

const PAST = '2001-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

const fails = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ConditionFailed)

/** All of a query's items, following cursors with the given page size. */
async function pages(
  table: Table,
  pk: string,
  opts: { skPrefix?: string; reverse?: boolean },
  limit: number
) {
  const out: TableItem[][] = []
  let cursor: string | undefined
  do {
    const page = await table.query(pk, { ...opts, limit, cursor })
    out.push(page.items)
    cursor = page.cursor
  } while (cursor)
  return out
}

const sks = (items: TableItem[]) => items.map(i => i.sk)

export function tableConformance(name: string, factory: () => Table | Promise<Table>) {
  describe(`Table conformance: ${name}`, () => {
    const setup = async () => ({ table: await factory(), pk: `T#${randomUUID()}` })

    describe('get / put', () => {
      it('round-trips every JSON type; missing items are null', async () => {
        const { table, pk } = await setup()
        expect(await table.get(pk, 'A')).toBeNull()
        const item = {
          pk,
          sk: 'A',
          s: 'text',
          empty: '',
          n: 42,
          f: 1.5,
          neg: -3,
          yes: true,
          no: false,
          nil: null,
          list: ['a', 1, null],
          map: { nested: { deep: 'x' }, arr: [{ k: 1 }] },
        }
        await table.put(item)
        expect(await table.get(pk, 'A')).toEqual(item)
        expect(await table.get(pk, 'B')).toBeNull()
        expect(await table.get(`${pk}x`, 'A')).toBeNull()
      })

      it('put replaces the whole item and drops undefined fields', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', a: 1, b: 2 })
        await table.put({ pk, sk: 'A', a: 3, c: undefined })
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', a: 3 })
      })

      it('returned items are copies', async () => {
        const { table, pk } = await setup()
        const item = { pk, sk: 'A', map: { x: 1 } }
        await table.put(item)
        item.map.x = 2
        const got = (await table.get(pk, 'A')) as TableItem & { map: { x: number } }
        expect(got.map.x).toBe(1)
        got.map.x = 3
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', map: { x: 1 } })
      })
    })

    describe('query', () => {
      it('returns the partition in UTF-8 byte order of sk (not UTF-16 or locale order)', async () => {
        const { table, pk } = await setup()
        // UTF-8: A 41, Z 5A, a 61, z 7A, é C3A9, ÿ C3BF, Ā C480, U+FFFD EFBFBD, 😀 F09F9880
        const byteOrder = ['A', 'A#10', 'A#2', 'Z', 'a', 'z', 'é', 'ÿ', 'Ā', '�', '😀']
        for (const sk of [...byteOrder].reverse()) await table.put({ pk, sk })
        await table.put({ pk: `${pk}-other`, sk: 'A' })
        expect(sks((await table.query(pk)).items)).toEqual(byteOrder)
        expect(sks((await table.query(pk, { reverse: true })).items)).toEqual(
          [...byteOrder].reverse()
        )
        expect((await table.query(pk)).cursor).toBeUndefined()
      })

      it('skPrefix matches exactly the sks that start with it', async () => {
        const { table, pk } = await setup()
        const all = ['SITE', 'SITE#', 'SITE#a', 'SITE#a#v1', 'SITE#ab', 'SITE#b', 'SITF', 'site#a']
        for (const sk of all) await table.put({ pk, sk })
        const q = async (skPrefix: string) => sks((await table.query(pk, { skPrefix })).items)
        expect(await q('SITE#a')).toEqual(['SITE#a', 'SITE#a#v1', 'SITE#ab'])
        expect(await q('SITE#a#')).toEqual(['SITE#a#v1'])
        expect(await q('SITE#')).toEqual(['SITE#', 'SITE#a', 'SITE#a#v1', 'SITE#ab', 'SITE#b'])
        expect(await q('SITE')).toEqual(all.slice(0, 6))
        expect(await q('site')).toEqual(['site#a'])
        expect(await q('nothing')).toEqual([])
        expect(await q('')).toEqual(all)
      })

      it('skPrefix with non-ASCII characters', async () => {
        const { table, pk } = await setup()
        for (const sk of ['FILE#é', 'FILE#é/a', 'FILE#e', 'FILE#ê', 'FILE#😀', 'FILE#😀x']) {
          await table.put({ pk, sk })
        }
        const q = async (skPrefix: string) => sks((await table.query(pk, { skPrefix })).items)
        expect(await q('FILE#é')).toEqual(['FILE#é', 'FILE#é/a'])
        expect(await q('FILE#😀')).toEqual(['FILE#😀', 'FILE#😀x'])
      })

      it('pages through with limit and cursor, forwards and backwards', async () => {
        const { table, pk } = await setup()
        const all = Array.from({ length: 7 }, (_, i) => `K#${i}`)
        for (const sk of all) await table.put({ pk, sk, i: 1 })
        await table.put({ pk, sk: 'L' })
        const forward = await pages(table, pk, { skPrefix: 'K#' }, 3)
        for (const page of forward) expect(page.length).toBeLessThanOrEqual(3)
        expect(forward.flatMap(sks)).toEqual(all)
        expect(forward[0]?.length).toBe(3)
        const backward = await pages(table, pk, { skPrefix: 'K#', reverse: true }, 2)
        expect(backward.flatMap(sks)).toEqual([...all].reverse())
        const one = await table.query(pk, { skPrefix: 'K#', limit: 1 })
        expect(sks(one.items)).toEqual(['K#0'])
        expect(one.cursor).toBeDefined()
        expect((await table.query(pk, { limit: 100 })).cursor).toBeUndefined()
      })

      it('a cursor stays valid when the item it ended on is deleted', async () => {
        const { table, pk } = await setup()
        for (const sk of ['a', 'b', 'c', 'd']) await table.put({ pk, sk })
        const first = await table.query(pk, { limit: 2 })
        await table.delete(pk, 'b')
        const rest = await table.query(pk, { cursor: first.cursor })
        expect(sks(rest.items)).toEqual(['c', 'd'])
      })
    })

    describe('expiry', () => {
      it('dead items are invisible to get, query and delete; live ones are not', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'dead', expiresAt: PAST })
        await table.put({ pk, sk: 'live', expiresAt: FUTURE })
        expect(await table.get(pk, 'dead')).toBeNull()
        expect(await table.get(pk, 'live')).toEqual({ pk, sk: 'live', expiresAt: FUTURE })
        expect(sks((await table.query(pk)).items)).toEqual(['live'])
        expect(await table.delete(pk, 'dead')).toBeNull()
      })

      it('paging skips dead items without losing live ones', async () => {
        const { table, pk } = await setup()
        for (let i = 0; i < 9; i++) {
          await table.put({ pk, sk: `K#${i}`, ...(i % 3 === 1 ? {} : { expiresAt: PAST }) })
        }
        expect((await pages(table, pk, {}, 2)).flatMap(sks)).toEqual(['K#1', 'K#4', 'K#7'])
      })

      it('conditions treat a dead item as absent', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', owner: 'x', expiresAt: PAST })
        await fails(table.put({ pk, sk: 'B', expiresAt: PAST }, ifExists))
        await fails(table.delete(pk, 'A', ifExists))
        await fails(table.delete(pk, 'A', fieldEquals('owner', 'x')))
        await fails(table.update(pk, 'A', { set: { y: 1 } }))
        await table.put({ pk, sk: 'A', owner: 'y' }, ifAbsent)
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', owner: 'y' })
      })

      it('update can move expiresAt, which moves visibility', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', expiresAt: FUTURE })
        const next = '2098-01-01T00:00:00.000Z'
        expect(await table.update(pk, 'A', { set: { expiresAt: next } })).toEqual({
          pk,
          sk: 'A',
          expiresAt: next,
        })
        await table.update(pk, 'A', { set: { expiresAt: PAST } })
        expect(await table.get(pk, 'A')).toBeNull()
      })

      it('rejects an expiresAt that is not a toISOString timestamp', async () => {
        const { table, pk } = await setup()
        await expect(table.put({ pk, sk: 'A', expiresAt: '2099-01-01' })).rejects.toThrow()
        await expect(
          table.put({ pk, sk: 'A', expiresAt: 4102444800 as unknown as string })
        ).rejects.toThrow()
        expect(await table.get(pk, 'A')).toBeNull()
      })
    })

    describe('conditions', () => {
      it('ifAbsent / ifExists on put', async () => {
        const { table, pk } = await setup()
        await fails(table.put({ pk, sk: 'A', n: 0 }, ifExists))
        expect(await table.get(pk, 'A')).toBeNull()
        await table.put({ pk, sk: 'A', n: 1 }, ifAbsent)
        await fails(table.put({ pk, sk: 'A', n: 2 }, ifAbsent))
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', n: 1 })
        await table.put({ pk, sk: 'A', n: 3 }, ifExists)
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', n: 3 })
      })

      it('fieldEquals compares strings, numbers and booleans, and needs the item', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', s: 'x', n: 1, b: true })
        await table.put({ pk, sk: 'A', s: 'y', n: 1, b: true }, fieldEquals('s', 'x'))
        await fails(table.put({ pk, sk: 'A', s: 'z' }, fieldEquals('s', 'x')))
        await fails(table.put({ pk, sk: 'A', s: 'z' }, fieldEquals('n', '1')))
        await fails(table.put({ pk, sk: 'A', s: 'z' }, fieldEquals('b', false)))
        await table.put({ pk, sk: 'A', s: 'z', n: 2, b: true }, fieldEquals('n', 1))
        await table.put({ pk, sk: 'A', s: 'w', n: 2 }, fieldEquals('b', true))
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', s: 'w', n: 2 })
        await fails(table.put({ pk, sk: 'B' }, fieldEquals('s', 'x')))
        expect(await table.get(pk, 'B')).toBeNull()
      })

      it('fieldEquals(field, undefined) means the field is not set', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', a: 1 })
        await table.update(pk, 'A', { set: { used: 'now' } }, fieldEquals('used', undefined))
        await fails(
          table.update(pk, 'A', { set: { used: 'again' } }, fieldEquals('used', undefined))
        )
        await fails(table.put({ pk, sk: 'B' }, fieldEquals('used', undefined)))
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', a: 1, used: 'now' })
      })

      it('fieldEquals with orAbsent also holds when there is no item', async () => {
        const { table, pk } = await setup()
        const cond = fieldEquals('owner', 'me', { orAbsent: true })
        await table.put({ pk, sk: 'A', owner: 'me' }, cond)
        await table.put({ pk, sk: 'A', owner: 'me', n: 1 }, cond)
        await table.put({ pk, sk: 'B', owner: 'you' })
        await fails(table.put({ pk, sk: 'B', owner: 'me' }, cond))
        expect(await table.delete(pk, 'missing', cond)).toBeNull()
        await fails(table.delete(pk, 'B', cond))
        expect(await table.delete(pk, 'A', cond)).toEqual({ pk, sk: 'A', owner: 'me', n: 1 })
      })

      it('conditions on delete', async () => {
        const { table, pk } = await setup()
        await fails(table.delete(pk, 'A', ifExists))
        await table.put({ pk, sk: 'A', s: 'x' })
        await fails(table.delete(pk, 'A', ifAbsent))
        await fails(table.delete(pk, 'A', fieldEquals('s', 'y')))
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', s: 'x' })
        expect(await table.delete(pk, 'A', fieldEquals('s', 'x'))).toEqual({ pk, sk: 'A', s: 'x' })
        expect(await table.get(pk, 'A')).toBeNull()
      })
    })

    describe('update', () => {
      it('sets, removes (undefined) and adds, returning the new item', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', keep: 'k', drop: 'd', n: 1 })
        const updated = await table.update(pk, 'A', {
          set: { drop: undefined, s: 'new', obj: { a: [1] } },
          add: { n: 2, fresh: 5 },
        })
        const expected = { pk, sk: 'A', keep: 'k', s: 'new', obj: { a: [1] }, n: 3, fresh: 5 }
        expect(updated).toEqual(expected)
        expect(await table.get(pk, 'A')).toEqual(expected)
      })

      it('never creates an item', async () => {
        const { table, pk } = await setup()
        await fails(table.update(pk, 'A', { set: { a: 1 } }))
        await fails(
          table.update(pk, 'A', { add: { n: 1 } }, fieldEquals('x', 'y', { orAbsent: true }))
        )
        expect(await table.get(pk, 'A')).toBeNull()
      })

      it('applies its condition', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', enc: 'utf8', parts: 1 })
        expect(
          (await table.update(pk, 'A', { add: { parts: 1 } }, fieldEquals('enc', 'utf8'))).parts
        ).toBe(2)
        await fails(table.update(pk, 'A', { add: { parts: 1 } }, fieldEquals('enc', 'base64')))
        expect((await table.get(pk, 'A'))?.parts).toBe(2)
      })
    })

    describe('delete', () => {
      it('returns the deleted item, or null when there was none', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', a: 1 })
        expect(await table.delete(pk, 'A')).toEqual({ pk, sk: 'A', a: 1 })
        expect(await table.delete(pk, 'A')).toBeNull()
        expect(await table.get(pk, 'A')).toBeNull()
      })
    })

    describe('transact', () => {
      it('applies puts and deletes across partitions together', async () => {
        const { table, pk } = await setup()
        const other = `${pk}-2`
        await table.put({ pk, sk: 'old' })
        await table.transact([
          { put: { pk, sk: 'A', a: 1 }, cond: ifAbsent },
          { put: { pk: other, sk: 'B', b: 2 } },
          { delete: { pk, sk: 'old' }, cond: ifExists },
          { delete: { pk, sk: 'never' } },
        ])
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', a: 1 })
        expect(await table.get(other, 'B')).toEqual({ pk: other, sk: 'B', b: 2 })
        expect(await table.get(pk, 'old')).toBeNull()
      })

      it('one false condition writes nothing at all', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'keep', v: 1 })
        await table.put({ pk, sk: 'taken', owner: 'x' })
        for (const failing of [
          { put: { pk, sk: 'taken', owner: 'y' }, cond: ifAbsent },
          { delete: { pk, sk: 'missing' }, cond: ifExists },
          { delete: { pk, sk: 'taken' }, cond: fieldEquals('owner', 'y') },
        ]) {
          const err = await table
            .transact([
              { put: { pk, sk: 'new', n: 1 }, cond: ifAbsent },
              { put: { pk, sk: 'keep', v: 2 } },
              { delete: { pk, sk: 'taken-too' } },
              failing,
            ])
            .catch(e => e)
          expect(err).toBeInstanceOf(ConditionFailed)
          expect(await table.get(pk, 'new')).toBeNull()
          expect(await table.get(pk, 'keep')).toEqual({ pk, sk: 'keep', v: 1 })
          expect(await table.get(pk, 'taken')).toEqual({ pk, sk: 'taken', owner: 'x' })
        }
      })

      it('a dead item satisfies ifAbsent inside a transaction', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', expiresAt: PAST })
        await table.transact([{ put: { pk, sk: 'A', fresh: true }, cond: ifAbsent }])
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', fresh: true })
      })
    })

    describe('races', () => {
      const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps)
      const won = (rs: PromiseSettledResult<unknown>[]) => rs.filter(r => r.status === 'fulfilled')
      const lostToCondition = (rs: PromiseSettledResult<unknown>[]) =>
        rs.filter(r => r.status === 'rejected' && r.reason instanceof ConditionFailed)

      it('N concurrent ifAbsent puts → exactly one wins', async () => {
        const { table, pk } = await setup()
        const results = await settle(
          Array.from({ length: 10 }, (_, i) => table.put({ pk, sk: 'A', who: i }, ifAbsent))
        )
        expect(won(results)).toHaveLength(1)
        expect(lostToCondition(results)).toHaveLength(9)
        const winner = results.findIndex(r => r.status === 'fulfilled')
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', who: winner })
      })

      it('concurrent conditional deletes → exactly one gets the item', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', code: 'c' })
        const results = await settle(
          Array.from({ length: 10 }, () => table.delete(pk, 'A', ifExists))
        )
        expect(won(results)).toEqual([{ status: 'fulfilled', value: { pk, sk: 'A', code: 'c' } }])
        expect(lostToCondition(results)).toHaveLength(9)
      })

      it('concurrent transactions claiming one key → exactly one commits, whole', async () => {
        const { table, pk } = await setup()
        const results = await settle(
          Array.from({ length: 6 }, (_, i) =>
            table.transact([
              { put: { pk, sk: 'NAME', who: i }, cond: ifAbsent },
              { put: { pk, sk: `SITE#${i}`, who: i }, cond: ifAbsent },
            ])
          )
        )
        expect(won(results)).toHaveLength(1)
        expect(lostToCondition(results)).toHaveLength(5)
        const winner = (await table.get(pk, 'NAME'))?.who
        expect(sks((await table.query(pk, { skPrefix: 'SITE#' })).items)).toEqual([
          `SITE#${winner}`,
        ])
      })

      it('concurrent adds all count; concurrent compare-and-set has one winner', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A', n: 0, state: 'open' })
        const adds = await Promise.all(
          Array.from({ length: 8 }, () => table.update(pk, 'A', { add: { n: 1 } }))
        )
        expect(adds.map(a => a.n).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        const cas = await settle(
          Array.from({ length: 8 }, (_, i) =>
            table.update(pk, 'A', { set: { state: `closed-${i}` } }, fieldEquals('state', 'open'))
          )
        )
        expect(won(cas)).toHaveLength(1)
        expect(lostToCondition(cas)).toHaveLength(7)
      })
    })
  })
}
