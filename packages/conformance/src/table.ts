/**
 * Table conformance: the semantics `Records` is written against (see @fling/api/table), down to
 * sort-key byte order, prefix boundaries, paging, expiry, every condition, transaction atomicity
 * and the races conditional writes exist for. Each test works in its own random partition, so a
 * shared table needs no cleanup.
 */
import { randomUUID } from 'node:crypto'
import {
  ConditionFailed,
  compareSk,
  decodeCursor,
  encodeCursor,
  fieldEquals,
  ifAbsent,
  ifExists,
  type Table,
  type TableItem,
} from '@fling/api/table'
import { MAX_PATH_BYTES } from '@fling/shared'
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

      it('round-trips NUL in strings and field names, and lone surrogates in strings', async () => {
        const { table, pk } = await setup()
        const odd = {
          nul: 'a\u0000b',
          high: 'x\ud800',
          low: '\udc00y',
          pair: 'smile \u{1F600}',
          list: ['\u0000', '\udfff', 'plain'],
          map: { 'k\u0000': 'v', nested: { '\u0000': ['\ud83d'] } },
          // what an adapter's own escaping might look like, stored as given
          lookalike: { '~fling~esc': 's', u: [0] },
          text: '\\u0000 and \\ud800',
        }
        await table.put({ pk, sk: 'A', ...odd })
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', ...odd })
        expect((await table.query(pk)).items).toEqual([{ pk, sk: 'A', ...odd }])
        const updated = await table.update(
          pk,
          'A',
          { set: { nul: 'b\u0000c' } },
          fieldEquals('nul', 'a\u0000b')
        )
        expect(updated.nul).toBe('b\u0000c')
        await fails(table.put({ pk, sk: 'A' }, fieldEquals('nul', 'a\u0000b')))
        await table.put({ pk, sk: 'A' }, fieldEquals('nul', 'b\u0000c'))
      })

      it('a key no item can have (NUL, a lone surrogate) reads as absent and is never stored', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'a\uFFFD' })
        for (const [p, k] of [
          [pk, 'a\u0000'],
          [pk, 'a\ud800'],
          [`${pk}\u0000`, 'A'],
          [`${pk}\udc00`, 'A'],
        ] as const) {
          expect(await table.get(p, k)).toBeNull()
          expect(await table.delete(p, k)).toBeNull()
          await fails(table.update(p, k, { set: { a: 1 } }))
          await fails(table.delete(p, k, ifExists))
          await expect(table.put({ pk: p, sk: k })).rejects.toThrow(/NUL or a lone surrogate/)
          await expect(table.transact([{ put: { pk: p, sk: k } }])).rejects.toThrow(
            /NUL or a lone surrogate/
          )
        }
        expect((await table.query(pk, { skPrefix: 'a\u0000' })).items).toEqual([])
        expect((await table.query(pk, { skPrefix: 'a\ud800' })).items).toEqual([])
        expect((await table.query(`${pk}\ud800`)).items).toEqual([])
        expect(sks((await table.query(pk)).items)).toEqual(['a\uFFFD'])
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

      it("orders, matches and pages the longest keys a site's paths make", async () => {
        const { table, pk } = await setup()
        // A path of MAX_PATH_BYTES in 4-byte characters, and keys that differ only past it.
        const path = '😀'.repeat(MAX_PATH_BYTES / 4)
        const all = [`FILE#${path}`, `FILE#${path}/a`, `FILE#${path}/b`, `FILE#${path}é`]
        for (const sk of [...all].reverse()) await table.put({ pk, sk })
        expect(sks((await table.query(pk)).items)).toEqual(all)
        expect(sks((await table.query(pk, { skPrefix: `FILE#${path}/` })).items)).toEqual(
          all.slice(1, 3)
        )
        expect((await pages(table, pk, {}, 1)).flatMap(sks)).toEqual(all)
        expect((await pages(table, pk, { reverse: true }, 3)).flatMap(sks)).toEqual(
          [...all].reverse()
        )
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

      it('a cursor that decodes to a NUL resumes in byte order', async () => {
        const { table, pk } = await setup()
        for (const sk of ['a', 'b', 'c']) await table.put({ pk, sk })
        const at = (sk: string) => encodeCursor(sk)
        expect(sks((await table.query(pk, { cursor: at('a\u0000z') })).items)).toEqual(['b', 'c'])
        expect(
          sks((await table.query(pk, { cursor: at('b\u0000'), reverse: true })).items)
        ).toEqual(['b', 'a'])
      })

      it('takes quotes, placeholders, wildcards and comment markers as plain data', async () => {
        const { table, pk: base } = await setup()
        const pk = `${base}'"; DROP TABLE items; --`
        const odd = ["a'b", 'a"b', '$1', 'a%b', 'a_b', 'axb', 'ayb', 'a\\b', '--', ';', 'é—😀']
        for (const sk of odd) await table.put({ pk, sk, v: `${sk} $2 %_ \\ ' ; --` })
        for (const sk of odd) {
          expect(await table.get(pk, sk)).toEqual({ pk, sk, v: `${sk} $2 %_ \\ ' ; --` })
        }
        expect(sks((await table.query(pk)).items)).toEqual([...odd].sort(compareSk))
        // A prefix matches literally: `%` and `_` are characters, never wildcards.
        expect(sks((await table.query(pk, { skPrefix: 'a%' })).items)).toEqual(['a%b'])
        expect(sks((await table.query(pk, { skPrefix: 'a_' })).items)).toEqual(['a_b'])
        expect(sks((await table.query(pk, { skPrefix: "a'" })).items)).toEqual(["a'b"])
        expect((await table.query(pk, { skPrefix: '%' })).items).toEqual([])
        expect(await table.get(base, odd[0] as string)).toBeNull()
      })

      it('a cursor from a client is data: odd bytes resume where they sort', async () => {
        const { table, pk } = await setup()
        const all = ['a', 'b', "b'", 'c', '\u00e9', '\u{1F600}']
        for (const sk of all) await table.put({ pk, sk })
        const cursors = [
          Buffer.from([0xff, 0xfe, 0x62]).toString('base64url'),
          Buffer.from("b'; DROP TABLE items; --").toString('base64url'),
          Buffer.from('$1').toString('base64url'),
          '!!not base64!!',
        ]
        for (const cursor of cursors) {
          const after = decodeCursor(cursor)
          const expected = [...all].sort(compareSk).filter(sk => compareSk(sk, after) > 0)
          expect(sks((await table.query(pk, { cursor })).items), cursor).toEqual(expected)
        }
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

    describe('scan (migrations only)', () => {
      /** Every page of a whole-table scan; a shared table holds other tests' items too. */
      async function scanAll(table: Table, limit?: number, cursor?: string) {
        const out: TableItem[][] = []
        do {
          const page = await table.scan({ limit, cursor })
          out.push(page.items)
          cursor = page.cursor
        } while (cursor)
        return out
      }
      const ours = (items: TableItem[], prefix: string) =>
        items.filter(i => i.pk.startsWith(prefix)).map(i => `${i.pk}|${i.sk}`)

      it('visits every live item exactly once across pages, at most `limit` per page', async () => {
        const table = await factory()
        const prefix = `SCAN#${randomUUID()}#`
        const expected: string[] = []
        for (let p = 0; p < 3; p++) {
          for (let i = 0; i < 9; i++) {
            await table.put({ pk: `${prefix}${p}`, sk: `S${i}`, n: i })
            expected.push(`${prefix}${p}|S${i}`)
          }
        }
        await table.put({ pk: `${prefix}0`, sk: 'dead', expiresAt: PAST })
        const paged = await scanAll(table, 50)
        for (const page of paged) expect(page.length).toBeLessThanOrEqual(50)
        const seen = ours(paged.flat(), prefix)
        expect(seen.sort()).toEqual(expected.sort())
        expect(ours((await table.scan()).items, prefix).sort()).toEqual(expected.sort())
        const item = paged.flat().find(i => i.pk === `${prefix}1` && i.sk === 'S4')
        expect(item).toEqual({ pk: `${prefix}1`, sk: 'S4', n: 4 })
      })

      it('a cursor resumes where its page ended', async () => {
        const table = await factory()
        const prefix = `SCAN#${randomUUID()}#`
        for (let i = 0; i < 6; i++) await table.put({ pk: `${prefix}${i}`, sk: 'S' })
        const first = await table.scan({ limit: 3 })
        expect(first.items).toHaveLength(3)
        expect(first.cursor).toBeDefined()
        const rest = (await scanAll(table, 50, first.cursor)).flat()
        const all = [...first.items, ...rest]
        const keys = all.map(i => `${i.pk}|${i.sk}`)
        expect(new Set(keys).size).toBe(keys.length)
        expect(ours(all, prefix)).toHaveLength(6)
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

      it('fieldEquals guards a put in a transaction on a counter, set or not yet set', async () => {
        const { table, pk } = await setup()
        await table.put({ pk, sk: 'A' })
        const write = (rev: number | undefined, next: number) =>
          table.transact([
            { put: { pk, sk: 'A', rev: next }, cond: fieldEquals('rev', rev) },
            { put: { pk, sk: 'copy', rev: next } },
          ])
        await fails(write(1, 2))
        await write(undefined, 1)
        await fails(write(undefined, 1))
        await fails(write(2, 3))
        await write(1, 2)
        expect(await table.get(pk, 'A')).toEqual({ pk, sk: 'A', rev: 2 })
        expect(await table.get(pk, 'copy')).toEqual({ pk, sk: 'copy', rev: 2 })
        await table.delete(pk, 'A')
        await fails(write(2, 3))
        expect(await table.get(pk, 'A')).toBeNull()
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
