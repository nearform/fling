/**
 * Soft delete and restore (deletion.ts): what a delete keeps (the recovery file, the deleted-site
 * record, the files), a retried delete, hard mode, and restoring a site or a Path as an admin from
 * their browser session: the name, who comes back, the share link, archiving, the site server, its
 * Paths, the refusals, the Usage line, and a frozen `format: 1` file.
 */
import { pathKvsKey, siteKvsKey } from '@fling/shared'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { deletedKey } from '../src/blobs/types.ts'
import type { Config } from '../src/config.ts'
import { type SiteRecovery, SiteRecoverySchema } from '../src/deletion.ts'
import type {
  ProbeRequest,
  ProbeResult,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '../src/servers/types.ts'
import type { DeletedSiteRecord, SiteRecord } from '../src/store/types.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { callTool, rpc, SESSION } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const BOSS = 'boss@example.test'

class FakeServers implements SiteServers {
  calls: string[] = []
  answer: ProbeResult = { ok: true, status: 200, logs: [] }
  async activate(_site: ServerSite, v: ServerVersion, _opts: ServerOptions) {
    this.calls.push(`activate ${v.id}`)
    return { target: 'fn-1.servers.example.test' }
  }
  async probe(_site: ServerSite, v: ServerVersion, _request: ProbeRequest) {
    this.calls.push(`probe ${v.id}`)
    return this.answer
  }
  async reconfigure(_site: ServerSite, v: ServerVersion) {
    this.calls.push(`reconfigure ${v.id}`)
    return { target: 'fn-1.servers.example.test' }
  }
  async setEnabled(site: ServerSite, enabled: boolean) {
    this.calls.push(`enabled ${site.name} ${enabled}`)
  }
  async retire(site: ServerSite) {
    this.calls.push(`retire ${site.name}`)
  }
  async invoke() {
    return new Response('ok')
  }
}

let env: Env
let info: MockInstance
let alice: Awaited<ReturnType<typeof createUser>>
let boss: Awaited<ReturnType<typeof createUser>>

async function start(overrides: Partial<Config> = {}) {
  env = setup({ adminEmails: [BOSS], ...overrides })
  alice = await createUser(env, ALICE)
  boss = await createUser(env, BOSS)
}

beforeEach(async () => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await start()
})
afterEach(() => info.mockRestore())

type Files = ReturnType<typeof file>[]
const page = (text = 'hi'): Files => [file('index.html', `<title>T</title><h1>${text}</h1>`)]

async function deploy(key: string, name: string, files: Files, body: Record<string, unknown> = {}) {
  const staged = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...body,
  })
  const res = await json(staged.clone())
  if (staged.status !== 200 || res.status !== 'upload') return staged
  await upload(env, res.uploads, files)
  return api(env, key, 'POST', `/api/sites/${name}/deploys/${res.versionId}/finalize`)
}

/** An admin's browser session (the only credential that restores). */
function asBoss(method: string, path: string, body?: unknown) {
  return env.app.request(path, {
    method,
    headers: {
      cookie: `${SESSION}=${boss.session}`,
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const route = async (name: string) =>
  JSON.parse((await env.routeTable.get(siteKvsKey(name))) ?? 'null')

const recovery = async (storageId: string) =>
  env.blobs.getJson<Record<string, unknown>>(deletedKey(storageId))

async function liveSite(name = 'deck', files = page()) {
  expect((await deploy(alice.key, name, files)).status).toBe(200)
  return (await env.store.findSite(name)) as SiteRecord
}

const restore = (siteId: string, body: object = {}) =>
  asBoss('POST', `/api/admin/deleted/${siteId}/restore`, body)

describe('a soft delete (the default)', () => {
  it('advertises recoverable deletes, and keeps the files with a recovery file and a record', async () => {
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.recoverableDeletes).toBe(true)
    const site = await liveSite()
    expect(
      (
        await api(env, alice.key, 'POST', '/api/sites/deck/comments', {
          body: 'Nice',
          path: '/',
        })
      ).status
    ).toBe(201)
    expect((await api(env, alice.key, 'DELETE', '/api/sites/deck')).status).toBe(204)

    expect(await route('deck')).toBeNull()
    expect(await env.store.findSite('deck')).toBeNull()
    expect(await env.blobs.head(`sites/${site.id}/${site.currentVersionId}/index.html`)).not.toBe(
      null
    )
    const file = SiteRecoverySchema.parse(await recovery(site.id))
    expect(file).toMatchObject({
      format: 1,
      kind: 'site',
      deletedBy: ALICE,
      site: { id: site.id, name: 'deck', currentVersionId: site.currentVersionId },
      paths: [],
      secrets: [],
    })
    expect(file.versions.map(v => v.id)).toEqual([site.currentVersionId])
    expect(file.comments.map(c => c.body)).toEqual(['Nice'])
    expect(file.bytes).toBe(file.versions[0]?.totalBytes)
    // Domain records, never Table items.
    expect(JSON.stringify(file)).not.toMatch(/"pk"|"sk"/)

    const listed = await json(await asBoss('GET', '/api/admin/deleted?name=deck'))
    expect(listed.deleted).toEqual([
      {
        kind: 'site',
        siteId: site.id,
        name: 'deck',
        owner: ALICE,
        deletedBy: ALICE,
        deletedAt: file.deletedAt,
        bytes: file.bytes,
        paths: [],
      },
    ])
    // The owner's own delete is on the record, with the site's id.
    const entry = (await env.store.listAuditEntries(10)).find(e => e.action === 'site.delete')
    expect(entry).toMatchObject({ actor: ALICE, target: 'deck', siteId: site.id, change: 'soft' })
  })

  it('frees the name at once, and a new site of that name never touches the kept files', async () => {
    const old = await liveSite('deck', page('old'))
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    const bob = await createUser(env, BOB)
    expect((await deploy(bob.key, 'deck', page('new'))).status).toBe(200)
    const fresh = (await env.store.findSite('deck')) as SiteRecord
    expect(fresh.id).not.toBe(old.id)
    const kept = await env.blobs.get(`sites/${old.id}/${old.currentVersionId}/index.html`)
    expect(Buffer.from(kept as Uint8Array).toString()).toContain('old')
    expect(await recovery(old.id)).not.toBeNull()
    // Its name is taken now, so it comes back only under another.
    const refused = await restore(old.id)
    expect(refused.status).toBe(409)
    const { error } = await json(refused)
    expect(error.code).toBe('name_taken')
    expect(error.suggestions.length).toBeGreaterThan(0)
    expect((await env.store.findSite('deck'))?.id).toBe(fresh.id)
    const back = await restore(old.id, { name: 'deck-old' })
    expect(back.status, await back.clone().text()).toBe(200)
    expect(await json(back)).toMatchObject({
      name: 'deck-old',
      url: 'https://deck-old.fling.test/',
    })
    expect((await route('deck-old')).id).toBe(old.id)
    expect((await route('deck')).id).toBe(fresh.id)
  })

  it('stores no secret values in the recovery file, only their names', async () => {
    const site = await liveSite()
    await env.store.putSiteSecret(
      { siteId: site.id, name: 'TOKEN', sealed: 'SEALED-VALUE', setBy: ALICE, setAt: 'now' },
      10
    )
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    const raw = JSON.stringify(await recovery(site.id))
    expect((await recovery(site.id))?.secrets).toEqual(['TOKEN'])
    expect(raw).not.toContain('SEALED-VALUE')
    expect(await env.store.listSiteSecrets(site.id)).toEqual([])
  })

  it('a delete that stopped part way keeps its first snapshot when retried; restoring it before is refused', async () => {
    const site = await liveSite()
    const spy = vi.spyOn(env.store, 'deleteSite').mockRejectedValueOnce(new Error('table down'))
    const failed = await api(env, alice.key, 'DELETE', '/api/sites/deck')
    expect(failed.status).toBe(500)
    spy.mockRestore()
    const first = await recovery(site.id)
    expect(await env.store.findSite('deck')).not.toBeNull()

    const incomplete = await restore(site.id)
    expect(incomplete.status).toBe(409)
    expect((await json(incomplete)).error.code).toBe('delete_incomplete')

    env.advance(60_000)
    expect((await api(env, alice.key, 'DELETE', '/api/sites/deck')).status).toBe(204)
    expect(await recovery(site.id)).toEqual(first)
    const records = (await env.store.listDeletedSites({ name: 'deck', limit: 10 })).records
    expect(records).toHaveLength(1)
    expect(records[0]?.deletedAt).toBe(first?.deletedAt)
    expect((await restore(site.id)).status).toBe(200)
  })

  it('a refused restore of a record whose files are gone says so', async () => {
    const site = await liveSite()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    await env.blobs.delete(deletedKey(site.id))
    const res = await restore(site.id)
    expect(res.status).toBe(410)
    expect((await json(res)).error.code).toBe('files_gone')
  })
})

describe('a hard delete (SITE_DELETE=hard)', () => {
  it('deletes the files, writes no recovery file or record, and is still audited', async () => {
    await start({ siteDelete: 'hard' })
    const meta = await json(await env.app.request('/.well-known/fling'))
    expect(meta.capabilities.recoverableDeletes).toBe(false)
    const site = await liveSite()
    expect((await api(env, alice.key, 'DELETE', '/api/sites/deck')).status).toBe(204)
    expect(await env.blobs.head(`sites/${site.id}/${site.currentVersionId}/index.html`)).toBeNull()
    expect(await recovery(site.id)).toBeNull()
    expect(await env.store.getDeletedSite('site', site.id)).toBeNull()
    expect((await env.store.listDeletedSites({ limit: 10 })).records).toEqual([])
    const entry = (await env.store.listAuditEntries(10)).find(e => e.action === 'site.delete')
    expect(entry).toMatchObject({ siteId: site.id, change: 'hard' })
  })

  it('refuses to start on any other value, naming the variable', async () => {
    const { loadBaseConfig } = await import('../src/config.ts')
    expect(() =>
      loadBaseConfig({
        APP_ORIGIN,
        SITES_DOMAIN: 'fling.test',
        ALLOWED_EMAIL_DOMAINS: 'example.test',
        SITE_DELETE: 'sometimes',
      })
    ).toThrow(/SITE_DELETE/)
  })
})

describe('restoring a site', () => {
  it('lists a page at a time, newest or oldest first, and only an admin learns of a bad order', async () => {
    for (const name of ['one', 'two', 'three']) {
      await liveSite(name)
      await api(env, alice.key, 'DELETE', `/api/sites/${name}`)
    }
    const pages = async (order: string) => {
      const names: string[] = []
      let cursor: string | null | undefined
      let pageCount = 0
      do {
        const query = new URLSearchParams({ order, limit: '2', ...(cursor ? { cursor } : {}) })
        const page = await json(await asBoss('GET', `/api/admin/deleted?${query}`))
        expect(page.deleted.length).toBeLessThanOrEqual(2)
        names.push(...page.deleted.map((d: { name: string }) => d.name))
        cursor = page.cursor
        pageCount++
      } while (cursor)
      return { names, pageCount }
    }
    const newest = await pages('newest')
    expect(newest.pageCount).toBeGreaterThanOrEqual(2)
    expect([...newest.names].sort()).toEqual(['one', 'three', 'two'])
    expect((await pages('oldest')).names).toEqual([...newest.names].reverse())
    const first = await json(await asBoss('GET', '/api/admin/deleted'))
    expect(first.deleted).toHaveLength(3)
    expect(first.cursor ?? null).toBeNull()

    expect((await api(env, boss.key, 'GET', '/api/admin/deleted?order=size')).status).toBe(400)
    expect((await api(env, alice.key, 'GET', '/api/admin/deleted?order=size')).status).toBe(404)
  })

  it('only an admin lists deleted sites; only their browser session restores', async () => {
    const site = await liveSite()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    expect((await api(env, alice.key, 'GET', '/api/admin/deleted')).status).toBe(404)
    expect((await api(env, boss.key, 'GET', '/api/admin/deleted')).status).toBe(200)
    const member = await api(env, alice.key, 'POST', `/api/admin/deleted/${site.id}/restore`, {})
    expect(member.status).toBe(404)
    const token = await api(env, boss.key, 'POST', `/api/admin/deleted/${site.id}/restore`, {})
    expect(token.status).toBe(403)
    expect((await json(token)).error.code).toBe('session_required')
    const path = await api(env, boss.key, 'POST', `/api/admin/deleted/${site.id}/paths/x/restore`)
    expect(path.status).toBe(403)
    expect(await env.store.findSite('deck')).toBeNull()
  })

  it('comes back live under its own name with its versions and comments, without its share link', async () => {
    const first = await liveSite('deck', page('one'))
    await deploy(alice.key, 'deck', page('two'))
    await api(env, alice.key, 'POST', '/api/sites/deck/comments', { body: 'Nice', path: '/' })
    await api(env, alice.key, 'POST', '/api/sites/deck/share')
    const before = (await env.store.findSite('deck')) as SiteRecord
    expect(before.shareToken).not.toBeNull()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')

    const res = await restore(first.id)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await json(res)).toEqual({
      name: 'deck',
      url: 'https://deck.fling.test/',
      dropped: { emails: [], groups: [] },
      adminBecameOwner: false,
    })
    const site = (await env.store.findSite('deck')) as SiteRecord
    expect(site).toMatchObject({
      id: first.id,
      currentVersionId: before.currentVersionId,
      shareToken: null,
      owners: before.owners,
      archived: false,
    })
    expect(await route('deck')).toMatchObject({ id: first.id, v: before.currentVersionId })
    expect((await env.store.listVersions(site)).length).toBe(2)
    expect((await env.store.listComments(site.id)).map(c => c.body)).toEqual(['Nice'])
    // Its owner has it back in their list.
    const listed = await json(await api(env, alice.key, 'GET', '/api/sites'))
    expect(listed.sites.map((s: { name: string }) => s.name)).toEqual(['deck'])
    // The record and the recovery file are gone; the restore is on the record.
    expect(await env.store.getDeletedSite('site', first.id)).toBeNull()
    expect(await recovery(first.id)).toBeNull()
    const entry = (await env.store.listAuditEntries(20)).find(e => e.action === 'site.restore')
    expect(entry).toMatchObject({ actor: BOSS, target: 'deck', siteId: first.id })
    // Retention applies again.
    const due = await env.store.dueMaintenance('2099-01-01T00:00:00.000Z', 50)
    expect(due.some(d => d.siteId === first.id)).toBe(true)
  })

  it('an archived site comes back archived, with no route', async () => {
    const site = await liveSite()
    await api(env, alice.key, 'POST', '/api/sites/deck/archive')
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    expect((await restore(site.id)).status).toBe(200)
    expect(await env.store.findSite('deck')).toMatchObject({ archived: true })
    expect(await route('deck')).toBeNull()
  })

  it('drops groups that are gone and people no longer on the instance; the admin owns what has no owner left', async () => {
    const site = await liveSite()
    const carol = await createUser(env, CAROL)
    expect(carol).toBeTruthy()
    const stored = (await env.store.findSite('deck')) as SiteRecord
    // Written straight to the store: what the instance allowed when they were added.
    await env.store.putSite({
      ...stored,
      owners: { emails: ['gone@elsewhere.test'], groups: ['no-such-group'] },
      publishers: { emails: [CAROL], groups: [] },
      visibility: 'private',
      restricted: true,
      audience: { emails: ['left@elsewhere.test'], groups: ['gone-group'] },
    })
    await api(env, boss.key, 'DELETE', '/api/sites/deck')
    expect(await env.store.findSite('deck')).not.toBeNull()
    // The admin's own token can't delete it (only the browser session changes a site).
    await asBoss('DELETE', '/api/sites/deck')
    expect(await env.store.findSite('deck')).toBeNull()

    const res = await json(await restore(site.id))
    expect(res.adminBecameOwner).toBe(true)
    expect(new Set(res.dropped.emails)).toEqual(
      new Set(['gone@elsewhere.test', 'left@elsewhere.test'])
    )
    expect(new Set(res.dropped.groups)).toEqual(new Set(['no-such-group', 'gone-group']))
    const back = (await env.store.findSite('deck')) as SiteRecord
    expect(back.owners).toEqual({ emails: [BOSS], groups: [] })
    expect(back.publishers).toEqual({ emails: [CAROL], groups: [] })
    expect(back.audience).toEqual({ emails: [], groups: [] })
    // Restricted as before: dropping its audience leaves it to its owners, never widens it.
    expect(back.restricted).toBe(true)
  })

  it('a frozen format 1 recovery file restores', async () => {
    const siteId = 'frozen-site-id'
    const versionId = 'v-frozen-1'
    const fixture: SiteRecovery = {
      format: 1,
      kind: 'site',
      deletedBy: ALICE,
      deletedAt: '2025-06-01T00:00:00.000Z',
      bytes: 11,
      site: {
        id: siteId,
        email: ALICE,
        name: 'frozen',
        visibility: 'public',
        spa: false,
        archived: false,
        currentVersionId: versionId,
        shareToken: 'old-share',
        audience: { emails: [], groups: [] },
        owners: { emails: [ALICE], groups: [] },
        publishers: { emails: [], groups: [] },
        revision: 7,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-05-01T00:00:00.000Z',
      },
      versions: [
        {
          siteId,
          id: versionId,
          status: 'complete',
          fileCount: 1,
          totalBytes: 11,
          publishedBy: ALICE,
          createdAt: '2025-05-01T00:00:00.000Z',
        },
      ],
      comments: [
        {
          siteId,
          id: 'c1',
          parentId: null,
          path: '/',
          versionId,
          anchor: null,
          body: 'kept',
          author: { kind: 'user', email: ALICE, name: 'Alice' },
          createdAt: '2025-05-02T00:00:00.000Z',
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
      paths: [],
      secrets: [],
    }
    await env.blobs.putJson(deletedKey(siteId), fixture)
    await env.blobs.put(
      `sites/${siteId}/${versionId}/index.html`,
      new TextEncoder().encode('<h1>x</h1>')
    )
    const record: DeletedSiteRecord = {
      kind: 'site',
      siteId,
      name: 'frozen',
      owner: ALICE,
      deletedBy: ALICE,
      deletedAt: fixture.deletedAt,
      bytes: 11,
      paths: [],
    }
    await env.store.putDeletedSite(record)
    const res = await restore(siteId)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await route('frozen')).toMatchObject({ id: siteId, v: versionId, vis: 'public' })
    expect(await env.store.findSite('frozen')).toMatchObject({ shareToken: null })
    expect((await env.store.listComments(siteId)).map(c => c.body)).toEqual(['kept'])
  })
})

describe('Paths', () => {
  const plan = (n: string) => [file(`${n}/index.html`, `<title>Plan ${n}</title><h1>${n}</h1>`)]

  it('a site restores with its Paths, live again', async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const path = await env.store.getPath(site.id, 'PAY-1')
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    expect(await env.routeTable.get(pathKvsKey(site.id, 'PAY-1'))).toBeUndefined()
    expect(await recovery(path?.id as string)).toMatchObject({
      kind: 'path',
      path: { folder: 'PAY-1' },
    })
    expect((await recovery(site.id))?.paths).toEqual([{ folder: 'PAY-1', pathId: path?.id }])
    // Deleted with its site: listed under the site, not as a record of its own.
    expect(await env.store.getDeletedSite('path', path?.id as string)).toBeNull()

    const res = await json(await restore(site.id))
    expect(res.paths).toEqual(['PAY-1'])
    expect(await env.store.getPath(site.id, 'PAY-1')).toMatchObject({ id: path?.id })
    expect(await env.routeTable.get(pathKvsKey(site.id, 'PAY-1'))).toBeDefined()
    expect(await route('team')).toMatchObject({ p: 1 })
    expect(await recovery(path?.id as string)).toBeNull()
  })

  it('a Path deleted on its own has its own record and restores into its site', async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const path = await env.store.getPath(site.id, 'PAY-1')
    const pathId = path?.id as string
    expect((await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')).status).toBe(204)
    expect(await env.routeTable.get(pathKvsKey(site.id, 'PAY-1'))).toBeUndefined()
    const listed = await json(await asBoss('GET', '/api/admin/deleted?name=team'))
    expect(listed.deleted).toMatchObject([
      { kind: 'path', siteId: site.id, name: 'team', folder: 'PAY-1', pathId },
    ])
    // Not another name's.
    expect((await json(await asBoss('GET', '/api/admin/deleted?name=tea'))).deleted).toEqual([])
    const entry = (await env.store.listAuditEntries(20)).find(e => e.action === 'path.delete')
    expect(entry).toMatchObject({ target: 'team/PAY-1', siteId: site.id })

    const res = await asBoss('POST', `/api/admin/deleted/${site.id}/paths/${pathId}/restore`)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await json(res)).toMatchObject({
      name: 'team',
      folder: 'PAY-1',
      url: 'https://team.fling.test/PAY-1/',
    })
    expect(await env.store.getPath(site.id, 'PAY-1')).toMatchObject({ id: pathId })
    expect(await env.routeTable.get(pathKvsKey(site.id, 'PAY-1'))).toBeDefined()
    expect(await env.store.getDeletedSite('path', pathId)).toBeNull()
  })

  it('refuses a Path whose folder is taken, or with no room for another live Path', async () => {
    await start({ pathsPerSite: 1 })
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const pathId = (await env.store.getPath(site.id, 'PAY-1'))?.id as string
    await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')
    const restorePath = () =>
      asBoss('POST', `/api/admin/deleted/${site.id}/paths/${pathId}/restore`)

    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const taken = await restorePath()
    expect(taken.status).toBe(409)
    expect((await json(taken)).error.code).toBe('path_taken')

    await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')
    await deploy(alice.key, 'team', plan('PAY-2'), { path: 'PAY-2' })
    const full = await restorePath()
    expect(full.status).toBe(413)
    expect((await json(full)).error.code).toBe('too_large')
  })

  it("refuses a Path whose site is gone: the site's restore comes first", async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const pathId = (await env.store.getPath(site.id, 'PAY-1'))?.id as string
    await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    const res = await asBoss('POST', `/api/admin/deleted/${site.id}/paths/${pathId}/restore`)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('site_gone')
    expect((await restore(site.id)).status).toBe(200)
    expect(
      (await asBoss('POST', `/api/admin/deleted/${site.id}/paths/${pathId}/restore`)).status
    ).toBe(200)
  })
})

describe('a site server', () => {
  const FETCH_SERVER = 'export default{fetch(){return new Response("ok")}}'
  const withServer = (text = 'hi') => [
    ...page(text),
    file('_fling/server.mjs', FETCH_SERVER, 'text/javascript'),
  ]
  let servers: FakeServers

  beforeEach(async () => {
    await start()
    env.config.servers = { ...env.config.servers, publish: { kind: 'members' } }
    servers = new FakeServers()
    env.deps.servers = servers
  })

  it('comes back waiting for its secrets, and starts once they are set', async () => {
    const fling = { server: { secrets: ['TOKEN'] } }
    expect((await deploy(alice.key, 'srv', withServer(), fling)).status).toBe(409)
    await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/TOKEN', { value: 't0k3n' })
    const site = (await env.store.findSite('srv')) as SiteRecord
    expect(site.server?.live).toBe(true)
    await api(env, alice.key, 'DELETE', '/api/sites/srv')
    expect(servers.calls).toContain('retire srv')

    servers.calls = []
    const res = await json(await restore(site.id))
    expect(res.server).toEqual({ state: 'needs_secrets', secrets: ['TOKEN'] })
    // The static site serves; its /api/* answers 503 until the server starts.
    expect(await route('srv')).toMatchObject({ v: site.currentVersionId, f: 1, x: 1 })
    expect(servers.calls).toEqual([])
    const detail = await json(await api(env, alice.key, 'GET', '/api/sites/srv'))
    expect(detail.awaitingSecrets).toEqual({
      versionId: site.currentVersionId,
      secrets: ['TOKEN'],
    })

    const set = await json(
      await api(env, alice.key, 'PUT', '/api/sites/srv/secrets/TOKEN', { value: 'again' })
    )
    expect(set.deployed).toEqual({
      versionId: site.currentVersionId,
      url: 'https://srv.fling.test/',
    })
    expect(servers.calls).toEqual([
      `activate ${site.currentVersionId}`,
      `probe ${site.currentVersionId}`,
    ])
    const route1 = await route('srv')
    expect(route1).toMatchObject({ f: 1, t: 'fn-1.servers.example.test' })
    expect(route1.x).toBeUndefined()
    expect((await env.store.findSite('srv'))?.server?.awaiting).toBeUndefined()
  })

  it('a server that declares no secrets runs again at once', async () => {
    expect((await deploy(alice.key, 'srv', withServer())).status).toBe(200)
    const site = (await env.store.findSite('srv')) as SiteRecord
    await api(env, alice.key, 'DELETE', '/api/sites/srv')
    const res = await json(await restore(site.id))
    expect(res.server).toEqual({ state: 'running' })
    const r = await route('srv')
    expect(r).toMatchObject({ f: 1, t: 'fn-1.servers.example.test' })
    expect(r.x).toBeUndefined()
  })

  it("a server that doesn't start keeps waiting; the static site is live", async () => {
    expect((await deploy(alice.key, 'srv', withServer())).status).toBe(200)
    const site = (await env.store.findSite('srv')) as SiteRecord
    await api(env, alice.key, 'DELETE', '/api/sites/srv')
    servers.answer = { ok: false, error: 'crashed', logs: ['boom'] }
    const res = await json(await restore(site.id))
    expect(res.server.state).toBe('failed')
    expect(res.server.message).toContain('crashed')
    expect(await route('srv')).toMatchObject({ v: site.currentVersionId, f: 1, x: 1 })
  })
})

describe('Admin → Usage', () => {
  it('counts the deleted sites and Paths kept, and their bytes', async () => {
    const empty = await json(await api(env, boss.key, 'GET', '/api/admin/usage'))
    expect(empty.deleted).toEqual({ sites: 0, paths: 0, bytes: 0 })
    const site = await liveSite('team')
    await deploy(alice.key, 'team', [file('PAY-1/index.html', '<h1>p</h1>')], { path: 'PAY-1' })
    await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    const usage = await json(await api(env, boss.key, 'GET', '/api/admin/usage'))
    const { records } = await env.store.listDeletedSites({ limit: 10 })
    expect(usage.deleted).toEqual({
      sites: 1,
      paths: 1,
      bytes: records.reduce((n, r) => n + r.bytes, 0),
    })
    expect(usage.deleted.bytes).toBeGreaterThan(0)
    await restore(site.id)
    const after = await json(await api(env, boss.key, 'GET', '/api/admin/usage'))
    expect(after.deleted.sites).toBe(0)
    expect(after.deleted.paths).toBe(1)
  })
})

describe('the remote MCP server', () => {
  it('says a delete can be recovered, and lists deleted sites to admins only, pointing at Admin → Deleted', async () => {
    const site = await liveSite()
    const deleted = await callTool(env, alice.key, 'fling_delete', { name: 'deck', confirm: true })
    expect(deleted.content[0]?.text).toContain('Deleted deck. An admin can recover it.')
    const names = async (key: string) =>
      ((await json(await rpc(env, key, 'tools/list'))).result.tools as { name: string }[]).map(
        t => t.name
      )
    expect(await names(alice.key)).not.toContain('fling_admin_deleted')
    expect(await names(boss.key)).toContain('fling_admin_deleted')
    const listed = await callTool(env, boss.key, 'fling_admin_deleted', { name: 'deck' })
    expect(listed.content[0]?.text).toContain(site.id)
    expect(listed.content[0]?.text).toContain(`${APP_ORIGIN}/admin/deleted`)
  })
})

describe('deleting for good (purge)', () => {
  const plan = (n: string) => [file(`${n}/index.html`, `<title>Plan ${n}</title><h1>${n}</h1>`)]
  const purge = (siteId: string) => asBoss('DELETE', `/api/admin/deleted/${siteId}`)
  const purgePath = (siteId: string, pathId: string) =>
    asBoss('DELETE', `/api/admin/deleted/${siteId}/paths/${pathId}`)
  const usage = async () =>
    (await json(await api(env, boss.key, 'GET', '/api/admin/usage'))).deleted
  const kept = (site: SiteRecord) =>
    env.blobs.head(`sites/${site.id}/${site.currentVersionId}/index.html`)

  it('removes the files of a site and of its Paths, then its record, off the totals, audited', async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const pathId = (await env.store.getPath(site.id, 'PAY-1'))?.id as string
    await api(env, alice.key, 'DELETE', '/api/sites/team')
    expect(await usage()).toMatchObject({ sites: 1 })
    const prefixes = vi.spyOn(env.blobs, 'deletePrefix')

    const res = await purge(site.id)
    expect(res.status, await res.clone().text()).toBe(204)
    expect(prefixes.mock.calls.map(c => c[0])).toEqual([`sites/${site.id}/`, `sites/${pathId}/`])
    expect(await kept(site)).toBeNull()
    expect(await recovery(site.id)).toBeNull()
    expect(await recovery(pathId)).toBeNull()
    expect(await env.store.getDeletedSite('site', site.id)).toBeNull()
    expect(await usage()).toEqual({ sites: 0, paths: 0, bytes: 0 })
    const entry = (await env.store.listAuditEntries(20)).find(e => e.action === 'site.purge')
    expect(entry).toMatchObject({ actor: BOSS, target: 'team', siteId: site.id })
    expect((await purge(site.id)).status).toBe(404)
    expect((await restore(site.id)).status).toBe(404)
  })

  it('removes a Path deleted on its own, leaving its live site alone', async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const pathId = (await env.store.getPath(site.id, 'PAY-1'))?.id as string
    await api(env, alice.key, 'DELETE', '/api/sites/team/paths/PAY-1')
    expect((await purge(site.id)).status).toBe(404)
    expect((await purgePath('other', pathId)).status).toBe(404)

    expect((await purgePath(site.id, pathId)).status).toBe(204)
    expect(await recovery(pathId)).toBeNull()
    expect(await env.store.getDeletedSite('path', pathId)).toBeNull()
    expect(await usage()).toMatchObject({ paths: 0 })
    expect(await kept(site)).not.toBeNull()
    expect(await route('team')).not.toBeNull()
    const entry = (await env.store.listAuditEntries(20)).find(e => e.action === 'path.purge')
    expect(entry).toMatchObject({ target: 'team/PAY-1', siteId: site.id })
  })

  it("is an admin's browser session's only: others get a 404, an admin's key the session refusal", async () => {
    const site = await liveSite()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    expect((await api(env, alice.key, 'DELETE', `/api/admin/deleted/${site.id}`)).status).toBe(404)
    const token = await api(env, boss.key, 'DELETE', `/api/admin/deleted/${site.id}`)
    expect(token.status).toBe(403)
    expect((await json(token)).error.code).toBe('session_required')
    const path = await api(env, boss.key, 'DELETE', `/api/admin/deleted/${site.id}/paths/x`)
    expect(path.status).toBe(403)
    expect(await recovery(site.id)).not.toBeNull()
    expect(await env.store.getDeletedSite('site', site.id)).not.toBeNull()
  })

  it('refuses a record a restore marked, even one that finished but left its record', async () => {
    const site = await liveSite()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    const spy = vi.spyOn(env.store, 'deleteDeletedSite').mockRejectedValueOnce(new Error('down'))
    expect((await restore(site.id)).status).toBe(500)
    spy.mockRestore()
    expect(await env.store.findSite('deck')).not.toBeNull()

    const res = await purge(site.id)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('restore_in_progress')
    const live = (await env.store.findSite('deck')) as SiteRecord
    expect(await kept(live)).not.toBeNull()
  })

  it('refuses an id that is live, whatever its record says', async () => {
    const site = await liveSite('team')
    await deploy(alice.key, 'team', plan('PAY-1'), { path: 'PAY-1' })
    const path = await env.store.getPath(site.id, 'PAY-1')
    const record: DeletedSiteRecord = {
      kind: 'site',
      siteId: site.id,
      name: 'team',
      owner: ALICE,
      deletedBy: ALICE,
      deletedAt: new Date().toISOString(),
      bytes: 1,
    }
    await env.store.putDeletedSite(record)
    await env.store.putDeletedSite({
      ...record,
      kind: 'path',
      folder: 'PAY-1',
      pathId: path?.id as string,
    })
    const prefixes = vi.spyOn(env.blobs, 'deletePrefix')

    const res = await purge(site.id)
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('site_live')
    const ofPath = await purgePath(site.id, path?.id as string)
    expect(ofPath.status).toBe(409)
    expect((await json(ofPath)).error.code).toBe('path_live')
    expect(prefixes).not.toHaveBeenCalled()
    expect(await kept(site)).not.toBeNull()
    expect(await env.store.getDeletedSite('site', site.id)).toMatchObject({ siteId: site.id })
  })

  it('a purge that stopped part way is refused a restore, and finishes when asked again', async () => {
    const site = await liveSite()
    await api(env, alice.key, 'DELETE', '/api/sites/deck')
    const spy = vi.spyOn(env.store, 'deleteDeletedSite').mockRejectedValueOnce(new Error('down'))
    expect((await purge(site.id)).status).toBe(500)
    spy.mockRestore()
    // The files are gone, the record is left, marked.
    expect(await recovery(site.id)).toBeNull()
    expect((await env.store.getDeletedSite('site', site.id))?.purging).toMatchObject({ by: BOSS })

    const refused = await restore(site.id)
    expect(refused.status).toBe(409)
    expect((await json(refused)).error.code).toBe('purge_in_progress')

    expect((await purge(site.id)).status).toBe(204)
    expect(await env.store.getDeletedSite('site', site.id)).toBeNull()
    expect(await usage()).toEqual({ sites: 0, paths: 0, bytes: 0 })
  })
})
