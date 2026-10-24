/**
 * The data migrations on a real backend: 0001 (site-centric keys, expand) and 0002 (contract) run
 * by the runner over a table holding exactly what production holds today: items written by the
 * code before the site-centric keys (no `v`, the old keys), including the anomalies a long-lived
 * table collects. Each test needs a table of its own (migrations scan everything and keep their
 * state in it), so the factory must return a fresh, empty one.
 */
import { MIGRATIONS, runMigrations, scanAll, verifySiteCentric } from '@fling/api/migrations'
import { Records } from '@fling/api/store/records'
import type { Table, TableItem } from '@fling/api/table'
import { describe, expect, it } from 'vitest'

const T = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString()
const FUTURE = '2099-01-01T00:00:00.000Z'

/** A site item as the pre-site-centric code wrote it. */
function oldSite(email: string, name: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    pk: `USER#${email}`,
    sk: `SITE#${name}`,
    type: 'site',
    id,
    email,
    name,
    visibility: 'private',
    spa: false,
    archived: false,
    currentVersionId: null,
    shareToken: null,
    createdAt: T(0),
    updatedAt: T(1),
    ...extra,
  }
}

function oldVersion(email: string, siteId: string, id: string, status = 'complete', n = 0) {
  return {
    pk: `USER#${email}`,
    sk: `VERSION#${siteId}#${id}`,
    type: 'version',
    siteId,
    id,
    status,
    fileCount: 2,
    totalBytes: 100 + n,
    createdAt: T(n),
  }
}

const claim = (name: string, email: string, siteId: string) => ({
  pk: `NAME#${name}`,
  sk: 'NAME',
  type: 'name',
  name,
  email,
  siteId,
  createdAt: T(0),
})

/**
 * Production-shaped data: three users; live, archived, never-published and public sites with
 * share links and several versions (one pending); plus what else lives in the table, and the
 * anomalies: a stale site record of a name someone else holds, versions of a deleted site, a
 * claim no site holds.
 */
export function legacyItems(): TableItem[] {
  const a = 'alice@example.test'
  const b = 'bob@example.test'
  const c = 'carol@example.test'
  const items: TableItem[] = []
  for (const e of [a, b, c]) {
    items.push({ pk: `USER#${e}`, sk: 'PROFILE', type: 'user', email: e, userSlug: e[0] })
    items.push({ pk: `SLUG#${e[0]}`, sk: 'SLUG', type: 'slug', email: e })
    items.push({ pk: `USER#${e}`, sk: 'KEY#k', type: 'apikey', id: 'k', email: e, hash: e })
    items.push({ pk: `APIKEY#${e}`, sk: 'APIKEY', email: e, id: 'k' })
  }
  items.push({ pk: `USER#${a}`, sk: 'GRANT#g1', type: 'grant', id: 'g1', expiresAt: FUTURE })
  items.push({ pk: 'UPLOAD#u1', sk: 'UPLOAD', type: 'upload', id: 'u1', expiresAt: FUTURE })
  items.push({ pk: 'UPLOAD#u1', sk: 'FILE#index.html', type: 'uploadfile', expiresAt: FUTURE })

  const sites: [string, string, string, Record<string, unknown>][] = [
    [a, 'hello', 'S1', { currentVersionId: 'v2', shareToken: 'abcdefghij0123456789' }],
    [a, 'docs', 'S2', { currentVersionId: 'v1', archived: true }],
    [a, 'draft', 'S3', {}],
    [b, 'pub', 'S4', { currentVersionId: 'v9', visibility: 'public', spa: true }],
  ]
  for (const [e, name, id, extra] of sites) {
    items.push(oldSite(e, name, id, extra), claim(name, e, id))
  }
  items.push(
    oldVersion(a, 'S1', 'v1', 'complete', 1),
    oldVersion(a, 'S1', 'v2', 'complete', 2),
    oldVersion(a, 'S1', 'v3', 'pending', 3),
    oldVersion(a, 'S2', 'v1', 'complete', 1),
    oldVersion(a, 'S3', 'v0', 'pending', 1),
    oldVersion(b, 'S4', 'v9', 'complete', 1)
  )
  // Anomalies already in production-like tables.
  items.push(oldSite(c, 'hello', 'S0', { updatedAt: T(-5) })) // stale: alice holds "hello"
  items.push(oldVersion(c, 'S-gone', 'v1')) // versions of a site deleted long ago
  items.push(claim('ghost', c, 'S-ghost')) // a claim no site holds
  return items
}

/** What the API serves for every user and site, through Records. */
async function served(table: Table) {
  const records = new Records(table)
  const out: Record<string, unknown> = {}
  for (const e of ['alice@example.test', 'bob@example.test', 'carol@example.test']) {
    const sites = await records.listSites(e)
    out[e] = await Promise.all(
      sites.map(async s => ({
        listed: s,
        found: await records.findSite(s.name),
        versions: await records.listVersions(s),
      }))
    )
  }
  for (const name of ['hello', 'docs', 'draft', 'pub', 'ghost']) {
    out[`find ${name}`] = await records.findSite(name)
  }
  return out
}

const keyOf = (i: TableItem) => `${i.pk}|${i.sk}`
const without = (items: TableItem[], prefixes: string[]) =>
  items.filter(i => !prefixes.some(p => i.pk.startsWith(p)))

export function migrationsConformance(name: string, freshTable: () => Promise<Table>) {
  describe(`Migrations: ${name}`, () => {
    async function seeded() {
      const table = await freshTable()
      for (const item of legacyItems()) await table.put(item)
      return table
    }

    it('0001 copies every site and version into its partition, deletes nothing, and the API serves the same', async () => {
      const table = await seeded()
      const before = await scanAll(table)
      const view = await served(table)
      const dry = await verifySiteCentric(table, { migrated: false })

      const run = await runMigrations(table, { migrations: MIGRATIONS, pageSize: 7 })
      expect(run.done).toBe(true)
      expect(run.migrations.map(m => [m.id, m.status])).toEqual([
        ['0001', 'completed'],
        ['0002', 'skipped'],
      ])
      expect(run.migrations[0]?.counts).toEqual({ 'site copied': 5, 'version copied': 7 })

      const after = await scanAll(table)
      // Every item that was there is still there, unchanged.
      expect(
        without(after, ['SITE#', 'MIGRATION#']).sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))
      ).toEqual([...before].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1)))
      expect(await table.get('SITE#S1', 'SITE')).toEqual({
        ...oldSite('alice@example.test', 'hello', 'S1', {
          currentVersionId: 'v2',
          shareToken: 'abcdefghij0123456789',
        }),
        pk: 'SITE#S1',
        sk: 'SITE',
      })
      expect(await table.get('SITE#S1', 'VERSION#v3')).toEqual({
        ...oldVersion('alice@example.test', 'S1', 'v3', 'pending', 3),
        pk: 'SITE#S1',
        sk: 'VERSION#v3',
      })

      const check = await verifySiteCentric(table)
      expect(check.failures).toEqual([])
      expect(check.ok).toBe(true)
      expect(check.warnings).toEqual(dry.warnings)
      expect(check.warnings).toEqual([
        'site hello (carol@example.test, S0): stale; the name is claimed by alice@example.test for S1',
        'version v1 of site S-gone (carol@example.test): its site is gone',
        'claim ghost (carol@example.test → S-ghost): no site holds it',
      ])
      expect(check.stats).toEqual({
        users: 3,
        'old sites': 5,
        'old versions': 7,
        claims: 5,
        'site records': 5,
        'site versions': 7,
      })
      expect(await served(table)).toEqual(view)
    })

    it('before 0001, verification fails; a dry run reports and writes nothing', async () => {
      const table = await seeded()
      expect((await verifySiteCentric(table)).failures.length).toBeGreaterThan(0)
      const before = await scanAll(table)
      const dry = await runMigrations(table, { migrations: MIGRATIONS, dryRun: true })
      expect(dry.migrations[0]).toMatchObject({
        status: 'completed',
        counts: { 'site copied': 5, 'version copied': 7, 'dry-run writes': 12 },
      })
      expect(await scanAll(table)).toEqual(before)
    })

    it('0001 is idempotent: again, or a page applied twice, changes nothing', async () => {
      const table = await seeded()
      await runMigrations(table, { migrations: MIGRATIONS })
      const once = await scanAll(table)
      const again = await runMigrations(table, { migrations: MIGRATIONS })
      expect(again.migrations[0]?.status).toBe('up-to-date')
      const m0001 = MIGRATIONS[0]
      if (!m0001) throw new Error('no 0001')
      const counts: Record<string, number> = {}
      await m0001.apply(without(once, ['MIGRATION#']), {
        table,
        dryRun: false,
        count: (what, n = 1) => {
          counts[what] = (counts[what] ?? 0) + n
        },
      })
      expect(counts).toEqual({ 'site present': 5, 'version present': 7 })
      expect(await scanAll(table)).toEqual(once)
    })

    it('0001 never overwrites a fresher copy, and replaces a staler one', async () => {
      const table = await seeded()
      // Written by the expand-phase API before the migration reached them:
      const fresher = { ...oldSite('alice@example.test', 'hello', 'S1'), updatedAt: T(9), v: 1 }
      await table.put({ ...fresher, pk: 'SITE#S1', sk: 'SITE' })
      const staler = { ...oldSite('alice@example.test', 'docs', 'S2'), updatedAt: T(-9), v: 1 }
      await table.put({ ...staler, pk: 'SITE#S2', sk: 'SITE' })
      const pending = oldVersion('bob@example.test', 'S4', 'v9', 'pending', 1)
      await table.put({ ...pending, pk: 'SITE#S4', sk: 'VERSION#v9' })
      const run = await runMigrations(table, { migrations: MIGRATIONS })
      expect(run.migrations[0]?.counts).toEqual({
        'site copied': 3,
        'site present': 1,
        'site replaced': 1,
        'version copied': 6,
        'version replaced': 1,
      })
      expect(await table.get('SITE#S1', 'SITE')).toEqual({ ...fresher, pk: 'SITE#S1', sk: 'SITE' })
      expect((await table.get('SITE#S2', 'SITE'))?.updatedAt).toBe(T(1))
      expect((await table.get('SITE#S4', 'VERSION#v9'))?.status).toBe('complete')
      expect((await verifySiteCentric(table)).failures).toEqual([])
    })

    it('0001 stopped at a deadline resumes and finishes', async () => {
      const table = await seeded()
      const first = await runMigrations(table, {
        migrations: MIGRATIONS,
        pageSize: 4,
        deadline: Date.now() - 1,
      })
      expect(first.migrations[0]?.status).toBe('partial')
      let pages = 0
      const second = await runMigrations(table, {
        migrations: MIGRATIONS,
        pageSize: 4,
        log: () => {
          pages++
        },
      })
      expect(second.done).toBe(true)
      expect(pages).toBeGreaterThan(2)
      expect((await verifySiteCentric(table)).ok).toBe(true)
    })

    it('0002 (opt-in) drops the old version keys; the API still serves the same', async () => {
      const table = await seeded()
      await runMigrations(table, { migrations: MIGRATIONS })
      const view = await served(table)
      // Something only at an old key (a rolled-back Lambda's deploy) is copied before it goes.
      await table.put(oldVersion('alice@example.test', 'S1', 'v4', 'complete', 4))
      const run = await runMigrations(table, { migrations: MIGRATIONS, only: ['0002'] })
      expect(run.migrations.map(m => [m.id, m.status])).toEqual([
        ['0001', 'skipped'],
        ['0002', 'completed'],
      ])
      expect(run.migrations[1]?.counts).toEqual({ 'version copied': 1, 'version dropped': 8 })
      const left = await scanAll(table)
      expect(left.filter(i => i.pk.startsWith('USER#') && i.sk.startsWith('VERSION#'))).toEqual([])
      const records = new Records(table)
      const hello = await records.findSite('hello')
      if (!hello) throw new Error('hello is gone')
      expect((await records.listVersions(hello)).map(v => v.id)).toEqual(['v1', 'v2', 'v3', 'v4'])
      await table.delete('SITE#S1', 'VERSION#v4')
      expect(await served(table)).toEqual(view)
      expect(
        (await runMigrations(table, { migrations: MIGRATIONS, only: ['0002'] })).migrations[1]
          ?.status
      ).toBe('up-to-date')
    })
  })
}
