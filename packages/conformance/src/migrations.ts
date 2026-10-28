/**
 * The data migrations on a real backend: 0001 (site-centric keys, expand), 0002 (contract), 0003
 * (users index) and 0004 (site directory) run by the runner over a table holding exactly what production holds today: items written by the
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
/** One migration's entry in a run's report, by id: never by position in the registry. */
function entry(run: Awaited<ReturnType<typeof runMigrations>>, id: string) {
  const found = run.migrations.find(m => m.id === id)
  if (!found) throw new Error(`migration ${id} is not in the report`)
  return found
}

/** Every migration but `id` was left alone (`only`). */
function onlyRan(run: Awaited<ReturnType<typeof runMigrations>>, id: string) {
  expect(entry(run, id).status).toBe('completed')
  expect(run.migrations.filter(m => m.id !== id).map(m => m.status)).toEqual(
    run.migrations.filter(m => m.id !== id).map(() => 'skipped')
  )
}

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
      // Every automatic migration ran; opt-in ones (auto: false) waited to be asked for.
      expect(run.migrations.map(m => [m.id, m.status])).toEqual(
        MIGRATIONS.map(m => [m.id, m.auto === false ? 'skipped' : 'completed'])
      )
      expect(entry(run, '0001').counts).toEqual({ 'site copied': 5, 'version copied': 7 })

      const after = await scanAll(table)
      // Every item that was there is still there, unchanged.
      expect(
        without(after, ['SITE#', 'SITES', 'MIGRATION#', 'USERS']).sort((x, y) =>
          keyOf(x) < keyOf(y) ? -1 : 1
        )
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

    it('0002 (opt-in) syncs site records and drops the old version keys; the API serves the same', async () => {
      const table = await seeded()
      await runMigrations(table, { migrations: MIGRATIONS })
      // What a Lambda rolled back to the old code wrote after 0001: a new version (only at its
      // old key) and newer settings (only in the index item). 0002 copies both before it deletes.
      await table.put(oldVersion('alice@example.test', 'S1', 'v4', 'complete', 4))
      const archived = oldSite('alice@example.test', 'draft', 'S3', {
        archived: true,
        updatedAt: T(5),
      })
      await table.put(archived)
      const view = await served(table)

      const run = await runMigrations(table, { migrations: MIGRATIONS, only: ['0002'] })
      onlyRan(run, '0002')
      expect(entry(run, '0002').counts).toEqual({
        'site refreshed': 1,
        'version copied': 1,
        'version dropped': 8,
      })
      const left = await scanAll(table)
      expect(left.filter(i => i.pk.startsWith('USER#') && i.sk.startsWith('VERSION#'))).toEqual([])
      expect(await table.get('SITE#S3', 'SITE')).toEqual({ ...archived, pk: 'SITE#S3', sk: 'SITE' })
      expect(await table.get('SITE#S1', 'VERSION#v4')).not.toBeNull()
      expect(await served(table)).toEqual(view)
      const again = await runMigrations(table, { migrations: MIGRATIONS, only: ['0002'] })
      expect(entry(again, '0002').status).toBe('up-to-date')
    })
    it('0003 indexes every user from their record, adds nothing else, and the list serves them', async () => {
      const table = await seeded()
      // A user who signed in on the new release already has an index item, fresher than the
      // record this run reads: kept as it is.
      const fresh = {
        pk: 'USERS',
        sk: 'USER#bob@example.test',
        type: 'userindex',
        email: 'bob@example.test',
        name: 'Bob',
        picture: null,
        userSlug: 'b',
        createdAt: T(0),
        lastSignInAt: T(9),
        v: 1,
      }
      await table.put(fresh)
      // A record from before lastSignInAt: its updatedAt was the last sign-in.
      await table.put({
        pk: 'USER#dave@example.test',
        sk: 'PROFILE',
        type: 'user',
        email: 'dave@example.test',
        name: 'Dave',
        picture: 'https://pic.example.test/d',
        userSlug: 'dave',
        createdAt: T(1),
        updatedAt: T(4),
      })
      const before = await scanAll(table)

      const run = await runMigrations(table, { migrations: MIGRATIONS, only: ['0003'] })
      onlyRan(run, '0003')
      expect(entry(run, '0003').counts).toEqual({ 'user indexed': 3, 'user present': 1 })
      const after = await scanAll(table)
      const keyed = (xs: TableItem[]) => [...xs].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))
      expect(keyed(without(after, ['USERS', 'MIGRATION#']))).toEqual(
        keyed(without(before, ['USERS']))
      )
      expect(await table.get('USERS', 'USER#bob@example.test')).toEqual(fresh)
      expect(await table.get('USERS', 'USER#dave@example.test')).toEqual({
        pk: 'USERS',
        sk: 'USER#dave@example.test',
        type: 'userindex',
        email: 'dave@example.test',
        name: 'Dave',
        picture: 'https://pic.example.test/d',
        userSlug: 'dave',
        createdAt: T(1),
        lastSignInAt: T(4),
        v: 1,
      })

      const listed = await new Records(table).listUsers({ limit: 10 })
      expect(listed.users.map(u => u.email)).toEqual([
        'alice@example.test',
        'bob@example.test',
        'carol@example.test',
        'dave@example.test',
      ])
      // The production-shaped records lack most fields: the item says unknown, not invented.
      expect(listed.users[0]).toEqual({
        email: 'alice@example.test',
        name: 'alice',
        picture: null,
        userSlug: 'a',
        createdAt: null,
        lastSignInAt: null,
      })
    })

    it('0003 is idempotent and runs on deploy after 0001', async () => {
      const table = await seeded()
      const run = await runMigrations(table, { migrations: MIGRATIONS, pageSize: 5 })
      expect(run.migrations[2]).toMatchObject({
        status: 'completed',
        counts: { 'user indexed': 3 },
      })
      const once = await scanAll(table)
      const again = await runMigrations(table, { migrations: MIGRATIONS })
      expect(again.migrations[2]?.status).toBe('up-to-date')
      const m0003 = MIGRATIONS[2]
      if (!m0003) throw new Error('no 0003')
      const counts: Record<string, number> = {}
      await m0003.apply(without(once, ['MIGRATION#']), {
        table,
        dryRun: false,
        count: (what, n = 1) => {
          counts[what] = (counts[what] ?? 0) + n
        },
      })
      expect(counts).toEqual({ 'user present': 3 })
      expect(await scanAll(table)).toEqual(once)
    })

    /** One migration by id, run over `items` as a page. */
    async function applyOne(id: string, table: Table, items: TableItem[]) {
      const m = MIGRATIONS.find(x => x.id === id)
      if (!m) throw new Error(`no ${id}`)
      const counts: Record<string, number> = {}
      await m.apply(items, {
        table,
        dryRun: false,
        count: (what, n = 1) => {
          counts[what] = (counts[what] ?? 0) + n
        },
      })
      return counts
    }

    it('0004 lists every site in the directory, skips stale copies, keeps fresher items, adds nothing else', async () => {
      const table = await seeded()
      // A site the API saved on the new release: its directory item is fresher than what this
      // run reads, and kept as it is.
      const fresh = {
        pk: 'SITES',
        sk: 'SITE#pub',
        type: 'sitedirectory',
        siteId: 'S4',
        name: 'pub',
        owner: 'bob@example.test',
        createdAt: T(0),
        updatedAt: T(9),
        archived: false,
        live: true,
        restricted: false,
        access: 'public',
        v: 1,
      }
      await table.put(fresh)
      // A site from after audiences, restricted to people, whose record (in its partition) is
      // newer than its index item: the newer copy is the site.
      const team = oldSite('carol@example.test', 'team', 'S5', {
        currentVersionId: 'v1',
        audience: { emails: ['dave@example.test'], groups: ['g1'] },
        v: 2,
      })
      await table.put(team)
      await table.put({ ...team, pk: 'SITE#S5', sk: 'SITE', archived: true, updatedAt: T(3) })
      await table.put(claim('team', 'carol@example.test', 'S5'))
      // Restricted to the owner alone (the only_me level).
      const mine = oldSite('carol@example.test', 'mine', 'S6', { restricted: true, v: 2 })
      await table.put(mine)
      await table.put(claim('mine', 'carol@example.test', 'S6'))
      const before = await scanAll(table)

      const run = await runMigrations(table, { migrations: MIGRATIONS, only: ['0004'] })
      onlyRan(run, '0004')
      expect(entry(run, '0004').counts).toEqual({
        'site indexed': 5,
        'site present': 1,
        'site skipped (stale)': 1,
      })
      const after = await scanAll(table)
      const keyed = (xs: TableItem[]) => [...xs].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1))
      expect(keyed(without(after, ['SITES', 'MIGRATION#']))).toEqual(
        keyed(without(before, ['SITES']))
      )
      expect(await table.get('SITES', 'SITE#pub')).toEqual(fresh)
      expect(await table.get('SITES', 'SITE#team')).toEqual({
        pk: 'SITES',
        sk: 'SITE#team',
        type: 'sitedirectory',
        siteId: 'S5',
        name: 'team',
        owner: 'carol@example.test',
        createdAt: T(0),
        updatedAt: T(3),
        archived: true,
        live: true,
        restricted: true,
        access: 'people',
        v: 1,
      })

      const listed = await new Records(table).listAllSites({ limit: 10 })
      expect(listed.sites.map(x => [x.name, x.owner, x.access, x.archived, x.live])).toEqual([
        ['docs', 'alice@example.test', 'members', true, true],
        ['draft', 'alice@example.test', 'members', false, false],
        ['hello', 'alice@example.test', 'members', false, true],
        ['mine', 'carol@example.test', 'only_me', false, false],
        ['pub', 'bob@example.test', 'public', false, true],
        ['team', 'carol@example.test', 'people', true, true],
      ])
      expect(listed.sites.find(x => x.name === 'hello')?.siteId).toBe('S1')
    })

    it('0004 is idempotent and runs on deploy after 0001', async () => {
      const table = await seeded()
      const run = await runMigrations(table, { migrations: MIGRATIONS, pageSize: 5 })
      expect(entry(run, '0004')).toMatchObject({
        status: 'completed',
        counts: { 'site indexed': 4, 'site skipped (stale)': 1 },
      })
      const once = await scanAll(table)
      const again = await runMigrations(table, { migrations: MIGRATIONS })
      expect(entry(again, '0004').status).toBe('up-to-date')
      expect(await applyOne('0004', table, without(once, ['MIGRATION#']))).toEqual({
        'site present': 4,
        'site skipped (stale)': 1,
      })
      expect(await scanAll(table)).toEqual(once)
    })

    it('0004 takes back the item of a site deleted while it ran', async () => {
      const table = await seeded()
      // The site is deleted (its claim released) just as the item is written.
      const put: Table['put'] = async (item, cond) => {
        await table.put(item, cond)
        if (item.pk === 'SITES' && item.sk === 'SITE#draft')
          await table.delete('NAME#draft', 'NAME')
      }
      const racing = new Proxy(table, {
        get(target, prop) {
          if (prop === 'put') return put
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const draft = await table.get('USER#alice@example.test', 'SITE#draft')
      if (!draft) throw new Error('no draft')
      expect(await applyOne('0004', racing, [draft])).toEqual({ 'site gone': 1 })
      expect(await table.get('SITES', 'SITE#draft')).toBeNull()
    })
  })
}
