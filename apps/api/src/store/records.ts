/**
 * Records: the domain persistence behind the `Store` interface, written once over the Table port
 * (`../table/types.ts`). The memory and DynamoDB deployments differ only in the Table they pass.
 *
 * Key layout (the one the DynamoDB store always used, so existing items read as-is):
 *
 *   pk                     sk                            item
 *   USER#<email>           PROFILE                       user (name, picture, userSlug, …)
 *   SLUG#<userSlug>        SLUG                          slug claim → email (unique userSlug)
 *   NAME#<name>            NAME                          site name claim → { name, email, siteId,
 *                                                        createdAt } (names are global, first
 *                                                        come, first served)
 *   USER#<email>           SITE#<name>                   site (id, visibility, spa, archived, …)
 *   USER#<email>           VERSION#<siteId>#<versionId>  version (status, fileCount, totalBytes, …)
 *   USER#<email>           KEY#<id>                      api key (name, hash, createdAt, lastUsedAt)
 *   APIKEY#<sha256>        APIKEY                        api key lookup → { email, id }
 *
 * OAuth authorization server and remote MCP (these expire through `expiresAt`, which the Table
 * hides once passed; callers check it too):
 *
 *   OAUTHCLIENT#<clientId> CLIENT                        DCR client — 90 days, pushed out by each
 *                                                        authorization
 *   OAUTHREQ#<id>          REQ                           pending consent request — 10 min
 *   OAUTHCODE#<sha256>     CODE                          authorization code — 60 s; taken with a
 *                                                        conditional delete (single use)
 *   USER#<email>           GRANT#<id>                    connection/grant (client, current
 *                                                        refreshHash, lastUsedAt) — sliding 30
 *                                                        days
 *   REFRESH#<sha256>       REFRESH                       refresh token → { grantId, email, usedAt }
 *                                                        — 30 days; usedAt set on rotation
 *                                                        (conditional), reuse revokes the grant
 *   UPLOAD#<id>            UPLOAD                        chunked MCP upload (owner, site name) —
 *                                                        1 h; parts are in blobs under uploads/<id>/
 *   UPLOAD#<id>            FILE#<path>                   one uploaded file: encoding, part count —
 *                                                        1 h
 *
 * Every item also carries `type` (its kind; not the API-key lookup) and `v` (see evolution.ts).
 *
 * Conditional writes guard the races that matter: slug claims, and first-deploy site creation,
 * which writes the NAME# claim and the SITE# item in one transaction. Deleting a site removes
 * both; archiving keeps the claim. The API key and its lookup are written/deleted together.
 * Version manifests are not records (they can be large); they live in blobs.
 */
import { mapLimit } from '../lib/concurrency.ts'
import { ConditionFailed, fieldEquals, ifAbsent, ifExists, type Table } from '../table/types.ts'
import { decode, encode, type Kind } from './evolution.ts'
import {
  type ApiKeyRecord,
  type AuthCodeRecord,
  type GrantRecord,
  type NameClaim,
  type OAuthClientRecord,
  type OAuthRequestRecord,
  type RefreshTokenRecord,
  type SiteRecord,
  type Store,
  slugCandidate,
  type UploadFileRecord,
  type UploadRecord,
  type User,
  type VersionRecord,
} from './types.ts'

const userPk = (email: string) => `USER#${email}`

const key = {
  user: (email: string) => ({ pk: userPk(email), sk: 'PROFILE' }),
  slug: (slug: string) => ({ pk: `SLUG#${slug}`, sk: 'SLUG' }),
  apiKey: (email: string, id: string) => ({ pk: userPk(email), sk: `KEY#${id}` }),
  apiKeyRef: (hash: string) => ({ pk: `APIKEY#${hash}`, sk: 'APIKEY' }),
  name: (name: string) => ({ pk: `NAME#${name}`, sk: 'NAME' }),
  site: (email: string, name: string) => ({ pk: userPk(email), sk: `SITE#${name}` }),
  version: (email: string, siteId: string, id: string) => ({
    pk: userPk(email),
    sk: `VERSION#${siteId}#${id}`,
  }),
  oauthClient: (clientId: string) => ({ pk: `OAUTHCLIENT#${clientId}`, sk: 'CLIENT' }),
  oauthRequest: (id: string) => ({ pk: `OAUTHREQ#${id}`, sk: 'REQ' }),
  authCode: (hash: string) => ({ pk: `OAUTHCODE#${hash}`, sk: 'CODE' }),
  grant: (email: string, id: string) => ({ pk: userPk(email), sk: `GRANT#${id}` }),
  refresh: (hash: string) => ({ pk: `REFRESH#${hash}`, sk: 'REFRESH' }),
  upload: (id: string) => ({ pk: `UPLOAD#${id}`, sk: 'UPLOAD' }),
  uploadFile: (uploadId: string, path: string) => ({
    pk: `UPLOAD#${uploadId}`,
    sk: `FILE#${path}`,
  }),
}

/** How many single-item deletes run at once when clearing a set of items. */
const DELETE_CONCURRENCY = 10

const newestFirst = <T extends { createdAt: string }>(xs: T[]) =>
  xs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

/** Run a write whose failed condition just means "no": returns false instead of throwing. */
async function unless(write: Promise<unknown>): Promise<boolean> {
  try {
    await write
    return true
  } catch (err) {
    if (err instanceof ConditionFailed) return false
    throw err
  }
}

export class Records implements Store {
  constructor(private table: Table) {}

  private async read<T>(kind: Kind, k: { pk: string; sk: string }): Promise<T | null> {
    const item = await this.table.get(k.pk, k.sk)
    return item ? decode<T>(kind, item) : null
  }

  /** Every live item of `pk` under `skPrefix`, in sk byte order. */
  private async list<T>(kind: Kind, pk: string, skPrefix: string): Promise<T[]> {
    const out: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.table.query(pk, { skPrefix, cursor })
      for (const item of page.items) out.push(decode<T>(kind, item))
      cursor = page.cursor
    } while (cursor)
    return out
  }

  private deleteAll(keys: { pk: string; sk: string }[]) {
    return mapLimit(keys, DELETE_CONCURRENCY, k => this.table.delete(k.pk, k.sk))
  }

  // --- users ---

  getUser(email: string) {
    return this.read<User>('user', key.user(email))
  }

  async upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ) {
    const existing = await this.getUser(input.email)
    if (existing) {
      const { pk, sk } = key.user(input.email)
      const set = { name: input.name, picture: input.picture, updatedAt: now }
      if (await unless(this.table.update(pk, sk, { set }))) return { ...existing, ...set }
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const userSlug = slugCandidate(input.preferredSlug, attempt)
      const user: User = {
        email: input.email,
        name: input.name,
        picture: input.picture,
        userSlug,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await this.table.transact([
          { put: encode('slug', key.slug(userSlug), { email: input.email }), cond: ifAbsent },
          { put: encode('user', key.user(input.email), user), cond: ifAbsent },
        ])
        return user
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
        // Either the slug is taken or a concurrent login created this user.
        const raced = await this.getUser(input.email)
        if (raced) return raced
      }
    }
    throw new Error('Could not allocate a unique user slug')
  }

  // --- API keys ---

  async createApiKey(apiKey: ApiKeyRecord) {
    await this.table.transact([
      { put: encode('apikey', key.apiKey(apiKey.email, apiKey.id), apiKey), cond: ifAbsent },
      {
        put: encode('apikeyref', key.apiKeyRef(apiKey.hash), {
          email: apiKey.email,
          id: apiKey.id,
        }),
        cond: ifAbsent,
      },
    ])
  }

  async findApiKeyByHash(hash: string) {
    const ref = await this.read<{ email: string; id: string }>('apikeyref', key.apiKeyRef(hash))
    return ref ? this.read<ApiKeyRecord>('apikey', key.apiKey(ref.email, ref.id)) : null
  }

  async listApiKeys(email: string) {
    return newestFirst(await this.list<ApiKeyRecord>('apikey', userPk(email), 'KEY#'))
  }

  async deleteApiKey(email: string, id: string) {
    const apiKey = await this.read<ApiKeyRecord>('apikey', key.apiKey(email, id))
    if (!apiKey) return false
    await this.table.transact([
      { delete: key.apiKey(email, id) },
      { delete: key.apiKeyRef(apiKey.hash) },
    ])
    return true
  }

  async touchApiKey(email: string, id: string, at: string) {
    const { pk, sk } = key.apiKey(email, id)
    await unless(this.table.update(pk, sk, { set: { lastUsedAt: at } }))
  }

  // --- sites and name claims ---

  getSite(email: string, name: string) {
    return this.read<SiteRecord>('site', key.site(email, name))
  }

  async findSite(name: string) {
    const claim = await this.getNameClaim(name)
    if (!claim) return null
    const site = await this.getSite(claim.email, name)
    // A record that is not the claim's site is stale; it holds nothing.
    return site?.id === claim.siteId ? site : null
  }

  async listSites(email: string) {
    const sites = await this.list<SiteRecord>('site', userPk(email), 'SITE#')
    return sites.sort((a, b) => a.name.localeCompare(b.name))
  }

  getNameClaim(name: string) {
    return this.read<NameClaim>('name', key.name(name))
  }

  async createSite(site: SiteRecord) {
    const claim: NameClaim = {
      name: site.name,
      email: site.email,
      siteId: site.id,
      createdAt: site.createdAt,
    }
    try {
      await this.table.transact([
        { put: encode('name', key.name(site.name), claim), cond: ifAbsent },
        { put: encode('site', key.site(site.email, site.name), site), cond: ifAbsent },
      ])
      return site
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      const existing = await this.getSite(site.email, site.name)
      if (existing) return existing
      const owner = await this.getNameClaim(site.name)
      if (owner && owner.email !== site.email) return null
      throw err
    }
  }

  async putSite(site: SiteRecord) {
    await this.table.put(encode('site', key.site(site.email, site.name), site))
  }

  async deleteSite(email: string, name: string) {
    // Release the name claim only if it is ours (or absent). If someone else holds it, the site
    // is still deleted and their claim kept.
    const released = await unless(
      this.table.transact([
        { delete: key.site(email, name) },
        { delete: key.name(name), cond: fieldEquals('email', email, { orAbsent: true }) },
      ])
    )
    if (!released) {
      const { pk, sk } = key.site(email, name)
      await this.table.delete(pk, sk)
    }
  }

  // --- versions ---

  getVersion(email: string, siteId: string, id: string) {
    return this.read<VersionRecord>('version', key.version(email, siteId, id))
  }

  async putVersion(email: string, version: VersionRecord) {
    await this.table.put(encode('version', key.version(email, version.siteId, version.id), version))
  }

  /** In version-id order. */
  listVersions(email: string, siteId: string) {
    return this.list<VersionRecord>('version', userPk(email), `VERSION#${siteId}#`)
  }

  async deleteVersions(email: string, siteId: string) {
    const versions = await this.listVersions(email, siteId)
    await this.deleteAll(versions.map(v => key.version(email, siteId, v.id)))
  }

  // --- OAuth ---

  async putOAuthClient(client: OAuthClientRecord) {
    await this.table.put(encode('oauthclient', key.oauthClient(client.clientId), client))
  }

  getOAuthClient(clientId: string) {
    return this.read<OAuthClientRecord>('oauthclient', key.oauthClient(clientId))
  }

  async putOAuthRequest(req: OAuthRequestRecord) {
    await this.table.put(encode('oauthreq', key.oauthRequest(req.id), req))
  }

  getOAuthRequest(id: string) {
    return this.read<OAuthRequestRecord>('oauthreq', key.oauthRequest(id))
  }

  async deleteOAuthRequest(id: string) {
    const { pk, sk } = key.oauthRequest(id)
    await this.table.delete(pk, sk)
  }

  async putAuthCode(code: AuthCodeRecord) {
    await this.table.put(encode('oauthcode', key.authCode(code.hash), code))
  }

  async takeAuthCode(hash: string) {
    // Conditional, so exactly one of two concurrent exchanges of a code gets it back.
    const { pk, sk } = key.authCode(hash)
    try {
      const item = await this.table.delete(pk, sk, ifExists)
      return item ? decode<AuthCodeRecord>('oauthcode', item) : null
    } catch (err) {
      if (err instanceof ConditionFailed) return null
      throw err
    }
  }

  async createGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    await this.table.transact([
      { put: encode('grant', key.grant(grant.email, grant.id), grant), cond: ifAbsent },
      { put: encode('refresh', key.refresh(refresh.hash), refresh), cond: ifAbsent },
    ])
  }

  getGrant(email: string, id: string) {
    return this.read<GrantRecord>('grant', key.grant(email, id))
  }

  async listGrants(email: string) {
    return newestFirst(await this.list<GrantRecord>('grant', userPk(email), 'GRANT#'))
  }

  async deleteGrant(email: string, id: string) {
    const { pk, sk } = key.grant(email, id)
    return (await this.table.delete(pk, sk)) !== null
  }

  rotateGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    return unless(
      this.table.transact([
        { put: encode('grant', key.grant(grant.email, grant.id), grant), cond: ifExists },
        { put: encode('refresh', key.refresh(refresh.hash), refresh), cond: ifAbsent },
      ])
    )
  }

  async touchGrant(email: string, id: string, at: string) {
    const { pk, sk } = key.grant(email, id)
    await unless(this.table.update(pk, sk, { set: { lastUsedAt: at } }))
  }

  getRefreshToken(hash: string) {
    return this.read<RefreshTokenRecord>('refresh', key.refresh(hash))
  }

  async claimRefreshToken(hash: string, at: string) {
    const { pk, sk } = key.refresh(hash)
    try {
      const item = await this.table.update(
        pk,
        sk,
        { set: { usedAt: at } },
        fieldEquals('usedAt', undefined)
      )
      return { record: decode<RefreshTokenRecord>('refresh', item), reused: false }
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      const record = await this.getRefreshToken(hash)
      return record ? { record, reused: true } : null
    }
  }

  // --- chunked MCP uploads ---

  async putUpload(upload: UploadRecord) {
    await this.table.put(encode('upload', key.upload(upload.id), upload))
  }

  getUpload(id: string) {
    return this.read<UploadRecord>('upload', key.upload(id))
  }

  async deleteUpload(id: string) {
    const files = await this.listUploadFiles(id)
    await this.deleteAll([key.upload(id), ...files.map(f => key.uploadFile(id, f.path))])
  }

  async putUploadFile(file: UploadFileRecord) {
    await this.table.put(encode('uploadfile', key.uploadFile(file.uploadId, file.path), file))
  }

  async appendUploadPart(file: Omit<UploadFileRecord, 'parts'>) {
    const k = key.uploadFile(file.uploadId, file.path)
    for (;;) {
      // Common case: the file exists with this encoding; count the part atomically.
      try {
        const item = await this.table.update(
          k.pk,
          k.sk,
          { add: { parts: 1 }, set: { ...file, type: 'uploadfile' } },
          fieldEquals('encoding', file.encoding)
        )
        return Number(item.parts)
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
      const existing = await this.table.get(k.pk, k.sk)
      if (existing && existing.encoding !== file.encoding) return null
      if (existing) continue // created meanwhile by a concurrent append
      // Absent: create it at one part. Losing that race to another append means it exists now.
      const created = { ...file, parts: 1 } satisfies UploadFileRecord
      if (await unless(this.table.put(encode('uploadfile', k, created), ifAbsent))) return 1
    }
  }

  /** In path byte order. */
  listUploadFiles(uploadId: string) {
    return this.list<UploadFileRecord>('uploadfile', `UPLOAD#${uploadId}`, 'FILE#')
  }
}
