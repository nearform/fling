/**
 * Store conformance: the behaviour routes rely on, including the races that matter (name and slug
 * claims, single-use codes, refresh-token reuse, upload part counters). Every test uses fresh
 * random emails, names and ids, so a shared table (DynamoDB Local, a real one) needs no cleanup.
 *
 * Lists come back in a defined order: sites by name, keys and grants newest first, versions by id
 * and upload files by path in UTF-8 byte order (compareSk), which the tests use sort keys that
 * JavaScript orders differently to check.
 */
import { randomUUID } from 'node:crypto'
import type {
  ApiKeyRecord,
  AuditRecord,
  CommentRecord,
  GrantRecord,
  LiveConnectionRecord,
  RefreshTokenRecord,
  SiteRecord,
  Store,
  UploadFileRecord,
  VersionRecord,
} from '@fling/api/store'
import { compareSk } from '@fling/api/table'
import { describe, expect, it } from 'vitest'

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-01T01:00:00.000Z'
const EXPIRES = '2099-01-01T00:00:00.000Z'

const uid = () => randomUUID().replaceAll('-', '').slice(0, 12)
const email = () => `u-${uid()}@example.test`
/** A valid-looking site name, unique per call. */
const siteName = () => `s-${uid()}`

function site(owner: string, name = siteName(), overrides: Partial<SiteRecord> = {}): SiteRecord {
  return {
    id: uid(),
    email: owner,
    name,
    visibility: 'private',
    spa: false,
    archived: false,
    currentVersionId: null,
    shareToken: null,
    audience: { emails: [], groups: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function version(siteId: string, id = uid()): VersionRecord {
  return { siteId, id, status: 'pending', fileCount: 1, totalBytes: 10, createdAt: NOW }
}

/** Ids as newCommentId makes them (time-sortable), but chosen: `c<n>` padded to sort as numbers. */
function comment(siteId: string, n: number, overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    siteId,
    id: `c${String(n).padStart(4, '0')}-${uid()}`,
    parentId: null,
    path: '/',
    versionId: 'v1',
    anchor: null,
    body: `comment ${n}`,
    author: { kind: 'user', email: 'author@example.test' },
    createdAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  }
}

function liveConnection(siteId: string, connectionId = uid()): LiveConnectionRecord {
  return {
    siteId,
    connectionId,
    peer: { id: uid(), name: 'Pat', colour: 'hsl(1 75% 45%)' },
    connectedAt: NOW,
    expiresAt: EXPIRES,
  }
}

function apiKey(owner: string, overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: uid(),
    email: owner,
    name: 'cli:test',
    hash: `${uid()}${uid()}`,
    createdAt: NOW,
    lastUsedAt: null,
    ...overrides,
  }
}

function grant(owner: string, refreshHash: string, overrides: Partial<GrantRecord> = {}) {
  return {
    id: uid(),
    email: owner,
    clientId: 'client',
    clientName: 'Client',
    clientHost: null,
    resource: 'https://app.example.test/mcp',
    scope: 'fling',
    refreshHash,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: EXPIRES,
    ...overrides,
  } satisfies GrantRecord
}

function refresh(owner: string, grantId: string, hash = uid()): RefreshTokenRecord {
  return { hash, grantId, email: owner, expiresAt: EXPIRES }
}

const fileRec = (uploadId: string, path: string, encoding: 'utf8' | 'base64' = 'utf8') => ({
  uploadId,
  path,
  encoding,
  expiresAt: EXPIRES,
})

/** Ids that sort differently in UTF-16 (JavaScript's `<`) and in UTF-8 byte order. */
const awkward = () => {
  const u = uid()
  return [`${u}-\u{1F600}`, `${u}-\uFFFD`, `${u}-Z`, `${u}-a`, `${u}-\u00E9`]
}
const byteOrder = <T>(xs: T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => compareSk(key(a), key(b)))

export function storeConformance(name: string, factory: () => Store | Promise<Store>) {
  describe(`Store conformance: ${name}`, () => {
    describe('users', () => {
      it('creates a user with the preferred slug, then refreshes name/picture only', async () => {
        const store = await factory()
        const e = email()
        const slug = `u${uid()}`
        expect(await store.getUser(e)).toBeNull()
        const user = await store.upsertUser(
          { email: e, name: 'Alice', picture: null, preferredSlug: slug },
          NOW
        )
        expect(user).toEqual({
          email: e,
          name: 'Alice',
          picture: null,
          userSlug: slug,
          createdAt: NOW,
          updatedAt: NOW,
          lastSignInAt: NOW,
        })
        const again = await store.upsertUser(
          { email: e, name: 'Alice B', picture: 'https://pic', preferredSlug: 'ignored' },
          LATER
        )
        expect(again).toEqual({
          ...user,
          name: 'Alice B',
          picture: 'https://pic',
          updatedAt: LATER,
          lastSignInAt: LATER,
        })
        expect(await store.getUser(e)).toEqual(again)
      })

      it('gives a second user with the same preferred slug the next free one', async () => {
        const store = await factory()
        const slug = `u${uid()}`
        const input = (e: string) => ({ email: e, name: 'N', picture: null, preferredSlug: slug })
        const a = await store.upsertUser(input(email()), NOW)
        const b = await store.upsertUser(input(email()), NOW)
        const c = await store.upsertUser(input(email()), NOW)
        expect([a.userSlug, b.userSlug, c.userSlug]).toEqual([slug, `${slug}-2`, `${slug}-3`])
      })

      it('race: concurrent first logins of one user create one user', async () => {
        const store = await factory()
        const e = email()
        const slug = `u${uid()}`
        const users = await Promise.all(
          Array.from({ length: 5 }, () =>
            store.upsertUser({ email: e, name: 'N', picture: null, preferredSlug: slug }, NOW)
          )
        )
        expect(new Set(users.map(u => u.userSlug))).toEqual(new Set([slug]))
        expect((await store.getUser(e))?.userSlug).toBe(slug)
      })

      it('race: concurrent users wanting one slug all get distinct slugs', async () => {
        const store = await factory()
        const slug = `u${uid()}`
        const users = await Promise.all(
          Array.from({ length: 4 }, () =>
            store.upsertUser({ email: email(), name: 'N', picture: null, preferredSlug: slug }, NOW)
          )
        )
        expect(new Set(users.map(u => u.userSlug))).toEqual(
          new Set([slug, `${slug}-2`, `${slug}-3`, `${slug}-4`])
        )
      })
    })

    describe('users index', () => {
      /** Emails that share a prefix no other test's do. */
      const family = () => {
        const p = `ux${uid()}`
        return { prefix: p, email: (s: string) => `${p}${s}@example.test` }
      }
      const signIn = (store: Store, e: string, at: string, name = 'N') =>
        store.upsertUser({ email: e, name, picture: null, preferredSlug: `u${uid()}` }, at)

      it('every sign-in writes the index item: created once, last sign-in each time', async () => {
        const store = await factory()
        const f = family()
        const user = await signIn(store, f.email('a'), NOW, 'Alice')
        expect(await store.listUsers({ prefix: f.prefix, limit: 10 })).toEqual({
          users: [
            {
              email: f.email('a'),
              name: 'Alice',
              picture: null,
              userSlug: user.userSlug,
              createdAt: NOW,
              lastSignInAt: NOW,
            },
          ],
        })
        await signIn(store, f.email('a'), LATER, 'Alice B')
        const { users } = await store.listUsers({ prefix: f.prefix, limit: 10 })
        expect(users).toEqual([
          expect.objectContaining({ name: 'Alice B', createdAt: NOW, lastSignInAt: LATER }),
        ])
      })

      it('lists by email in byte order, a page at a time, only under the prefix', async () => {
        const store = await factory()
        const f = family()
        for (const s of ['c', 'a', 'b', 'd', 'e']) await signIn(store, f.email(s), NOW)
        await signIn(store, `x${f.prefix}@example.test`, NOW)
        const seen: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await store.listUsers({ prefix: f.prefix, limit: 2, cursor })
          expect(page.users.length).toBeLessThanOrEqual(2)
          seen.push(...page.users.map(u => u.email))
          cursor = page.cursor
          pages++
        } while (cursor && pages < 10)
        expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'].map(f.email))
        expect(pages).toBeGreaterThanOrEqual(3)
        expect((await store.listUsers({ prefix: f.email('b'), limit: 5 })).users).toEqual([
          expect.objectContaining({ email: f.email('b') }),
        ])
      })

      it('race: concurrent first logins of one user index it once', async () => {
        const store = await factory()
        const f = family()
        await Promise.all(Array.from({ length: 5 }, () => signIn(store, f.email('r'), NOW)))
        expect((await store.listUsers({ prefix: f.prefix, limit: 10 })).users).toHaveLength(1)
      })
    })

    describe('audit', () => {
      it('adds entries and lists the latest, newest first', async () => {
        const store = await factory()
        const tag = uid()
        // Later than anything else a shared table holds, so these are the latest.
        const entry = (n: number): AuditRecord => ({
          id: `zz${tag}${n}`,
          at: `2098-01-01T00:00:0${n}.000Z`,
          action: n % 2 ? 'impersonation.stop' : 'impersonation.start',
          actor: 'admin@example.test',
          target: `t${n}-${tag}@example.test`,
          ...(n % 2 ? {} : { until: '2098-01-01T01:00:00.000Z' }),
          expiresAt: EXPIRES,
        })
        for (const n of [0, 1, 2]) await store.addAuditEntry(entry(n))
        expect(await store.listAuditEntries(2)).toEqual([entry(2), entry(1)])
      })
    })

    describe('API keys', () => {
      it('create, find by hash, list newest first, touch, delete', async () => {
        const store = await factory()
        const e = email()
        const k1 = apiKey(e, { createdAt: NOW })
        const k2 = apiKey(e, { createdAt: LATER })
        await store.createApiKey(k1)
        await store.createApiKey(k2)
        await store.createApiKey(apiKey(email()))
        expect(await store.findApiKeyByHash(k1.hash)).toEqual(k1)
        expect(await store.findApiKeyByHash('nope')).toBeNull()
        expect(await store.listApiKeys(e)).toEqual([k2, k1])

        await store.touchApiKey(e, k1.id, LATER)
        expect((await store.findApiKeyByHash(k1.hash))?.lastUsedAt).toBe(LATER)

        expect(await store.deleteApiKey(e, k1.id)).toBe(true)
        expect(await store.deleteApiKey(e, k1.id)).toBe(false)
        expect(await store.findApiKeyByHash(k1.hash)).toBeNull()
        expect(await store.listApiKeys(e)).toEqual([k2])
      })

      it("another user can't delete a key; touching a missing key creates nothing", async () => {
        const store = await factory()
        const e = email()
        const k = apiKey(e)
        await store.createApiKey(k)
        expect(await store.deleteApiKey(email(), k.id)).toBe(false)
        expect(await store.findApiKeyByHash(k.hash)).toEqual(k)
        await store.touchApiKey(e, 'missing', LATER)
        expect(await store.listApiKeys(e)).toEqual([k])
      })
    })

    describe('sites and name claims', () => {
      it('createSite claims the name and stores the site', async () => {
        const store = await factory()
        const e = email()
        const s = site(e)
        expect(await store.getNameClaim(s.name)).toBeNull()
        expect(await store.createSite(s)).toEqual(s)
        expect(await store.findSite(s.name)).toEqual(s)
        expect(await store.listSites(e)).toEqual([s])
        expect(await store.getNameClaim(s.name)).toEqual({
          name: s.name,
          email: e,
          siteId: s.id,
          createdAt: s.createdAt,
        })
      })

      it('findSite finds the site holding a name, whoever asks; null once it is free', async () => {
        const store = await factory()
        const s = site(email())
        expect(await store.findSite(s.name)).toBeNull()
        await store.createSite(s)
        expect(await store.findSite(s.name)).toEqual(s)
        await store.deleteSite(s)
        expect(await store.findSite(s.name)).toBeNull()
      })

      it('createSite again by the owner returns the existing site unchanged', async () => {
        const store = await factory()
        const e = email()
        const s = site(e)
        await store.createSite(s)
        const again = await store.createSite({ ...s, id: uid(), spa: true })
        expect(again).toEqual(s)
        expect(await store.findSite(s.name)).toEqual(s)
      })

      it("createSite on another user's name returns null and changes nothing", async () => {
        const store = await factory()
        const owner = email()
        const s = site(owner)
        await store.createSite(s)
        const other = email()
        expect(await store.createSite(site(other, s.name))).toBeNull()
        expect(await store.listSites(other)).toEqual([])
        expect(await store.findSite(s.name)).toEqual(s)
        expect((await store.getNameClaim(s.name))?.email).toBe(owner)
      })

      it('race: concurrent first deploys of one name by different users → exactly one wins', async () => {
        const store = await factory()
        const name = siteName()
        const contenders = Array.from({ length: 5 }, () => site(email(), name))
        const results = await Promise.all(contenders.map(s => store.createSite(s)))
        const winners = results.filter(r => r !== null)
        expect(winners).toHaveLength(1)
        const winner = winners[0] as SiteRecord
        expect((await store.getNameClaim(name))?.email).toBe(winner.email)
        expect(await store.findSite(name)).toEqual(winner)
        for (const c of contenders) {
          expect(await store.listSites(c.email)).toEqual(c.email === winner.email ? [winner] : [])
        }
      })

      it('race: concurrent first deploys of one name by its owner → one site', async () => {
        const store = await factory()
        const e = email()
        const name = siteName()
        const results = await Promise.all(
          Array.from({ length: 4 }, () => store.createSite(site(e, name)))
        )
        const stored = await store.findSite(name)
        expect(stored).not.toBeNull()
        expect(await store.listSites(e)).toEqual([stored])
        for (const r of results) expect(r).toEqual(stored)
        expect((await store.getNameClaim(name))?.siteId).toBe(stored?.id)
      })

      it('putSite updates; listSites is the owner’s sites sorted by name', async () => {
        const store = await factory()
        const e = email()
        const base = siteName()
        const b = site(e, `${base}-b`)
        const a = site(e, `${base}-a`)
        await store.createSite(b)
        await store.createSite(a)
        await store.createSite(site(email()))
        const updated = {
          ...a,
          visibility: 'public' as const,
          currentVersionId: 'v1',
          updatedAt: LATER,
        }
        await store.putSite(updated)
        expect(await store.findSite(a.name)).toEqual(updated)
        expect(await store.listSites(e)).toEqual([updated, b])
      })

      it('deleteSite removes the site and frees the name for anyone', async () => {
        const store = await factory()
        const e = email()
        const s = site(e)
        await store.createSite(s)
        await store.putVersion(s, version(s.id))
        await store.deleteSite(s)
        expect(await store.findSite(s.name)).toBeNull()
        expect(await store.getNameClaim(s.name)).toBeNull()
        expect(await store.listVersions(s)).toEqual([])
        expect(await store.listSites(e)).toEqual([])
        const other = site(email(), s.name)
        expect(await store.createSite(other)).toEqual(other)
      })

      it('deleteSite of a site that does not exist is a no-op', async () => {
        const store = await factory()
        await expect(store.deleteSite(site(email()))).resolves.toBeUndefined()
      })
    })

    describe('versions', () => {
      it('put, get, overwrite, list in id byte order', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        const [id1, id2, ...more] = awkward() as [string, string, ...string[]]
        const v1 = version(s.id, id1)
        const v2 = version(s.id, id2)
        await store.putVersion(s, v1)
        await store.putVersion(s, v2)
        for (const id of more) await store.putVersion(s, version(s.id, id))
        const other = site(s.email)
        await store.createSite(other)
        await store.putVersion(other, version(other.id))
        expect(await store.getVersion(s, v1.id)).toEqual(v1)
        expect(await store.getVersion(s, 'missing')).toBeNull()
        const done = {
          ...v1,
          status: 'complete' as const,
          spa: true,
          visibility: 'public' as const,
        }
        await store.putVersion(s, done)
        expect(await store.getVersion(s, v1.id)).toEqual(done)
        const listed = await store.listVersions(s)
        expect(listed.map(v => v.id)).toEqual(byteOrder([id1, id2, ...more], id => id))
        expect(listed.find(v => v.id === v1.id)).toEqual(done)
        expect(listed.find(v => v.id === v2.id)).toEqual(v2)
      })

      it('deleteSite removes more versions than one batch, and only its own', async () => {
        const store = await factory()
        const s = site(email())
        const neighbour = site(s.email)
        await store.createSite(s)
        await store.createSite(neighbour)
        const kept = version(neighbour.id)
        await store.putVersion(neighbour, kept)
        await Promise.all(Array.from({ length: 30 }, () => store.putVersion(s, version(s.id))))
        expect(await store.listVersions(s)).toHaveLength(30)
        await store.deleteSite(s)
        expect(await store.listVersions(s)).toEqual([])
        expect(await store.listVersions(neighbour)).toEqual([kept])
        expect(await store.findSite(neighbour.name)).toEqual(neighbour)
      })
    })

    describe('comments', () => {
      it('create, get, list oldest first, only the site’s own; an id is created once', async () => {
        const store = await factory()
        const s = site(email())
        const other = site(s.email)
        await store.createSite(s)
        await store.createSite(other)
        const first = comment(s.id, 1, {
          anchor: {
            x: 12.5,
            y: 80,
            selector: '#intro > p:nth-of-type(2)',
            ex: 10,
            ey: 0,
            ew: 62.5,
            eh: 40,
            docW: 300,
            docH: 24,
            quote: 'The heading “is” too big',
          },
          author: { kind: 'guest', name: 'Pat' },
        })
        const second = comment(s.id, 2, { path: '/docs/', versionId: null })
        const reply = comment(s.id, 3, { parentId: first.id })
        // Written out of order: the list is by id.
        for (const c of [reply, second, first]) expect(await store.createComment(c)).toBe(true)
        await store.createComment(comment(other.id, 1))
        expect(await store.createComment({ ...first, body: 'again' })).toBe(false)
        expect(await store.getComment(s.id, first.id)).toEqual(first)
        expect(await store.getComment(other.id, first.id)).toBeNull()
        expect(await store.listComments(s.id)).toEqual([first, second, reply])
      })

      it('resolveComment sets and clears the resolution; null for a missing comment', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        const c = comment(s.id, 1)
        await store.createComment(c)
        const resolution = {
          resolvedAt: LATER,
          resolvedBy: { kind: 'user' as const, email: s.email },
        }
        const resolved = { ...c, ...resolution }
        expect(await store.resolveComment(s.id, c.id, resolution)).toEqual(resolved)
        expect(await store.getComment(s.id, c.id)).toEqual(resolved)
        const open = { resolvedAt: null, resolvedBy: null }
        expect(await store.resolveComment(s.id, c.id, open)).toEqual(c)
        expect(await store.resolveComment(s.id, 'missing', resolution)).toBeNull()
        expect(await store.getComment(s.id, 'missing')).toBeNull()
      })

      it('deleteComment removes a thread with its replies, a reply alone; false when gone', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        const thread = comment(s.id, 1)
        const kept = comment(s.id, 2)
        const replies = [3, 4, 5].map(n => comment(s.id, n, { parentId: thread.id }))
        const keptReply = comment(s.id, 6, { parentId: kept.id })
        for (const c of [thread, kept, ...replies, keptReply]) await store.createComment(c)
        expect(await store.deleteComment(s.id, keptReply.id)).toBe(true)
        expect(await store.deleteComment(s.id, thread.id)).toBe(true)
        expect(await store.listComments(s.id)).toEqual([kept])
        expect(await store.deleteComment(s.id, thread.id)).toBe(false)
      })

      it('deleteSite deletes its comments', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        await store.putVersion(s, version(s.id))
        for (let n = 0; n < 30; n++) await store.createComment(comment(s.id, n))
        await store.deleteSite(s)
        expect(await store.listComments(s.id)).toEqual([])
        expect(await store.findSite(s.name)).toBeNull()
      })
    })

    describe('live connections', () => {
      it('put, get by id, list the room in connection-id byte order, only its own', async () => {
        const store = await factory()
        const s = site(email())
        const other = site(s.email)
        await store.createSite(s)
        await store.createSite(other)
        const conns = awkward().map(id => liveConnection(s.id, id))
        for (const c of [...conns].reverse()) await store.putLiveConnection(c)
        const elsewhere = liveConnection(other.id)
        await store.putLiveConnection(elsewhere)
        expect(await store.listLiveConnections(s.id)).toEqual(byteOrder(conns, c => c.connectionId))
        expect(await store.listLiveConnections(other.id)).toEqual([elsewhere])
        expect(await store.getLiveConnection(elsewhere.connectionId)).toEqual(elsewhere)
        expect(await store.getLiveConnection(uid())).toBeNull()
        // Comments and versions in the same partition are not connections.
        await store.createComment(comment(s.id, 1))
        expect(await store.listLiveConnections(s.id)).toHaveLength(conns.length)
      })

      it('deleteLiveConnection forgets it from its room and by id; null when unknown', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        const [a, b] = [liveConnection(s.id), liveConnection(s.id)] as const
        await store.putLiveConnection(a)
        await store.putLiveConnection(b)
        expect(await store.deleteLiveConnection(a.connectionId)).toEqual(a)
        expect(await store.getLiveConnection(a.connectionId)).toBeNull()
        expect(await store.listLiveConnections(s.id)).toEqual([b])
        expect(await store.deleteLiveConnection(a.connectionId)).toBeNull()
      })

      it('an expired connection is gone', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        const stale = { ...liveConnection(s.id), expiresAt: '2000-01-01T00:00:00.000Z' }
        await store.putLiveConnection(stale)
        expect(await store.getLiveConnection(stale.connectionId)).toBeNull()
        expect(await store.listLiveConnections(s.id)).toEqual([])
      })

      it('deleteSite empties its room', async () => {
        const store = await factory()
        const s = site(email())
        await store.createSite(s)
        await store.putLiveConnection(liveConnection(s.id))
        await store.deleteSite(s)
        expect(await store.listLiveConnections(s.id)).toEqual([])
      })
    })

    describe('OAuth', () => {
      it('clients and consent requests', async () => {
        const store = await factory()
        const client = {
          clientId: uid(),
          clientName: 'App',
          clientUri: null,
          redirectUris: ['http://localhost:1234/cb'],
          createdAt: NOW,
          expiresAt: EXPIRES,
        }
        expect(await store.getOAuthClient(client.clientId)).toBeNull()
        await store.putOAuthClient(client)
        expect(await store.getOAuthClient(client.clientId)).toEqual(client)
        await store.putOAuthClient({ ...client, clientName: 'Renamed' })
        expect((await store.getOAuthClient(client.clientId))?.clientName).toBe('Renamed')

        const req = {
          id: uid(),
          email: email(),
          clientId: client.clientId,
          clientName: 'App',
          clientUri: null,
          clientIdHost: null,
          redirectUri: 'http://localhost:1234/cb',
          state: null,
          codeChallenge: 'challenge',
          resource: 'https://app.example.test/mcp',
          scope: 'fling',
          createdAt: NOW,
          expiresAt: EXPIRES,
        }
        await store.putOAuthRequest(req)
        expect(await store.getOAuthRequest(req.id)).toEqual(req)
        await store.deleteOAuthRequest(req.id)
        expect(await store.getOAuthRequest(req.id)).toBeNull()
        await expect(store.deleteOAuthRequest(req.id)).resolves.toBeUndefined()
      })

      it('authorization codes are single use, even under a race', async () => {
        const store = await factory()
        const code = {
          hash: uid(),
          email: email(),
          clientId: 'c',
          clientName: 'C',
          clientHost: null,
          redirectUri: 'http://localhost/cb',
          codeChallenge: 'x',
          resource: 'https://app.example.test/mcp',
          scope: 'fling',
          expiresAt: EXPIRES,
        }
        await store.putAuthCode(code)
        const taken = await Promise.all(
          Array.from({ length: 5 }, () => store.takeAuthCode(code.hash))
        )
        expect(taken.filter(t => t !== null)).toEqual([code])
        expect(await store.takeAuthCode(code.hash)).toBeNull()
        expect(await store.takeAuthCode('missing')).toBeNull()
      })

      it('grants: create with a refresh token, get, list newest first, touch, delete', async () => {
        const store = await factory()
        const e = email()
        const r1 = refresh(e, '')
        const g1 = grant(e, r1.hash, { createdAt: NOW })
        await store.createGrant(g1, { ...r1, grantId: g1.id })
        const r2 = refresh(e, '')
        const g2 = grant(e, r2.hash, { createdAt: LATER })
        await store.createGrant(g2, { ...r2, grantId: g2.id })
        expect(await store.getGrant(e, g1.id)).toEqual(g1)
        expect(await store.getGrant(email(), g1.id)).toBeNull()
        expect(await store.getRefreshToken(r1.hash)).toEqual({ ...r1, grantId: g1.id })
        expect(await store.listGrants(e)).toEqual([g2, g1])

        await store.touchGrant(e, g1.id, LATER)
        expect((await store.getGrant(e, g1.id))?.lastUsedAt).toBe(LATER)

        expect(await store.deleteGrant(e, g1.id)).toBe(true)
        expect(await store.deleteGrant(e, g1.id)).toBe(false)
        expect(await store.listGrants(e)).toEqual([g2])
        await store.touchGrant(e, g1.id, LATER)
        expect(await store.getGrant(e, g1.id)).toBeNull()
      })

      it('rotateGrant points the grant at a new refresh token, never recreating a revoked one', async () => {
        const store = await factory()
        const e = email()
        const r1 = refresh(e, '')
        const g = grant(e, r1.hash)
        await store.createGrant(g, { ...r1, grantId: g.id })
        const r2 = refresh(e, g.id)
        const rotated = { ...g, refreshHash: r2.hash, expiresAt: '2099-02-01T00:00:00.000Z' }
        expect(await store.rotateGrant(rotated, r2)).toBe(true)
        expect(await store.getGrant(e, g.id)).toEqual(rotated)
        expect(await store.getRefreshToken(r2.hash)).toEqual(r2)

        await store.deleteGrant(e, g.id)
        const r3 = refresh(e, g.id)
        expect(await store.rotateGrant({ ...rotated, refreshHash: r3.hash }, r3)).toBe(false)
        expect(await store.getGrant(e, g.id)).toBeNull()
      })

      it('claimRefreshToken: first claim wins, later ones are reuse, unknown is null', async () => {
        const store = await factory()
        const e = email()
        const r = refresh(e, '')
        const g = grant(e, r.hash)
        await store.createGrant(g, { ...r, grantId: g.id })
        expect(await store.claimRefreshToken('missing', NOW)).toBeNull()
        const first = await store.claimRefreshToken(r.hash, NOW)
        expect(first).toEqual({ record: { ...r, grantId: g.id, usedAt: NOW }, reused: false })
        const second = await store.claimRefreshToken(r.hash, LATER)
        expect(second).toEqual({ record: { ...r, grantId: g.id, usedAt: NOW }, reused: true })
      })

      it('race: concurrent claims of one refresh token → exactly one is not reuse', async () => {
        const store = await factory()
        const e = email()
        const r = refresh(e, '')
        const g = grant(e, r.hash)
        await store.createGrant(g, { ...r, grantId: g.id })
        const claims = await Promise.all(
          Array.from({ length: 5 }, () => store.claimRefreshToken(r.hash, NOW))
        )
        expect(claims.filter(c => c && !c.reused)).toHaveLength(1)
        expect(claims.filter(c => c?.reused)).toHaveLength(4)
      })
    })

    describe('chunked uploads', () => {
      const upload = () => ({
        id: uid(),
        email: email(),
        name: siteName(),
        createdAt: NOW,
        expiresAt: EXPIRES,
      })

      it('put and get an upload; delete removes it and its files', async () => {
        const store = await factory()
        const u = upload()
        expect(await store.getUpload(u.id)).toBeNull()
        await store.putUpload({ ...u, spa: true, visibility: 'public' })
        expect(await store.getUpload(u.id)).toEqual({ ...u, spa: true, visibility: 'public' })
        await store.putUploadFile({ ...fileRec(u.id, 'index.html'), parts: 1 })
        await store.appendUploadPart(fileRec(u.id, 'a.css'))
        await store.deleteUpload(u.id)
        expect(await store.getUpload(u.id)).toBeNull()
        expect(await store.listUploadFiles(u.id)).toEqual([])
      })

      it('putUploadFile (re)starts a file at one part; listUploadFiles is sorted by path', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        await store.putUploadFile({ ...fileRec(u.id, 'b/index.html'), parts: 1 })
        await store.putUploadFile({ ...fileRec(u.id, 'a.css', 'base64'), parts: 1 })
        await store.appendUploadPart(fileRec(u.id, 'a.css', 'base64'))
        await store.putUploadFile({ ...fileRec(u.id, 'a.css', 'base64'), parts: 1 })
        await store.putUploadFile({ ...fileRec(uid(), 'other'), parts: 1 })
        expect(await store.listUploadFiles(u.id)).toEqual([
          { ...fileRec(u.id, 'a.css', 'base64'), parts: 1 },
          { ...fileRec(u.id, 'b/index.html'), parts: 1 },
        ] satisfies UploadFileRecord[])
      })

      it('listUploadFiles is in path byte order', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        const paths = awkward().map(p => `dir/${p}.html`)
        for (const p of paths) await store.putUploadFile({ ...fileRec(u.id, p), parts: 1 })
        expect((await store.listUploadFiles(u.id)).map(f => f.path)).toEqual(
          byteOrder(paths, p => p)
        )
      })

      it('appendUploadPart counts parts, creating the file when absent', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        expect(await store.appendUploadPart(fileRec(u.id, 'big.bin', 'base64'))).toBe(1)
        expect(await store.appendUploadPart(fileRec(u.id, 'big.bin', 'base64'))).toBe(2)
        await store.putUploadFile({ ...fileRec(u.id, 'x.html'), parts: 1 })
        expect(await store.appendUploadPart(fileRec(u.id, 'x.html'))).toBe(2)
        expect(await store.listUploadFiles(u.id)).toEqual([
          { ...fileRec(u.id, 'big.bin', 'base64'), parts: 2 },
          { ...fileRec(u.id, 'x.html'), parts: 2 },
        ])
      })

      it('appendUploadPart refuses a different encoding (null) and leaves the file alone', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        await store.appendUploadPart(fileRec(u.id, 'f', 'utf8'))
        expect(await store.appendUploadPart(fileRec(u.id, 'f', 'base64'))).toBeNull()
        expect(await store.listUploadFiles(u.id)).toEqual([{ ...fileRec(u.id, 'f'), parts: 1 }])
      })

      it('race: concurrent appends to one file get distinct part numbers', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        const parts = await Promise.all(
          Array.from({ length: 8 }, () => store.appendUploadPart(fileRec(u.id, 'p.bin', 'base64')))
        )
        expect([...parts].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect((await store.listUploadFiles(u.id))[0]?.parts).toBe(8)
      })
    })
  })
}
