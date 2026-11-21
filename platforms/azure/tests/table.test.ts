/**
 * What CosmosTable does beyond the Table port's conformance suite: the purge time it gives an
 * expiring item, and the batches it refuses before sending. On the Cosmos DB emulator, skipped
 * unless its endpoint is configured (see services.ts).
 */
import type { Container } from '@azure/cosmos'
import { beforeAll, describe, expect, it } from 'vitest'
import { CosmosTable, idOf, PARTITION } from '../src/table/cosmos.ts'
import { COSMOS_ENDPOINT, cosmosContainer } from './services.ts'

const NOW = Date.parse('2026-01-01T00:00:00.000Z')

describe.runIf(COSMOS_ENDPOINT)('CosmosTable on the emulator', () => {
  let container: Container
  let table: CosmosTable
  beforeAll(async () => {
    container = await cosmosContainer()
    table = new CosmosTable(container, { now: () => NOW })
  }, 120_000)

  const ttlOf = async (pk: string, sk: string) =>
    (await container.item(idOf({ pk, sk }), PARTITION).read<{ ttl?: number }>()).resource?.ttl

  it('purges an expiring item an hour after its expiry, and one beyond the longest ttl never', async () => {
    const pk = `ttl-${crypto.randomUUID()}`
    await table.put({ pk, sk: 'soon', expiresAt: new Date(NOW + 60_000).toISOString() })
    expect(await ttlOf(pk, 'soon')).toBe(60 + 3600)
    await table.put({ pk, sk: 'far', expiresAt: '9999-01-01T00:00:00.000Z' })
    expect(await ttlOf(pk, 'far')).toBeUndefined()
    expect(await table.get(pk, 'far')).toMatchObject({ sk: 'far' })
  })

  it('refuses a transact naming one item twice', async () => {
    const pk = `dup-${crypto.randomUUID()}`
    await expect(
      table.transact([{ put: { pk, sk: 'a' } }, { delete: { pk, sk: 'a' } }])
    ).rejects.toThrow(/distinct items/)
    expect(await table.get(pk, 'a')).toBeNull()
  })

  it('refuses a transact larger than a batch takes, writing nothing', async () => {
    const pk = `big-${crypto.randomUUID()}`
    const blob = 'x'.repeat(300_000)
    const ops = Array.from({ length: 8 }, (_, i) => ({ put: { pk, sk: `s${i}`, blob } }))
    await expect(table.transact(ops)).rejects.toThrow(/2 MB/)
    expect((await table.query(pk)).items).toEqual([])
  })
})
