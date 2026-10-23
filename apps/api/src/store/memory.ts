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

const clone = <T>(v: T): T => structuredClone(v)

/** In-memory store for dev and tests. Same semantics as the DynamoDB one. */
export class MemoryStore implements Store {
  private users = new Map<string, User>()
  private slugs = new Map<string, string>()
  private keys = new Map<string, ApiKeyRecord>()
  private sites = new Map<string, SiteRecord>()
  private names = new Map<string, NameClaim>()
  private versions = new Map<string, VersionRecord>()
  private oauthClients = new Map<string, OAuthClientRecord>()
  private oauthRequests = new Map<string, OAuthRequestRecord>()
  private authCodes = new Map<string, AuthCodeRecord>()
  private grants = new Map<string, GrantRecord>()
  private refreshTokens = new Map<string, RefreshTokenRecord>()
  private uploads = new Map<string, UploadRecord>()
  private uploadFiles = new Map<string, UploadFileRecord>()

  async getUser(email: string) {
    const u = this.users.get(email)
    return u ? clone(u) : null
  }

  async upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ) {
    const existing = this.users.get(input.email)
    if (existing) {
      const updated = { ...existing, name: input.name, picture: input.picture, updatedAt: now }
      this.users.set(input.email, updated)
      return clone(updated)
    }
    let userSlug = ''
    for (let attempt = 0; ; attempt++) {
      userSlug = slugCandidate(input.preferredSlug, attempt)
      if (!this.slugs.has(userSlug)) break
    }
    this.slugs.set(userSlug, input.email)
    const user: User = {
      email: input.email,
      name: input.name,
      picture: input.picture,
      userSlug,
      createdAt: now,
      updatedAt: now,
    }
    this.users.set(input.email, user)
    return clone(user)
  }

  async createApiKey(key: ApiKeyRecord) {
    this.keys.set(key.id, clone(key))
  }

  async findApiKeyByHash(hash: string) {
    for (const k of this.keys.values()) if (k.hash === hash) return clone(k)
    return null
  }

  async listApiKeys(email: string) {
    return [...this.keys.values()]
      .filter(k => k.email === email)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone)
  }

  async deleteApiKey(email: string, id: string) {
    const k = this.keys.get(id)
    if (!k || k.email !== email) return false
    this.keys.delete(id)
    return true
  }

  async touchApiKey(email: string, id: string, at: string) {
    const k = this.keys.get(id)
    if (k && k.email === email) k.lastUsedAt = at
  }

  private siteKey = (email: string, name: string) => `${email}\0${name}`

  async getSite(email: string, name: string) {
    const s = this.sites.get(this.siteKey(email, name))
    return s ? clone(s) : null
  }

  async listSites(email: string) {
    return [...this.sites.values()]
      .filter(s => s.email === email)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone)
  }

  async getNameClaim(name: string) {
    const claim = this.names.get(name)
    return claim ? clone(claim) : null
  }

  async createSite(site: SiteRecord) {
    const key = this.siteKey(site.email, site.name)
    const existing = this.sites.get(key)
    if (existing) return clone(existing)
    const claim = this.names.get(site.name)
    if (claim && claim.email !== site.email) return null
    this.names.set(site.name, {
      name: site.name,
      email: site.email,
      siteId: site.id,
      createdAt: site.createdAt,
    })
    this.sites.set(key, clone(site))
    return clone(site)
  }

  async putSite(site: SiteRecord) {
    this.sites.set(this.siteKey(site.email, site.name), clone(site))
  }

  async deleteSite(email: string, name: string) {
    this.sites.delete(this.siteKey(email, name))
    if (this.names.get(name)?.email === email) this.names.delete(name)
  }

  private versionKey = (siteId: string, id: string) => `${siteId}\0${id}`

  async getVersion(_email: string, siteId: string, id: string) {
    const v = this.versions.get(this.versionKey(siteId, id))
    return v ? clone(v) : null
  }

  async putVersion(_email: string, version: VersionRecord) {
    this.versions.set(this.versionKey(version.siteId, version.id), clone(version))
  }

  async listVersions(_email: string, siteId: string) {
    return [...this.versions.values()].filter(v => v.siteId === siteId).map(clone)
  }

  async deleteVersions(_email: string, siteId: string) {
    for (const [k, v] of this.versions) if (v.siteId === siteId) this.versions.delete(k)
  }

  async putOAuthClient(client: OAuthClientRecord) {
    this.oauthClients.set(client.clientId, clone(client))
  }

  async getOAuthClient(clientId: string) {
    const c = this.oauthClients.get(clientId)
    return c ? clone(c) : null
  }

  async putOAuthRequest(req: OAuthRequestRecord) {
    this.oauthRequests.set(req.id, clone(req))
  }

  async getOAuthRequest(id: string) {
    const r = this.oauthRequests.get(id)
    return r ? clone(r) : null
  }

  async deleteOAuthRequest(id: string) {
    this.oauthRequests.delete(id)
  }

  async putAuthCode(code: AuthCodeRecord) {
    this.authCodes.set(code.hash, clone(code))
  }

  async takeAuthCode(hash: string) {
    const c = this.authCodes.get(hash)
    this.authCodes.delete(hash)
    return c ? clone(c) : null
  }

  private grantKey = (email: string, id: string) => `${email}\0${id}`

  async createGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    this.grants.set(this.grantKey(grant.email, grant.id), clone(grant))
    this.refreshTokens.set(refresh.hash, clone(refresh))
  }

  async getGrant(email: string, id: string) {
    const g = this.grants.get(this.grantKey(email, id))
    return g ? clone(g) : null
  }

  async listGrants(email: string) {
    return [...this.grants.values()]
      .filter(g => g.email === email)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone)
  }

  async deleteGrant(email: string, id: string) {
    return this.grants.delete(this.grantKey(email, id))
  }

  async rotateGrant(grant: GrantRecord, refresh: RefreshTokenRecord) {
    const key = this.grantKey(grant.email, grant.id)
    if (!this.grants.has(key)) return false
    this.refreshTokens.set(refresh.hash, clone(refresh))
    this.grants.set(key, clone(grant))
    return true
  }

  async touchGrant(email: string, id: string, at: string) {
    const g = this.grants.get(this.grantKey(email, id))
    if (g) g.lastUsedAt = at
  }

  async getRefreshToken(hash: string) {
    const r = this.refreshTokens.get(hash)
    return r ? clone(r) : null
  }

  async claimRefreshToken(hash: string, at: string) {
    const r = this.refreshTokens.get(hash)
    if (!r) return null
    const reused = r.usedAt !== undefined
    if (!reused) r.usedAt = at
    return { record: clone(r), reused }
  }

  async putUpload(upload: UploadRecord) {
    this.uploads.set(upload.id, clone(upload))
  }

  async getUpload(id: string) {
    const u = this.uploads.get(id)
    return u ? clone(u) : null
  }

  private uploadFileKey = (uploadId: string, path: string) => `${uploadId}\0${path}`

  async deleteUpload(id: string) {
    this.uploads.delete(id)
    for (const [k, f] of this.uploadFiles) if (f.uploadId === id) this.uploadFiles.delete(k)
  }

  async putUploadFile(file: UploadFileRecord) {
    this.uploadFiles.set(this.uploadFileKey(file.uploadId, file.path), clone(file))
  }

  async appendUploadPart(file: Omit<UploadFileRecord, 'parts'>) {
    const key = this.uploadFileKey(file.uploadId, file.path)
    const existing = this.uploadFiles.get(key)
    if (existing && existing.encoding !== file.encoding) return null
    const parts = (existing?.parts ?? 0) + 1
    this.uploadFiles.set(key, { ...clone(file), parts })
    return parts
  }

  async listUploadFiles(uploadId: string) {
    return [...this.uploadFiles.values()]
      .filter(f => f.uploadId === uploadId)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(clone)
  }
}
