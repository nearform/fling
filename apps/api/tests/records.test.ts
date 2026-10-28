/**
 * What Records adds over the Store conformance suite (which runs it against every Table in
 * @fling/conformance): the items it writes, record versions and upgrade on read, expiry through
 * the table's clock, and states the Store API can't create: data written by the code from before
 * the site-centric keys (production as it is, or a Lambda rolled back to that code), and a site
 * whose name another user holds.
 */
import { describe, expect, it, vi } from 'vitest'
import { currentVersion, decode, encode, type Upgrade } from '../src/store/evolution.ts'
import { Records } from '../src/store/records.ts'
import { listingOf, type SiteRecord, type VersionRecord } from '../src/store/types.ts'
import { MemoryTable } from '../src/table/memory.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const SITE_V = currentVersion('site')
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
  audience: { emails: [], groups: [] },
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
  it('createSite writes the claim, the record in the site partition, the user index item and the directory item', async () => {
    const table = new MemoryTable()
    const s = site('a@example.test', 'hello')
    await new Records(table).createSite(s)
    expect(await items(table)).toEqual([
      { ...old.claim('hello', s.email), v: 1 },
      { pk: 'SITE#site1', sk: 'SITE', type: 'site', v: SITE_V, ...s },
      {
        pk: 'SITES',
        sk: 'SITE#hello',
        type: 'sitedirectory',
        v: 1,
        ...listingOf(s),
        access: 'members',
      },
      { pk: 'USER#a@example.test', sk: 'SITE#hello', type: 'site', v: SITE_V, ...s },
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

  it('deleteSite removes the partition, the index and directory items, the old version keys and its claim', async () => {
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
      'SITES SITE#other',
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

  it("deleteSite of a stale copy keeps the holder's directory item", async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    const holder = site('b@example.test', 'hello', { id: 'holder' })
    await records.createSite(holder)
    const stale = site('a@example.test', 'hello', { id: 'stale' })
    await table.put({ ...old.site(stale), pk: 'SITE#stale', sk: 'SITE' })
    await records.deleteSite(stale)
    expect((await records.listAllSites({ limit: 10 })).sites).toEqual([
      { ...listingOf(holder), access: 'members' },
    ])
    expect(await records.findSite('hello')).toEqual(holder)
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

describe('direct grants', () => {
  it('follow the audience: added addresses gain one, removed ones lose it, the owner never has one', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    const s = site('a@example.test', 'hello')
    await records.createSite(s)
    s.audience = { emails: ['b@example.test', 'c@example.test', 'a@example.test'], groups: [] }
    await records.putSite(s)
    expect((await records.listSiteGrants('b@example.test')).map(g => g.siteId)).toEqual(['site1'])
    expect(await records.listSiteGrants('a@example.test')).toEqual([])
    const grant = (await records.listSiteGrants('c@example.test'))[0]
    expect(grant).toMatchObject({ email: 'c@example.test', name: 'hello', owner: 'a@example.test' })

    s.audience = { emails: ['c@example.test', 'd@example.test'], groups: [] }
    await records.putSite(s)
    expect(await records.listSiteGrants('b@example.test')).toEqual([])
    expect(await records.listSiteGrants('c@example.test')).toHaveLength(1)
    expect(await records.listSiteGrants('d@example.test')).toHaveLength(1)
    // OAuth grants share the user partition; site grants never show up among them.
    expect(await records.listGrants('c@example.test')).toEqual([])

    await records.deleteSite(s)
    expect(await records.listSiteGrants('c@example.test')).toEqual([])
    expect(await records.listSiteGrants('d@example.test')).toEqual([])
  })

  it('a hundred addresses take more than one transaction, and all land', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    const s = site('a@example.test', 'hello')
    await records.createSite(s)
    const emails = Array.from({ length: 100 }, (_, i) => `u${i}@example.test`)
    s.audience = { emails, groups: [] }
    await records.putSite(s)
    for (const email of [emails[0], emails[50], emails[99]]) {
      expect(await records.listSiteGrants(email as string)).toHaveLength(1)
    }
    await records.putSite({ ...s, audience: { emails: [], groups: [] } })
    expect(await records.listSiteGrants(emails[99] as string)).toEqual([])
  })
})

describe('listing copies', () => {
  it('a save that changes nothing listed writes only the site and its index item', async () => {
    const table = new MemoryTable()
    const records = new Records(table)
    const s = site('a@example.test', 'hello')
    await records.createSite(s)
    const emails = Array.from({ length: 30 }, (_, i) => `u${i}@example.test`)
    s.audience = { emails, groups: [] }
    await records.putSite(s)
    const transact = vi.spyOn(table, 'transact')
    await records.putSite({ ...s, spa: true })
    expect(transact).toHaveBeenCalledTimes(1)
    expect(transact.mock.calls[0]?.[0]).toHaveLength(2)
    await records.putSite({ ...s, updatedAt: '2026-02-01T00:00:00.000Z' })
    // The site, its index and directory items, and every grant.
    expect(transact.mock.calls.slice(1).flatMap(([ops]) => ops)).toHaveLength(3 + emails.length)
    expect((await records.listSiteGrants('u29@example.test'))[0]?.updatedAt).toBe(
      '2026-02-01T00:00:00.000Z'
    )
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
      v: SITE_V,
      ...site('a@example.test', 'hello'),
    })
  })

  it('reads items written before versioning (no v) as v1', async () => {
    const table = new MemoryTable()
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put(old.site(site('a@example.test', 'hello')))
    expect(await new Records(table).findSite('hello')).toEqual(site('a@example.test', 'hello'))
  })

  it('reads a v1 site (no audience) as having the empty audience, and keeps one a v1 reader wrote back', async () => {
    const table = new MemoryTable()
    const { audience: _none, ...v1 } = site('a@example.test', 'hello')
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: 1, ...v1 })
    const records = new Records(table)
    expect((await records.findSite('hello'))?.audience).toEqual({ emails: [], groups: [] })
    const kept = { emails: ['b@example.test'], groups: [] }
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: 1, ...v1, audience: kept })
    expect((await records.findSite('hello'))?.audience).toEqual(kept)
  })

  it('reads a record one version ahead, passing unknown fields through', async () => {
    const table = new MemoryTable()
    const ahead = { ...site('a@example.test', 'hello'), reviewers: ['b@example.test'] }
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: SITE_V + 1, ...ahead })
    expect(await new Records(table).findSite('hello')).toEqual(ahead)
  })

  it('refuses a record two versions ahead', async () => {
    const table = new MemoryTable()
    await table.put(old.claim('hello', 'a@example.test'))
    await table.put({ pk: 'SITE#site1', sk: 'SITE', type: 'site', v: SITE_V + 2 })
    await expect(new Records(table).findSite('hello')).rejects.toThrow(`v${SITE_V + 2}`)
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
