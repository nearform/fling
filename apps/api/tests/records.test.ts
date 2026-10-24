/**
 * What Records adds over the Store conformance suite (which runs it against every Table in
 * @fling/conformance): record versions, upgrade on read, expiry through the table's clock, and
 * states the Store API can't create (a site whose name another user holds).
 */
import { describe, expect, it } from 'vitest'
import { decode, encode, type Upgrade } from '../src/store/evolution.ts'
import { Records } from '../src/store/records.ts'
import { MemoryTable } from '../src/table/memory.ts'

const NOW = '2026-01-01T00:00:00.000Z'

const site = (email: string, name: string) => ({
  id: 'site1',
  email,
  name,
  visibility: 'private' as const,
  spa: false,
  archived: false,
  currentVersionId: null,
  shareToken: null,
  createdAt: NOW,
  updatedAt: NOW,
})

describe('record versions', () => {
  it('writes type and v with the record', async () => {
    const table = new MemoryTable()
    await new Records(table).putSite(site('a@example.test', 'hello'))
    expect(await table.get('USER#a@example.test', 'SITE#hello')).toEqual({
      pk: 'USER#a@example.test',
      sk: 'SITE#hello',
      type: 'site',
      v: 1,
      ...site('a@example.test', 'hello'),
    })
  })

  it('reads items written before versioning (no v) as v1', async () => {
    const table = new MemoryTable()
    await table.put({
      pk: 'USER#a@example.test',
      sk: 'SITE#hello',
      type: 'site',
      ...site('a@example.test', 'hello'),
    })
    expect(await new Records(table).getSite('a@example.test', 'hello')).toEqual(
      site('a@example.test', 'hello')
    )
  })

  it('reads a record one version ahead, passing unknown fields through', async () => {
    const table = new MemoryTable()
    const ahead = { ...site('a@example.test', 'hello'), reviewers: ['b@example.test'] }
    await table.put({ pk: 'USER#a@example.test', sk: 'SITE#hello', type: 'site', v: 2, ...ahead })
    expect(await new Records(table).getSite('a@example.test', 'hello')).toEqual(ahead)
  })

  it('refuses a record two versions ahead', async () => {
    const table = new MemoryTable()
    await table.put({ pk: 'USER#a@example.test', sk: 'SITE#hello', type: 'site', v: 3 })
    await expect(new Records(table).getSite('a@example.test', 'hello')).rejects.toThrow(/v3/)
  })

  it('upgrades old records step by step on read, and writes the current version', () => {
    const upgrades: Record<string, Upgrade[]> = {
      site: [
        ({ spa, ...rest }) => ({ ...rest, mode: spa ? 'spa' : 'static' }),
        fields => ({ ...fields, tags: [] }),
      ],
    }
    const v1 = { pk: 'P', sk: 'S', type: 'site', name: 'hello', spa: true }
    expect(decode('site', v1, upgrades)).toEqual({ name: 'hello', mode: 'spa', tags: [] })
    const v2 = { pk: 'P', sk: 'S', type: 'site', v: 2, name: 'hello', mode: 'static' }
    expect(decode('site', v2, upgrades)).toEqual({ name: 'hello', mode: 'static', tags: [] })
    expect(encode('site', { pk: 'P', sk: 'S' }, { name: 'x' }, upgrades).v).toBe(3)
  })

  it('the API-key lookup item keeps its old shape (no type)', async () => {
    const table = new MemoryTable()
    await new Records(table).createApiKey({
      id: 'k1',
      email: 'a@example.test',
      name: 'cli',
      hash: 'h1',
      createdAt: NOW,
      lastUsedAt: null,
    })
    expect(await table.get('APIKEY#h1', 'APIKEY')).toEqual({
      pk: 'APIKEY#h1',
      sk: 'APIKEY',
      email: 'a@example.test',
      id: 'k1',
      v: 1,
    })
  })
})

describe('Records', () => {
  it('deleteSite deletes the site but keeps a name claim another user holds', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    await records.putSite(site('a@example.test', 'hello'))
    await table.put({
      pk: 'NAME#hello',
      sk: 'NAME',
      type: 'name',
      name: 'hello',
      email: 'b@example.test',
      siteId: 'other',
      createdAt: NOW,
    })
    await records.deleteSite('a@example.test', 'hello')
    expect(await records.getSite('a@example.test', 'hello')).toBeNull()
    expect((await records.getNameClaim('hello'))?.email).toBe('b@example.test')
  })

  it('expired records disappear on the table clock', async () => {
    let now = Date.parse(NOW)
    const records = new Records(new MemoryTable(() => now))
    const expiresAt = new Date(now + 60_000).toISOString()
    await records.putUpload({
      id: 'u1',
      email: 'a@example.test',
      name: 'x',
      createdAt: NOW,
      expiresAt,
    })
    expect(await records.getUpload('u1')).not.toBeNull()
    now += 60_000
    expect(await records.getUpload('u1')).toBeNull()
  })
})
