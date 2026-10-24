/**
 * Store conformance: the behaviour routes rely on, including the races that matter (name and slug
 * claims, single-use codes, refresh-token reuse, upload part counters). Every test uses fresh
 * random emails, names and ids, so a shared table (DynamoDB Local, a real one) needs no cleanup.
 *
 * Lists the Store does not sort itself (versions, upload files across mixed case) are compared as
 * sets: their order is the backend's.
 */
import { randomUUID } from 'node:crypto'
import type {
  ApiKeyRecord,
  GrantRecord,
  RefreshTokenRecord,
  SiteRecord,
  Store,
  UploadFileRecord,
  VersionRecord,
} from '@fling/api/store'
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function version(siteId: string, id = uid()): VersionRecord {
  return { siteId, id, status: 'pending', fileCount: 1, totalBytes: 10, createdAt: NOW }
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

const sortBy = <T>(xs: T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))

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
        expect(await store.getSite(e, s.name)).toEqual(s)
        expect(await store.getNameClaim(s.name)).toEqual({
          name: s.name,
          email: e,
          siteId: s.id,
          createdAt: s.createdAt,
        })
      })

      it('createSite again by the owner returns the existing site unchanged', async () => {
        const store = await factory()
        const e = email()
        const s = site(e)
        await store.createSite(s)
        const again = await store.createSite({ ...s, id: uid(), spa: true })
        expect(again).toEqual(s)
        expect(await store.getSite(e, s.name)).toEqual(s)
      })

      it("createSite on another user's name returns null and changes nothing", async () => {
        const store = await factory()
        const owner = email()
        const s = site(owner)
        await store.createSite(s)
        const other = email()
        expect(await store.createSite(site(other, s.name))).toBeNull()
        expect(await store.getSite(other, s.name)).toBeNull()
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
        for (const c of contenders) {
          expect(await store.getSite(c.email, name)).toEqual(
            c.email === winner.email ? winner : null
          )
        }
      })

      it('race: concurrent first deploys of one name by its owner → one site', async () => {
        const store = await factory()
        const e = email()
        const name = siteName()
        const results = await Promise.all(
          Array.from({ length: 4 }, () => store.createSite(site(e, name)))
        )
        const stored = await store.getSite(e, name)
        expect(stored).not.toBeNull()
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
        expect(await store.getSite(e, a.name)).toEqual(updated)
        expect(await store.listSites(e)).toEqual([updated, b])
      })

      it('deleteSite removes the site and frees the name for anyone', async () => {
        const store = await factory()
        const e = email()
        const s = site(e)
        await store.createSite(s)
        await store.deleteSite(e, s.name)
        expect(await store.getSite(e, s.name)).toBeNull()
        expect(await store.getNameClaim(s.name)).toBeNull()
        expect(await store.listSites(e)).toEqual([])
        const other = site(email(), s.name)
        expect(await store.createSite(other)).toEqual(other)
      })

      it('deleteSite of a site that does not exist is a no-op', async () => {
        const store = await factory()
        await expect(store.deleteSite(email(), siteName())).resolves.toBeUndefined()
      })
    })

    describe('versions', () => {
      it('put, get, overwrite, list (as a set) and delete', async () => {
        const store = await factory()
        const e = email()
        const siteId = uid()
        const v1 = version(siteId)
        const v2 = version(siteId)
        await store.putVersion(e, v1)
        await store.putVersion(e, v2)
        await store.putVersion(e, version(uid()))
        expect(await store.getVersion(e, siteId, v1.id)).toEqual(v1)
        expect(await store.getVersion(e, siteId, 'missing')).toBeNull()
        const done = {
          ...v1,
          status: 'complete' as const,
          spa: true,
          visibility: 'public' as const,
        }
        await store.putVersion(e, done)
        expect(await store.getVersion(e, siteId, v1.id)).toEqual(done)
        expect(sortBy(await store.listVersions(e, siteId), v => v.id)).toEqual(
          sortBy([done, v2], v => v.id)
        )
        await store.deleteVersions(e, siteId)
        expect(await store.listVersions(e, siteId)).toEqual([])
        expect(await store.getVersion(e, siteId, v2.id)).toBeNull()
      })

      it('deleteVersions removes more versions than one batch', async () => {
        const store = await factory()
        const e = email()
        const siteId = uid()
        const other = version(uid())
        await store.putVersion(e, other)
        await Promise.all(Array.from({ length: 30 }, () => store.putVersion(e, version(siteId))))
        expect(await store.listVersions(e, siteId)).toHaveLength(30)
        await store.deleteVersions(e, siteId)
        expect(await store.listVersions(e, siteId)).toEqual([])
        expect(await store.getVersion(e, other.siteId, other.id)).toEqual(other)
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

      it('appendUploadPart counts parts, creating the file when absent', async () => {
        const store = await factory()
        const u = upload()
        await store.putUpload(u)
        expect(await store.appendUploadPart(fileRec(u.id, 'big.bin', 'base64'))).toBe(1)
        expect(await store.appendUploadPart(fileRec(u.id, 'big.bin', 'base64'))).toBe(2)
        await store.putUploadFile({ ...fileRec(u.id, 'x.html'), parts: 1 })
        expect(await store.appendUploadPart(fileRec(u.id, 'x.html'))).toBe(2)
        expect(sortBy(await store.listUploadFiles(u.id), f => f.path)).toEqual([
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
