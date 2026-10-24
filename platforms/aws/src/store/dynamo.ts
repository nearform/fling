/**
 * DynamoDB single-table store. Table: partition key `PK` (S), sort key `SK` (S); no GSIs.
 *
 *   PK                    SK                            item
 *   USER#<email>          PROFILE                       user (name, picture, userSlug, …)
 *   SLUG#<userSlug>       SLUG                          slug claim → email (unique userSlug)
 *   NAME#<name>           NAME                          site name claim → { name, email, siteId,
 *                                                       createdAt } (names are global, first
 *                                                       come, first served)
 *   USER#<email>          SITE#<name>                   site (id, visibility, spa, archived, …)
 *   USER#<email>          VERSION#<siteId>#<versionId>  version (status, fileCount, totalBytes, …)
 *   USER#<email>          KEY#<id>                      api key (name, hash, createdAt, lastUsedAt)
 *   APIKEY#<sha256>       APIKEY                        api key lookup → { email, id }
 *
 * OAuth authorization server + remote MCP (items marked ttl carry a `ttl` attribute, epoch
 * seconds; enable DynamoDB TTL on the attribute `ttl`. Expiry is also checked in code, since TTL
 * deletion lags by up to ~48 h):
 *   OAUTHCLIENT#<clientId> CLIENT                       DCR client (name, redirectUris) — ttl,
 *                                                       90 days, pushed out by each authorization
 *   OAUTHREQ#<id>         REQ                           pending consent request — ttl 10 min
 *   OAUTHCODE#<sha256>    CODE                          authorization code — ttl 60 s; taken
 *                                                       with a delete (single use)
 *   USER#<email>          GRANT#<id>                    connection/grant (client, current
 *                                                       refreshHash, lastUsedAt) — ttl = sliding
 *                                                       30-day refresh expiry
 *   REFRESH#<sha256>      REFRESH                       refresh token → { grantId, email, usedAt }
 *                                                       — ttl 30 days; usedAt set on rotation
 *                                                       (conditional), reuse revokes the grant
 *   UPLOAD#<id>           UPLOAD                        chunked MCP upload (owner, site name) —
 *                                                       ttl 1 h; parts are in the bucket under
 *                                                       uploads/<id>/
 *   UPLOAD#<id>           FILE#<path>                   one uploaded file: encoding, part count
 *                                                       (atomic ADD per appended part) — ttl 1 h
 *
 * Conditional writes guard the races that matter: slug claims, and first-deploy site creation,
 * which writes the NAME# claim and the SITE# item in one transaction (`attribute_not_exists(PK)`
 * on both). Deleting a site removes both; archiving keeps the claim. The API key pair is
 * written/deleted in one transaction.
 * Version manifests are NOT here (they can exceed 400 KB) — they live in the sites bucket.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
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
} from '@fling/api/store'

const userPk = (email: string) => `USER#${email}`
const namePk = (name: string) => `NAME#${name}`

type Item = Record<string, unknown>

/** DynamoDB TTL value (epoch seconds) for an ISO expiry. */
const ttlOf = (expiresAt: string) => Math.ceil(Date.parse(expiresAt) / 1000)
const uploadPk = (id: string) => `UPLOAD#${id}`

function strip<T>(item: Item | undefined): T | null {
  if (!item) return null
  const { PK: _pk, SK: _sk, type: _type, ttl: _ttl, ...rest } = item
  return rest as T
}

const isConditionFailure = (err: unknown) =>
  err instanceof Error &&
  (err.name === 'ConditionalCheckFailedException' ||
    (err.name === 'TransactionCanceledException' && err.message.includes('ConditionalCheckFailed')))

export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient

  constructor(
    private table: string,
    client = new DynamoDBClient({})
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  private async get<T>(PK: string, SK: string): Promise<T | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK, SK }, ConsistentRead: true })
    )
    return strip<T>(res.Item)
  }

  private async queryPrefix<T>(PK: string, prefix: string): Promise<T[]> {
    const out: T[] = []
    let start: Record<string, unknown> | undefined
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': PK, ':sk': prefix },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        })
      )
      for (const item of res.Items ?? []) out.push(strip<T>(item) as T)
      start = res.LastEvaluatedKey
    } while (start)
    return out
  }

  getUser(email: string) {
    return this.get<User>(userPk(email), 'PROFILE')
  }

  async upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ) {
    const existing = await this.getUser(input.email)
    if (existing) {
      const updated = { ...existing, name: input.name, picture: input.picture, updatedAt: now }
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: userPk(input.email), SK: 'PROFILE' },
          UpdateExpression: 'SET #n = :n, picture = :p, updatedAt = :u',
          ExpressionAttributeNames: { '#n': 'name' },
          ExpressionAttributeValues: { ':n': input.name, ':p': input.picture, ':u': now },
        })
      )
      return updated
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
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.table,
                  Item: { PK: `SLUG#${userSlug}`, SK: 'SLUG', type: 'slug', email: input.email },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { PK: userPk(input.email), SK: 'PROFILE', type: 'user', ...user },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          })
        )
        return user
      } catch (err) {
        if (!isConditionFailure(err)) throw err
        // Either the slug is taken or a concurrent login created this user.
        const raced = await this.getUser(input.email)
        if (raced) return raced
      }
    }
    throw new Error('Could not allocate a unique user slug')
  }

  async createApiKey(key: ApiKeyRecord) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: { PK: userPk(key.email), SK: `KEY#${key.id}`, type: 'apikey', ...key },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: { PK: `APIKEY#${key.hash}`, SK: 'APIKEY', email: key.email, id: key.id },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    )
  }

  async findApiKeyByHash(hash: string) {
    const ref = await this.get<{ email: string; id: string }>(`APIKEY#${hash}`, 'APIKEY')
    if (!ref) return null
    return this.get<ApiKeyRecord>(userPk(ref.email), `KEY#${ref.id}`)
  }

  async listApiKeys(email: string) {
    const keys = await this.queryPrefix<ApiKeyRecord>(userPk(email), 'KEY#')
    return keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async deleteApiKey(email: string, id: string) {
    const key = await this.get<ApiKeyRecord>(userPk(email), `KEY#${id}`)
    if (!key) return false
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: { PK: userPk(email), SK: `KEY#${id}` } } },
          { Delete: { TableName: this.table, Key: { PK: `APIKEY#${key.hash}`, SK: 'APIKEY' } } },
        ],
      })
    )
    return true
  }

  async touchApiKey(email: string, id: string, at: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: userPk(email), SK: `KEY#${id}` },
          UpdateExpression: 'SET lastUsedAt = :at',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':at': at },
        })
      )
    } catch (err) {
      if (!isConditionFailure(err)) throw err
    }
  }

  getSite(email: string, name: string) {
    return this.get<SiteRecord>(userPk(email), `SITE#${name}`)
  }

  async listSites(email: string) {
    const sites = await this.queryPrefix<SiteRecord>(userPk(email), 'SITE#')
    return sites.sort((a, b) => a.name.localeCompare(b.name))
  }

  getNameClaim(name: string) {
    return this.get<NameClaim>(namePk(name), 'NAME')
  }

  async createSite(site: SiteRecord) {
    const claim: NameClaim = {
      name: site.name,
      email: site.email,
      siteId: site.id,
      createdAt: site.createdAt,
    }
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { PK: namePk(site.name), SK: 'NAME', type: 'name', ...claim },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { PK: userPk(site.email), SK: `SITE#${site.name}`, type: 'site', ...site },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        })
      )
      return site
    } catch (err) {
      if (!isConditionFailure(err)) throw err
      const existing = await this.getSite(site.email, site.name)
      if (existing) return existing
      const owner = await this.getNameClaim(site.name)
      if (owner && owner.email !== site.email) return null
      throw err
    }
  }

  async putSite(site: SiteRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: userPk(site.email), SK: `SITE#${site.name}`, type: 'site', ...site },
      })
    )
  }

  async deleteSite(email: string, name: string) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.table, Key: { PK: userPk(email), SK: `SITE#${name}` } } },
          {
            // Only release the claim if it is ours (or absent).
            Delete: {
              TableName: this.table,
              Key: { PK: namePk(name), SK: 'NAME' },
              ConditionExpression: 'attribute_not_exists(PK) OR email = :e',
              ExpressionAttributeValues: { ':e': email },
            },
          },
        ],
      })
    )
  }

  getVersion(email: string, siteId: string, id: string) {
    return this.get<VersionRecord>(userPk(email), `VERSION#${siteId}#${id}`)
  }

  async putVersion(email: string, version: VersionRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: userPk(email),
          SK: `VERSION#${version.siteId}#${version.id}`,
          type: 'version',
          ...version,
        },
      })
    )
  }

  listVersions(email: string, siteId: string) {
    return this.queryPrefix<VersionRecord>(userPk(email), `VERSION#${siteId}#`)
  }

  async deleteVersions(email: string, siteId: string) {
    const versions = await this.listVersions(email, siteId)
    for (let i = 0; i < versions.length; i += 25) {
      let requests: Record<string, Record<string, unknown>[]> | undefined = {
        [this.table]: versions.slice(i, i + 25).map(v => ({
          DeleteRequest: { Key: { PK: userPk(email), SK: `VERSION#${siteId}#${v.id}` } },
        })),
      }
      for (let tries = 0; requests && Object.keys(requests).length > 0 && tries < 8; tries++) {
        if (tries > 0) await new Promise(r => setTimeout(r, 50 * 2 ** tries))
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: requests as never }))
        requests = res.UnprocessedItems as typeof requests
      }
    }
  }

  private async put(item: Item) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }))
  }

  private async batchDelete(keys: { PK: string; SK: string }[]) {
    for (let i = 0; i < keys.length; i += 25) {
      let requests: Record<string, Record<string, unknown>[]> | undefined = {
        [this.table]: keys.slice(i, i + 25).map(Key => ({ DeleteRequest: { Key } })),
      }
      for (let tries = 0; requests && Object.keys(requests).length > 0 && tries < 8; tries++) {
        if (tries > 0) await new Promise(r => setTimeout(r, 50 * 2 ** tries))
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: requests as never }))
        requests = res.UnprocessedItems as typeof requests
      }
    }
  }

  async putOAuthClient(client: OAuthClientRecord) {
    await this.put({
      PK: `OAUTHCLIENT#${client.clientId}`,
      SK: 'CLIENT',
      type: 'oauthclient',
      ttl: ttlOf(client.expiresAt),
      ...client,
    })
  }

  getOAuthClient(clientId: string) {
    return this.get<OAuthClientRecord>(`OAUTHCLIENT#${clientId}`, 'CLIENT')
  }

  async putOAuthRequest(req: OAuthRequestRecord) {
    await this.put({
      PK: `OAUTHREQ#${req.id}`,
      SK: 'REQ',
      type: 'oauthreq',
      ttl: ttlOf(req.expiresAt),
      ...req,
    })
  }

  getOAuthRequest(id: string) {
    return this.get<OAuthRequestRecord>(`OAUTHREQ#${id}`, 'REQ')
  }

  async deleteOAuthRequest(id: string) {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: `OAUTHREQ#${id}`, SK: 'REQ' } })
    )
  }

  async putAuthCode(code: AuthCodeRecord) {
    await this.put({
      PK: `OAUTHCODE#${code.hash}`,
      SK: 'CODE',
      type: 'oauthcode',
      ttl: ttlOf(code.expiresAt),
      ...code,
    })
  }

  async takeAuthCode(hash: string) {
    const res = await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: `OAUTHCODE#${hash}`, SK: 'CODE' },
        ReturnValues: 'ALL_OLD',
      })
    )
    return strip<AuthCodeRecord>(res.Attributes)
  }

  private grantItem = (grant: GrantRecord) => ({
    PK: userPk(grant.email),
    SK: `GRANT#${grant.id}`,
    type: 'grant',
    ttl: ttlOf(grant.expiresAt),
    ...grant,
  })

  private refreshItem = (refresh: RefreshTokenRecord) => ({
    PK: `REFRESH#${refresh.hash}`,
    SK: 'REFRESH',
    type: 'refresh',
    ttl: ttlOf(refresh.expiresAt),
    ...refresh,
  })

  async createGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: this.grantItem(grant),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: this.refreshItem(refresh),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      })
    )
  }

  getGrant(email: string, id: string) {
    return this.get<GrantRecord>(userPk(email), `GRANT#${id}`)
  }

  async listGrants(email: string) {
    const grants = await this.queryPrefix<GrantRecord>(userPk(email), 'GRANT#')
    return grants.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async deleteGrant(email: string, id: string) {
    const res = await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: userPk(email), SK: `GRANT#${id}` },
        ReturnValues: 'ALL_OLD',
      })
    )
    return Boolean(res.Attributes)
  }

  async rotateGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: this.grantItem(grant),
                ConditionExpression: 'attribute_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: this.refreshItem(refresh),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        })
      )
      return true
    } catch (err) {
      if (isConditionFailure(err)) return false
      throw err
    }
  }

  async touchGrant(email: string, id: string, at: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: userPk(email), SK: `GRANT#${id}` },
          UpdateExpression: 'SET lastUsedAt = :at',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':at': at },
        })
      )
    } catch (err) {
      if (!isConditionFailure(err)) throw err
    }
  }

  getRefreshToken(hash: string) {
    return this.get<RefreshTokenRecord>(`REFRESH#${hash}`, 'REFRESH')
  }

  async claimRefreshToken(hash: string, at: string) {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: `REFRESH#${hash}`, SK: 'REFRESH' },
          UpdateExpression: 'SET usedAt = :at',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(usedAt)',
          ExpressionAttributeValues: { ':at': at },
          ReturnValues: 'ALL_NEW',
        })
      )
      const record = strip<RefreshTokenRecord>(res.Attributes)
      return record ? { record, reused: false } : null
    } catch (err) {
      if (!isConditionFailure(err)) throw err
      const record = await this.getRefreshToken(hash)
      return record ? { record, reused: true } : null
    }
  }

  async putUpload(upload: UploadRecord) {
    await this.put({
      PK: uploadPk(upload.id),
      SK: 'UPLOAD',
      type: 'upload',
      ttl: ttlOf(upload.expiresAt),
      ...upload,
    })
  }

  getUpload(id: string) {
    return this.get<UploadRecord>(uploadPk(id), 'UPLOAD')
  }

  async deleteUpload(id: string) {
    const files = await this.listUploadFiles(id)
    await this.batchDelete([
      { PK: uploadPk(id), SK: 'UPLOAD' },
      ...files.map(f => ({ PK: uploadPk(id), SK: `FILE#${f.path}` })),
    ])
  }

  async putUploadFile(file: UploadFileRecord) {
    await this.put({
      PK: uploadPk(file.uploadId),
      SK: `FILE#${file.path}`,
      type: 'uploadfile',
      ttl: ttlOf(file.expiresAt),
      ...file,
    })
  }

  async appendUploadPart(file: Omit<UploadFileRecord, 'parts'>) {
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: uploadPk(file.uploadId), SK: `FILE#${file.path}` },
          UpdateExpression:
            'ADD #parts :one SET #enc = :enc, #upload = :u, #path = :p, #exp = :e, #ttl = :ttl, #type = :type',
          ConditionExpression: 'attribute_not_exists(PK) OR #enc = :enc',
          // every attribute through a name: no reserved-word surprises
          ExpressionAttributeNames: {
            '#parts': 'parts',
            '#enc': 'encoding',
            '#upload': 'uploadId',
            '#path': 'path',
            '#exp': 'expiresAt',
            '#ttl': 'ttl',
            '#type': 'type',
          },
          ExpressionAttributeValues: {
            ':one': 1,
            ':enc': file.encoding,
            ':u': file.uploadId,
            ':p': file.path,
            ':e': file.expiresAt,
            ':ttl': ttlOf(file.expiresAt),
            ':type': 'uploadfile',
          },
          ReturnValues: 'UPDATED_NEW',
        })
      )
      return Number(res.Attributes?.parts)
    } catch (err) {
      if (isConditionFailure(err)) return null
      throw err
    }
  }

  listUploadFiles(uploadId: string) {
    return this.queryPrefix<UploadFileRecord>(uploadPk(uploadId), 'FILE#')
  }
}
