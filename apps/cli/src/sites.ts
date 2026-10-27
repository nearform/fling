/**
 * The site operations, as plain functions over an `ApiClient` that return data. The CLI commands
 * print what these return; the MCP tools serialise it. Nothing here prints.
 */
import {
  type AudienceChange,
  type Comment,
  type CommentList,
  CommentListSchema,
  CommentSchema,
  type CreateGroupRequest,
  editAudienceInput,
  type GroupDetail,
  GroupDetailSchema,
  GroupListSchema,
  type GroupMembersRequest,
  type GroupSummary,
  type InstanceMetadata,
  type Me,
  MeSchema,
  type NameCheck,
  NameCheckSchema,
  type SharedSite,
  SharedSiteListSchema,
  type Site,
  type SiteDetail,
  SiteDetailSchema,
  SiteListSchema,
  SiteSchema,
  type SiteSort,
  type SiteWithAudience,
  SiteWithAudienceSchema,
  siteUrl,
  sortSites,
  type VersionFiles,
  VersionFilesSchema,
  type Visibility,
} from '@fling/shared'
import { z } from 'zod'
import type { ApiClient } from './api.ts'
import { CliError } from './errors.ts'

/**
 * Response of `POST /api/sites/:name/share`. Not (yet) in `@fling/shared/api.ts`, so it lives here;
 * tolerant of the server returning the whole site alongside.
 */
export const ShareResponseSchema = z.looseObject({ shareUrl: z.string() })

const sitePath = (name: string) => `/api/sites/${encodeURIComponent(name)}`

export function whoami(client: ApiClient): Promise<Me> {
  return client.request('GET', '/api/me', { schema: MeSchema })
}

/** GET /api/names/:name — available, yours, taken (with free suggestions) or invalid. */
export function checkName(client: ApiClient, name: string): Promise<NameCheck> {
  return client.request('GET', `/api/names/${encodeURIComponent(name)}`, {
    schema: NameCheckSchema,
  })
}

/** Where sites are served: `https:` + `sites.example.test` (a site is `<name>.<domain>`). */
export interface SitesBase {
  protocol: string
  /** host, including any port */
  domain: string
}

/** From the instance metadata (`sitesDomain`, `siteScheme`); null when there is none. */
export function sitesBaseOf(
  instance: Pick<InstanceMetadata, 'sitesDomain' | 'siteScheme'> | null | undefined
): SitesBase | null {
  return instance ? { protocol: `${instance.siteScheme}:`, domain: instance.sitesDomain } : null
}

export function siteUrlFor(name: string, base: SitesBase): string {
  return siteUrl(name, base.domain, base.protocol)
}

/** `https://<name>.sites.example.test/` for display. */
export function sitesPattern(base: SitesBase | null): string {
  return base ? siteUrlFor('<name>', base) : '<name>.<sites domain>'
}

export async function listSites(
  client: ApiClient,
  opts: { archived?: boolean; sort?: SiteSort } = {}
): Promise<Site[]> {
  const res = await client.request('GET', '/api/sites', {
    schema: SiteListSchema,
    query: { archived: opts.archived ? 1 : undefined },
  })
  return sortSites(res.sites, opts.sort)
}

/** The restricted sites others have shared with the caller, in `sort` order (default updated). */
export async function listShared(
  client: ApiClient,
  opts: { sort?: SiteSort } = {}
): Promise<SharedSite[]> {
  const res = await client.request('GET', '/api/shared', { schema: SharedSiteListSchema })
  return sortSites(res.sites, opts.sort)
}

export function getSite(client: ApiClient, name: string): Promise<SiteDetail> {
  return client.request('GET', sitePath(name), { schema: SiteDetailSchema })
}

export interface SiteFiles extends VersionFiles {
  name: string
  url: string
  /** the version being served */
  current: boolean
}

/** The files in `versionId`, or in the version being served when omitted. */
export async function versionFiles(
  client: ApiClient,
  name: string,
  versionId?: string
): Promise<SiteFiles> {
  const site = await getSite(client, name)
  const id = versionId ?? site.currentVersionId
  if (!id) throw new CliError(`${name} has no published version yet`)
  const files = await client.request(
    'GET',
    `${sitePath(name)}/versions/${encodeURIComponent(id)}/files`,
    { schema: VersionFilesSchema }
  )
  return { name: site.name, url: site.url, current: id === site.currentVersionId, ...files }
}

/**
 * Mutations whose response body the contract does not pin down: use it when it is a site, else
 * read the site back.
 */
async function siteAfter(client: ApiClient, name: string, raw: unknown): Promise<Site> {
  const parsed = SiteSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const nested = SiteSchema.safeParse((raw as { site?: unknown } | undefined)?.site)
  if (nested.success) return nested.data
  return getSite(client, name)
}

export async function rollback(client: ApiClient, name: string, versionId: string): Promise<Site> {
  const raw = await client.request('POST', `${sitePath(name)}/current`, { body: { versionId } })
  return siteAfter(client, name, raw)
}

export async function setVisibility(
  client: ApiClient,
  name: string,
  visibility: Visibility
): Promise<Site> {
  const raw = await client.request('PATCH', sitePath(name), { body: { visibility } })
  return siteAfter(client, name, raw)
}

/** The site with its audience; a server without audiences fails (it reports none). */
export async function getAudience(client: ApiClient, name: string): Promise<SiteDetail> {
  const site = await getSite(client, name)
  if (!site.audience) throw noAudiences()
  return site
}

const noAudiences = () =>
  new CliError('This Fling does not support limiting a site to listed people', {
    hint: 'Ask its operator to update it.',
  })

/**
 * Change who can see a private site (addresses and groups, as `editAudienceInput`): PATCH the
 * whole new audience. Returns the site with its audience.
 */
export async function setAudience(
  client: ApiClient,
  name: string,
  change: AudienceChange
): Promise<SiteWithAudience & { audience: NonNullable<SiteWithAudience['audience']> }> {
  const current = await getAudience(client, name)
  const audience = current.audience as NonNullable<SiteDetail['audience']>
  const site = await client.request('PATCH', sitePath(name), {
    schema: SiteWithAudienceSchema,
    body: { audience: editAudienceInput(audience, change) },
  })
  if (!site.audience) throw noAudiences()
  return site as typeof site & { audience: NonNullable<typeof site.audience> }
}

/**
 * Warnings about who can still open a site, or why its audience doesn't apply: a share link on a
 * restricted site, or an audience on a public one.
 */
export function audienceWarnings(site: SiteWithAudience): string[] {
  const n = site.audience
    ? site.audience.emails.length + site.audience.groups.length
    : site.audienceSize
  if (site.visibility === 'public' && n > 0) {
    return [
      `${site.name} is public, so its audience doesn't apply yet; it does once the site is private: fling visibility ${site.name} private`,
    ]
  }
  if (site.restricted && site.shareUrl) {
    return [`${site.name} has a share link: anyone with it can still open the site`]
  }
  return []
}

/**
 * Whether the instance can limit sites to listed people, by its stored metadata: its `audiences`
 * capability, or — when the stored copy predates the flag — yes, and the server decides. No
 * instance at all: no.
 */
export function audiencesEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean {
  if (!instance) return false
  return instance.capabilities.audiences ?? true
}

// --- groups ---

const groupPath = (slug: string) => `/api/groups/${encodeURIComponent(slug)}`

/** Every group on the Fling, or (`mine`) the caller's own; by slug. */
export async function listGroups(
  client: ApiClient,
  opts: { mine?: boolean } = {}
): Promise<GroupSummary[]> {
  const res = await client.request('GET', '/api/groups', {
    schema: GroupListSchema,
    query: { mine: opts.mine ? 1 : undefined },
  })
  return res.groups
}

export function getGroup(client: ApiClient, slug: string): Promise<GroupDetail> {
  return client.request('GET', groupPath(slug), { schema: GroupDetailSchema })
}

export function createGroup(client: ApiClient, input: CreateGroupRequest): Promise<GroupDetail> {
  return client.request('POST', '/api/groups', { schema: GroupDetailSchema, body: input })
}

/** Add people to a group the caller owns, then take people out. */
export function changeGroupMembers(
  client: ApiClient,
  slug: string,
  change: GroupMembersRequest
): Promise<GroupDetail> {
  return client.request('POST', `${groupPath(slug)}/members`, {
    schema: GroupDetailSchema,
    body: change,
  })
}

export function renameGroup(client: ApiClient, slug: string, name: string): Promise<GroupDetail> {
  return client.request('PATCH', groupPath(slug), { schema: GroupDetailSchema, body: { name } })
}

export async function deleteGroup(
  client: ApiClient,
  slug: string
): Promise<{ slug: string; deleted: true }> {
  await client.request('DELETE', groupPath(slug))
  return { slug, deleted: true }
}

/**
 * Whether the instance has groups, by its stored metadata: its `groups` capability, or — when the
 * stored copy predates the flag — yes, and the server decides. No instance at all: no.
 */
export function groupsEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean {
  if (!instance) return false
  return instance.capabilities.groups ?? true
}

export async function archiveSite(
  client: ApiClient,
  name: string,
  opts: { unarchive?: boolean } = {}
): Promise<Site> {
  const raw = await client.request(
    'POST',
    `${sitePath(name)}/${opts.unarchive ? 'unarchive' : 'archive'}`
  )
  return siteAfter(client, name, raw)
}

export async function deleteSite(
  client: ApiClient,
  name: string
): Promise<{ name: string; deleted: true }> {
  await client.request('DELETE', sitePath(name))
  return { name, deleted: true }
}

export type ShareResult =
  | { name: string; action: 'existing' | 'created' | 'refreshed'; shareUrl: string }
  | { name: string; action: 'revoked'; shareUrl: null }

/**
 * Share link management. Without flags: return the current link, or create one. `refresh` rotates
 * (the old link stops working); `revoke` removes it.
 */
export async function share(
  client: ApiClient,
  name: string,
  opts: { refresh?: boolean; revoke?: boolean } = {}
): Promise<ShareResult> {
  if (opts.revoke) {
    await client.request('DELETE', `${sitePath(name)}/share`)
    return { name, action: 'revoked', shareUrl: null }
  }
  let hadLink = false
  if (!opts.refresh) {
    const site = await getSite(client, name)
    if (site.shareUrl) return { name, action: 'existing', shareUrl: site.shareUrl }
  } else hadLink = true
  const res = await client.request('POST', `${sitePath(name)}/share`, {
    schema: ShareResponseSchema,
  })
  return { name, action: hadLink ? 'refreshed' : 'created', shareUrl: res.shareUrl }
}

// --- comments ---

/** GET …/comments — the site's comments (oldest first), optionally one page's. */
export function listComments(
  client: ApiClient,
  name: string,
  opts: { path?: string } = {}
): Promise<CommentList> {
  return client.request('GET', `${sitePath(name)}/comments`, {
    schema: CommentListSchema,
    query: { path: opts.path },
  })
}

/** Start a thread on a page, or reply to one. */
export function addComment(
  client: ApiClient,
  name: string,
  input: { body: string; path?: string; parentId?: string }
): Promise<Comment> {
  return client.request('POST', `${sitePath(name)}/comments`, {
    schema: CommentSchema,
    body: input,
  })
}

/** Resolve a thread, or reopen it. */
export function resolveComment(
  client: ApiClient,
  name: string,
  id: string,
  resolved: boolean
): Promise<Comment> {
  return client.request('PATCH', `${sitePath(name)}/comments/${encodeURIComponent(id)}`, {
    schema: CommentSchema,
    body: { resolved },
  })
}

export async function deleteComment(
  client: ApiClient,
  name: string,
  id: string
): Promise<{ name: string; id: string; deleted: true }> {
  await client.request('DELETE', `${sitePath(name)}/comments/${encodeURIComponent(id)}`)
  return { name, id, deleted: true }
}

/**
 * Whether the instance has comments, by its stored metadata: its `comments` capability, or — when
 * the stored copy predates the flag (fetched by an older login) — yes, and the server decides.
 * No instance at all: no.
 */
export function commentsEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean {
  if (!instance) return false
  return instance.capabilities.comments ?? true
}
