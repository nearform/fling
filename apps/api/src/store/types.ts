/** Persistence port. Implementations: `memory.ts` (dev/tests) and `dynamo.ts` (production). */
import type { Visibility } from '@fling/shared'

export interface User {
  email: string
  name: string
  picture: string | null
  /** globally unique handle (shown by `fling whoami`); no longer part of site hosts */
  userSlug: string
  createdAt: string
  updatedAt: string
}

export interface ApiKeyRecord {
  id: string
  email: string
  name: string
  /** sha256 hex of the plaintext key */
  hash: string
  createdAt: string
  lastUsedAt: string | null
}

export interface SiteRecord {
  /** random siteId; S3 prefix `sites/<id>/` */
  id: string
  email: string
  name: string
  visibility: Visibility
  spa: boolean
  archived: boolean
  currentVersionId: string | null
  shareToken: string | null
  createdAt: string
  updatedAt: string
}

/** Global claim on a site name (names are one namespace, first come, first served). */
export interface NameClaim {
  name: string
  /** owner */
  email: string
  siteId: string
  createdAt: string
}

export interface VersionRecord {
  siteId: string
  id: string
  status: 'pending' | 'complete'
  fileCount: number
  totalBytes: number
  /** settings requested with the deploy, applied when it goes live */
  spa?: boolean
  visibility?: Visibility
  createdAt: string
}

/** An OAuth client registered through DCR (RFC 7591). CIMD clients are fetched, not stored. */
export interface OAuthClientRecord {
  clientId: string
  clientName: string
  clientUri: string | null
  redirectUris: string[]
  createdAt: string
  /** unused registrations expire; every authorization pushes this out */
  expiresAt: string
}

/** A validated /oauth/authorize request waiting for the user's consent. */
export interface OAuthRequestRecord {
  id: string
  email: string
  clientId: string
  clientName: string
  clientUri: string | null
  /** CIMD: host of the client_id URL (what the consent page names as the app) */
  clientIdHost: string | null
  redirectUri: string
  state: string | null
  codeChallenge: string
  resource: string
  scope: string
  createdAt: string
  expiresAt: string
}

/** An authorization code (stored by hash, single use). */
export interface AuthCodeRecord {
  hash: string
  email: string
  clientId: string
  clientName: string
  clientHost: string | null
  redirectUri: string
  codeChallenge: string
  resource: string
  scope: string
  expiresAt: string
}

/** One app's standing authorization (a "connection"): refresh tokens and access tokens hang off it. */
export interface GrantRecord {
  id: string
  email: string
  clientId: string
  clientName: string
  clientHost: string | null
  resource: string
  scope: string
  /** sha256 of the one refresh token that is currently valid */
  refreshHash: string
  createdAt: string
  lastUsedAt: string | null
  /** sliding: pushed out on every refresh */
  expiresAt: string
}

export interface RefreshTokenRecord {
  /** sha256 hex of the opaque token */
  hash: string
  grantId: string
  email: string
  expiresAt: string
  /** set when exchanged; presenting it again is reuse → the grant is revoked */
  usedAt?: string
}

/** A chunked MCP upload (fling_upload_begin … finish). Parts live in storage under uploads/<id>/. */
export interface UploadRecord {
  id: string
  email: string
  name: string
  spa?: boolean
  visibility?: Visibility
  createdAt: string
  expiresAt: string
}

export interface UploadFileRecord {
  uploadId: string
  path: string
  encoding: 'utf8' | 'base64'
  /** parts 0..parts-1 are at uploadPartKey(uploadId, path, n) */
  parts: number
  expiresAt: string
}

export interface Store {
  getUser(email: string): Promise<User | null>
  /**
   * Create the user (claiming a unique userSlug derived from `preferredSlug`) or refresh
   * name/picture on an existing one.
   */
  upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ): Promise<User>

  createApiKey(key: ApiKeyRecord): Promise<void>
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>
  listApiKeys(email: string): Promise<ApiKeyRecord[]>
  /** false when it didn't exist */
  deleteApiKey(email: string, id: string): Promise<boolean>
  touchApiKey(email: string, id: string, at: string): Promise<void>

  getSite(email: string, name: string): Promise<SiteRecord | null>
  listSites(email: string): Promise<SiteRecord[]>
  /** Who owns `name` globally (null → free). */
  getNameClaim(name: string): Promise<NameClaim | null>
  /**
   * Claim `site.name` for `site.email` and insert the site, atomically. Returns the stored
   * record (the existing one if this user already has it), or null when another user owns
   * the name.
   */
  createSite(site: SiteRecord): Promise<SiteRecord | null>
  putSite(site: SiteRecord): Promise<void>
  /** Delete the site and release its name claim. */
  deleteSite(email: string, name: string): Promise<void>

  getVersion(email: string, siteId: string, id: string): Promise<VersionRecord | null>
  putVersion(email: string, version: VersionRecord): Promise<void>
  listVersions(email: string, siteId: string): Promise<VersionRecord[]>
  deleteVersions(email: string, siteId: string): Promise<void>

  // --- OAuth (remote MCP connector) ---
  putOAuthClient(client: OAuthClientRecord): Promise<void>
  getOAuthClient(clientId: string): Promise<OAuthClientRecord | null>
  putOAuthRequest(req: OAuthRequestRecord): Promise<void>
  getOAuthRequest(id: string): Promise<OAuthRequestRecord | null>
  deleteOAuthRequest(id: string): Promise<void>
  putAuthCode(code: AuthCodeRecord): Promise<void>
  /** Atomically fetch and delete (single use). */
  takeAuthCode(hash: string): Promise<AuthCodeRecord | null>
  /** Create a grant with its first refresh token. */
  createGrant(grant: GrantRecord, refresh: RefreshTokenRecord): Promise<void>
  getGrant(email: string, id: string): Promise<GrantRecord | null>
  listGrants(email: string): Promise<GrantRecord[]>
  /** false when it didn't exist */
  deleteGrant(email: string, id: string): Promise<boolean>
  /**
   * Store the new refresh token and point the grant at it (sliding its expiry). false when the
   * grant is gone (revoked meanwhile) — it is never recreated.
   */
  rotateGrant(grant: GrantRecord, refresh: RefreshTokenRecord): Promise<boolean>
  touchGrant(email: string, id: string, at: string): Promise<void>
  getRefreshToken(hash: string): Promise<RefreshTokenRecord | null>
  /**
   * Mark a refresh token used. null → unknown; `reused` → it had already been used (the record
   * is returned either way).
   */
  claimRefreshToken(
    hash: string,
    at: string
  ): Promise<{ record: RefreshTokenRecord; reused: boolean } | null>

  // --- chunked MCP uploads ---
  putUpload(upload: UploadRecord): Promise<void>
  getUpload(id: string): Promise<UploadRecord | null>
  /** Delete the upload and its file records. */
  deleteUpload(id: string): Promise<void>
  /** Start (or restart) a file: parts = 1. */
  putUploadFile(file: UploadFileRecord): Promise<void>
  /**
   * Reserve the next part of a file (creating it when absent). Returns the new part count (the
   * part to write is count-1), or null when the file exists with a different encoding.
   */
  appendUploadPart(file: Omit<UploadFileRecord, 'parts'>): Promise<number | null>
  listUploadFiles(uploadId: string): Promise<UploadFileRecord[]>
}

/** `alice` → `alice`, `alice-2`, `alice-3`… within USER_SLUG_MAX. */
export function slugCandidate(base: string, attempt: number, max = 20): string {
  if (attempt === 0) return base
  const suffix = `-${attempt + 1}`
  return `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`
}
