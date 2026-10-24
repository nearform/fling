/** RouteTable conformance: the key/value semantics the site lifecycle relies on. */
import { randomUUID } from 'node:crypto'
import type { RouteTable } from '@fling/api/route-table'
import { describe, expect, it } from 'vitest'

export function routeTableConformance(
  name: string,
  factory: () => RouteTable | Promise<RouteTable>
) {
  describe(`RouteTable conformance: ${name}`, () => {
    const key = () => `site:conformance-${randomUUID()}`

    it('get of a missing key is undefined', async () => {
      const table = await factory()
      expect(await table.get(key())).toBeUndefined()
    })

    it('put then get; put again overwrites', async () => {
      const table = await factory()
      const k = key()
      await table.put(k, '{"id":"a","v":"1"}')
      expect(await table.get(k)).toBe('{"id":"a","v":"1"}')
      await table.put(k, '{"id":"a","v":"2"}')
      expect(await table.get(k)).toBe('{"id":"a","v":"2"}')
    })

    it('delete removes the key; deleting a missing key is a no-op', async () => {
      const table = await factory()
      const k = key()
      await table.put(k, 'x')
      await table.delete(k)
      expect(await table.get(k)).toBeUndefined()
      await expect(table.delete(k)).resolves.toBeUndefined()
      await expect(table.delete(key())).resolves.toBeUndefined()
    })

    it('keys are independent', async () => {
      const table = await factory()
      const [a, b] = [key(), key()]
      await table.put(a, 'A')
      await table.put(b, 'B')
      await table.delete(a)
      expect(await table.get(a)).toBeUndefined()
      expect(await table.get(b)).toBe('B')
    })

    it('concurrent writes to different keys all land', async () => {
      const table = await factory()
      const keys = Array.from({ length: 8 }, key)
      await Promise.all(keys.map((k, i) => table.put(k, String(i))))
      expect(await Promise.all(keys.map(k => table.get(k)))).toEqual(keys.map((_, i) => String(i)))
    })
  })
}
