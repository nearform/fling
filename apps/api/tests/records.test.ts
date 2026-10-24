/**
 * What Records adds over the Store conformance suite (which runs it against every Table in
 * @fling/conformance): the items it writes, record versions and upgrade on read, expiry through
 * the table's clock, and states the Store API can't create: data written by the code from before
 * the site-centric keys (production as it is, or a Lambda rolled back to that code), and a site
 * whose name another user holds.
 */
import { describe, expect, it } from 'vitest'
import { decode, encode, type Upgrade } from '../src/store/evolution.ts'
import { Records } from '../src/store/records.ts'
import type { SiteRecord, VersionRecord } from '../src/store/types.ts'
import { MemoryTable } from '../src/table/memory.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'

const site = (email: string, name: string, overrides: Partial<SiteRecord> = {}): SiteRecord => ({
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
  ...overrides,
})

const version = (id: string, status: 'pending' | 'complete' = 'complete'): VersionRecord => ({
  siteId: 'site1',
  id,
  status,
  fileCount: 1,
  totalBytes: 10,
  createdAt: NOW,
})

/** Items exactly as the code before the site-centric keys wrote them (production: no `v`). */
const old = {
  claim: (name: string, email: string, siteId = 'site1') => ({
    pk: `NAME#${name}`,
    sk: 'NAME',
    type: 'name',
    name,
    email,
    siteId,
    createdAt: NOW,
  }),
  site: (s: SiteRecord) => ({ pk: `USER#${s.email}`, sk: `SITE#${s.name}`, type: 'site', ...s }),
  version: (email: string, v: VersionRecord) => ({
    pk: `USER#${email}`,
    sk: `VERSION#${v.siteId}#${v.id}`,
    type: 'version',
    ...v,
  }),
}

async function items(table: MemoryTable) {
  return (await table.scan()).items
}

describe('site-centric keys', () => {
  it('createSite writes the claim, the record in the site partition and the user index item', async () => {
    const table = new MemoryTable()
    const s = site('a@example.test', 'hello')
    await new Records(table).createSite(s)
    expect(await items(table)).toEqual([
      { ...old.claim('hello', s.email), v: 1 },
      { pk: 'SITE#site1', sk: 'SITE', type: 'site', v: 1, ...s },
      { pk: 'USER#a@example.test', sk: 'SITE#hello', type: 'site', v: 1, ...s },
    ])
  })

  it('versions live in the site partition, and (expand phase) at their old key too', async () => {
    const table = new MemoryTable()
    const s = site('a@example.test', 'hello')
    const records = new Records(table)
    await records.createSite(s)
    await records.putVersion(s, version('v1'))
    expect(await table.get('SITE#site1', 'VERSION#v1')).toEqual({
      pk: 'SITE#site1',
      sk: 'VERSION#v1',
      type: 'version',
      v: 1,
      ...version('v1'),
    })
    expect(await table.get('USER#a@example.test', 'VERSION#site1#v1')).toEqual({
      ...old.version(s.email, version('v1')),
      v: 1,
    })
  })

  it('deleteSite removes the partition, the index item, the old version keys and its claim', async () => {
    const table = new MemoryTable()
    const s = site('a@example.test', 'hello')
    const records = new Records(table)
    await records.createSite(s)
    await records.putVersion(s, version('v1'))
    await table.put(old.version(s.email, version('v0')))
    await records.createSite(site('a@example.test', 'other', { id: 'site2' }))
    await records.deleteSite(s)
    expect((await items(table)).map(i => `${i.pk} ${i.sk}`)).toEqual([
      'NAME#other NAME',
      'SITE#site2 SITE',
      'USER#a@example.test SITE#other',
    ])
  })

  it('deleteSite keeps a name claim held by another site', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    const stale = site('a@example.test', 'hello', { id: 'stale' })
    await records.putSite(stale)
    await table.put(old.claim('hello', 'b@example.test', 'other'))
    await records.deleteSite(stale)
    expect(await table.get('SITE#stale', 'SITE')).toBeNull()
    expect(await records.listSites('a@example.test')).toEqual([])
    expect((await records.getNameClaim('hello'))?.email).toBe('b@example.test')
  })

  it('findSite ignores a stale copy whose id is not the claim’s', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    await table.put(old.claim('hello', 'a@example.test', 'current'))
    await table.put(old.site(site('a@example.test', 'hello', { id: 'stale' })))
    expect(await records.findSite('hello')).toBeNull()
  })
})

describe('expand phase: data written by the code before the site-centric keys', () => {
  /** A site, its versions and its claim, as production holds them today. */
  async function production() {
    const table = new MemoryTable()
    const s = site('a@example.test', 'hello', { currentVersionId: 'v2' })
    await table.put(old.claim('hello', s.email))
    await table.put(old.site(s))
    await table.put(old.version(s.email, version('v1')))
    await table.put(old.version(s.email, version('v2')))
    await table.put(old.version(s.email, version('v3', 'pending')))
    return { table, records: new Records(table), s }
  }

  it('reads it fully before migration 0001 has run', async () => {
    const { records, s } = await production()
    expect(await records.findSite('hello')).toEqual(s)
    expect(await records.listSites(s.email)).toEqual([s])
    expect(await records.listVersions(s)).toEqual([
      version('v1'),
      version('v2'),
      version('v3', 'pending'),
    ])
    expect(await records.getVersion(s, 'v2')).toEqual(version('v2'))
  })

  it('sees what a rolled-back Lambda wrote after this code had written both layouts', async () => {
    const { table, records, s } = await production()
    await records.putSite(s) // this code: record and index item
    await records.putVersion(s, version('v3', 'pending'))
    // The old code, after a rollback: settings, a completed and a new version, old keys only.
    const changed = {
      ...s,
      visibility: 'public' as const,
      currentVersionId: 'v4',
      updatedAt: LATER,
    }
    await table.put(old.site(changed))
    await table.put(old.version(s.email, version('v3')))
    await table.put(old.version(s.email, version('v4')))
    expect(await records.findSite('hello')).toEqual(changed)
    expect(await records.listSites(s.email)).toEqual([changed])
    expect((await records.listVersions(s)).map(v => [v.id, v.status])).toEqual([
      ['v1', 'complete'],
      ['v2', 'complete'],
      ['v3', 'complete'],
      ['v4', 'complete'],
    ])
    expect(await records.getVersion(s, 'v3')).toEqual(version('v3'))
  })

  it('a site the old code deleted is gone, even with a record left in the site partition', async () => {
    const { table, records, s } = await production()
    await records.putSite(s)
    await table.delete(`USER#${s.email}`, 'SITE#hello')
    await table.delete('NAME#hello', 'NAME')
    expect(await records.findSite('hello')).toBeNull()
    expect(await records.listSites(s.email)).toEqual([])
  })
})

describe('record versions', () => {
  it('writes type and v with the record', async () => {
    const table = new MemoryTable()
    await new Records(table).putSite(site('a@example.test', 'hello'))
    expect(await table.get('SITE#site1', 'SITE')).toEqual({
      pk: 'SITE#site1',
      sk: 'SITE',
      type: 'site',
      v: 1,
      ...site('a@example.test', 'hello'),
    })
  })

  it('reads items written before versioning (no v) as v1', async () => {
    const table = new MemoryTable()
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put(old.site(site('a@example.test', 'hello')))
    expect(await new Records(table).findSite('hello')).toEqual(site('a@example.test', 'hello'))
  })

  it('reads a record one version ahead, passing unknown fields through', async () => {
    const table = new MemoryTable()
    const ahead = { ...site('a@example.test', 'hello'), reviewers: ['b@example.test'] }
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: 2, ...ahead })
    expect(await new Records(table).findSite('hello')).toEqual(ahead)
  })

  it('refuses a record two versions ahead', async () => {
    const table = new MemoryTable()
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: 3 })
    await expect(new Records(table).findSite('hello')).rejects.toThrow(/v3/)
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
