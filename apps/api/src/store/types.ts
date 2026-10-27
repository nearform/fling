/** The persistence façade routes use, implemented once by `Records` (records.ts) over Table. */
import type { CommentAnchor, CommentAuthor, LivePeer, Visibility } from '@fling/shared'

export interface User {
  email: string
  name: string
  picture: string | null
  /** globally unique handle (shown by `fling whoami`); no longer part of site hosts */
  userSlug: string
  createdAt: string
  updatedAt: string
  /** every sign-in sets it (upsertUser); absent on users who haven't signed in since it exists */
  lastSignInAt?: string
}

/**
 * A user as the admin's users list shows them: the `USERS/USER#<email>` index item, written with
 * the user record (and backfilled by migration 0003), so listing users is one query.
 */
export interface UserSummary {
  email: string
  name: string
  picture: string | null
  userSlug: string
  /** null: unknown (a user record from before it was always written) */
  createdAt: string | null
  lastSignInAt: string | null
}

export type AuditAction = 'impersonation.start' | 'impersonation.stop'

/** Something an admin did, kept for a while (`expiresAt`) and listed newest first. */
export interface AuditRecord {
  /** time-sortable (newSortableId), so the AUDIT partition lists in time order */
  id: string
  at: string
  action: AuditAction
  /** who did it: the admin */
  actor: string
  /** whom it was done to */
  target: string
  /** impersonation.start: when the impersonation lapses */
  until?: string
  /** impersonation.stop: true when it had already lapsed */
  lapsed?: boolean
  expiresAt: string
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

/**
 * Who may see a private site besides its owner: addresses, and group ids. Empty: every member.
 * Kept, and ignored, while the site is public.
 */
export interface SiteAudience {
  /** lowercase, each admitted by the instance's email policy when it was added */
  emails: string[]
  groups: string[]
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
  /** v2; older records read as the empty audience */
  audience: SiteAudience
  createdAt: string
  updatedAt: string
}

/**
 * A user's direct grant on someone else's site (`USER#<email>/SHARED#<siteId>`): written with the
 * site while the email is in its audience, so the sites shared with a user are one query. A
 * projection: the site's audience is what policy reads.
 */
export interface SiteGrantRecord {
  email: string
  siteId: string
  /** the site's name and owner when the grant was written */
  name: string
  owner: string
  grantedAt: string
}

/**
 * A group: a named list of people any member may use in an audience, changed only by its owner.
 * Its members are items of their own (`GROUP#<id>/MEMBER#<email>`); `size` counts them.
 */
export interface GroupRecord {
  /** random id; what audiences store */
  id: string
  /** unique on the instance (the `GROUPNAME#<slug>` claim); what clients name it by */
  slug: string
  name: string
  /** the user who made it */
  owner: string
  size: number
  createdAt: string
  updatedAt: string
}

/** A site whose audience names a group (`GROUP#<id>/SITE#<siteId>`): what deleting it updates. */
export interface GroupSiteRecord {
  groupId: string
  siteId: string
  /** the site's name and owner when it was written */
  name: string
  owner: string
}

/** What locates a site's versions. */
export type SiteRef = Pick<SiteRecord, 'id' | 'email'>

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

/**
 * A comment on a site (a thread's first comment, or a reply to one). Kept in the site's partition,
 * so it outlives versions and goes with the site.
 */
export interface CommentRecord {
  siteId: string
  /** sortable by creation time (newCommentId) */
  id: string
  /** the thread's first comment; null when this starts a thread */
  parentId: string | null
  /** normalizeCommentPath() */
  path: string
  /** the version being served when it was made */
  versionId: string | null
  anchor: CommentAnchor | null
  body: string
  author: CommentAuthor
  createdAt: string
  resolvedAt: string | null
  resolvedBy: CommentAuthor | null
}

/**
 * A connection to a site's live room (live.ts), kept for hubs whose connections outlive any one
 * process (API Gateway WebSockets on AWS); in-process hubs keep theirs in memory. It expires with
 * the longest a connection may last, so one whose goodbye was lost disappears on its own.
 */
export interface LiveConnectionRecord {
  siteId: string
  /** the hub's id for the connection */
  connectionId: string
  peer: LivePeer
  connectedAt: string
  expiresAt: string
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
   * A sign-in: create the user (claiming a unique userSlug derived from `preferredSlug`) or
   * refresh name/picture on an existing one; either way `lastSignInAt` = `now`, and the users
   * index item with it.
   */
  upsertUser(
    input: { email: string; name: string; picture: string | null; preferredSlug: string },
    now: string
  ): Promise<User>
  /**
   * Users by email (byte order), optionally only those whose email starts with `prefix`, a page
   * at a time.
   */
  listUsers(opts: {
    prefix?: string
    limit: number
    cursor?: string
  }): Promise<{ users: UserSummary[]; cursor?: string }>

  // --- audit (admin actions) ---
  addAuditEntry(entry: AuditRecord): Promise<void>
  /** The latest `limit` entries, newest first. */
  listAuditEntries(limit: number): Promise<AuditRecord[]>

  createApiKey(key: ApiKeyRecord): Promise<void>
  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>
  listApiKeys(email: string): Promise<ApiKeyRecord[]>
  /** false when it didn't exist */
  deleteApiKey(email: string, id: string): Promise<boolean>
  touchApiKey(email: string, id: string, at: string): Promise<void>

  /**
   * The site holding the name claim for `name`, whoever owns it (null → no claim, or no site
   * record for it). Access is policy's decision, not the lookup's.
   */
  findSite(name: string): Promise<SiteRecord | null>
  /** The user's own sites, by name. */
  listSites(email: string): Promise<SiteRecord[]>
  /** Who owns `name` globally (null → free). */
  getNameClaim(name: string): Promise<NameClaim | null>
  /**
   * Claim `site.name` for `site.email` and insert the site, atomically. Returns the stored
   * record (the existing one if this user already has it), or null when another user owns
   * the name.
   */
  createSite(site: SiteRecord): Promise<SiteRecord | null>
  /**
   * Write the site. With `before` (the audience it had), also the index items that changed: added
   * emails gain a direct grant and removed ones lose it; added groups gain a group-site item and
   * removed ones lose it.
   */
  putSite(site: SiteRecord, before?: SiteAudience): Promise<void>
  /**
   * Delete the site with its versions, grants and group-site items, and release its name claim (if
   * the claim is its).
   */
  deleteSite(site: SiteRecord): Promise<void>
  /** The sites shared with `email` directly (its grants), by site id. */
  listSiteGrants(email: string): Promise<SiteGrantRecord[]>
  /** Which of these addresses have signed in (have a `USERS/USER#<email>` index item). */
  knownEmails(emails: readonly string[]): Promise<Set<string>>

  // --- groups ---
  /**
   * Claim `group.slug` and insert the group with its members. Returns the stored group, or null
   * when the slug is taken.
   */
  createGroup(group: GroupRecord, members: readonly string[]): Promise<GroupRecord | null>
  /** The group holding the slug claim (null: no such group). */
  findGroup(slug: string): Promise<GroupRecord | null>
  /** Groups by id, in the order asked; ids of groups that are gone are left out. */
  getGroups(ids: readonly string[]): Promise<GroupRecord[]>
  /** Every group on the instance, by slug. */
  listGroups(): Promise<GroupRecord[]>
  /** The groups `email` owns, by slug. */
  listOwnedGroups(email: string): Promise<GroupRecord[]>
  /** The group's members, by email. */
  listGroupMembers(groupId: string): Promise<string[]>
  /** The ids of the groups `email` is a member of: what policy reads. */
  listMemberships(email: string): Promise<string[]>
  /**
   * Write the group (its name, `size`) and, when given, the member changes: `add` gain a member
   * and a membership item, `remove` lose both. The caller sets `size` to the count after them.
   */
  putGroup(
    group: GroupRecord,
    members?: { add: readonly string[]; remove: readonly string[] }
  ): Promise<void>
  /** The sites whose audience names the group. */
  listGroupSites(groupId: string): Promise<GroupSiteRecord[]>
  /** Delete the group: its members and memberships, its site items, its index items and claim. */
  deleteGroup(group: GroupRecord): Promise<void>

  getVersion(site: SiteRef, id: string): Promise<VersionRecord | null>
  putVersion(site: SiteRef, version: VersionRecord): Promise<void>
  /** In version-id byte order. */
  listVersions(site: SiteRef): Promise<VersionRecord[]>

  // --- comments ---
  /** Store a new comment (its id is unique: false if one has it already). */
  createComment(comment: CommentRecord): Promise<boolean>
  getComment(siteId: string, id: string): Promise<CommentRecord | null>
  /** In id order: oldest first. */
  listComments(siteId: string): Promise<CommentRecord[]>
  /** Set or clear a comment's resolution; null when the comment is gone. */
  resolveComment(
    siteId: string,
    id: string,
    resolution: Pick<CommentRecord, 'resolvedAt' | 'resolvedBy'>
  ): Promise<CommentRecord | null>
  /** Delete a comment and, for a thread, its replies. false when it didn't exist. */
  deleteComment(siteId: string, id: string): Promise<boolean>

  // --- live rooms (hubs that keep connections in the store) ---
  /** Store a connection (replacing one with its id). */
  putLiveConnection(connection: LiveConnectionRecord): Promise<void>
  /** A connection by its id, whichever room it is in. */
  getLiveConnection(connectionId: string): Promise<LiveConnectionRecord | null>
  /** The site's room: its live connections, in connection-id byte order. */
  listLiveConnections(siteId: string): Promise<LiveConnectionRecord[]>
  /** Forget a connection; returns it, or null when it was unknown. */
  deleteLiveConnection(connectionId: string): Promise<LiveConnectionRecord | null>

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
