/**
 * Site lifecycle around publication (publication.ts makes versions live): name checks, listing,
 * settings, rollback, share links, archive, delete. The route table is a projection of the store:
 * `syncRouteTable` writes `site:<label>` (and `share:<token>`) for a live site and removes them otherwise.
 *
 * Names are one global namespace (first come, first served). Deleting a site frees its name;
 * archiving keeps it.
 *
 * Access: a site is found by its name (through the name claim, whoever owns it), then policy.ts
 * decides whether the user may do the action. Refusals look exactly like a missing site (404), so
 * the API never confirms that someone else's site exists beyond what `checkName` says.
 *
 * Audiences: the owner may limit a private site to listed addresses and groups (`applyAudience`
 * through `updateSite`), each address one the instance would let sign in, each group one that
 * exists (named by slug, stored by id). The route value then carries `r: 1`, and the edge wants a
 * site pass, which `/auth/login` hands to whoever policy lets view it (`signedInReturn`). Deleting
 * a group takes it out of the audiences that name it, never widening one (`dropGroup`).
 *
 * Shared with me (`listShared`): the restricted sites of others that the user may see, found from
 * their direct grants and their groups' site items, and each one still asked of policy.
 */
import {
  AUDIENCE_EMAILS_MAX,
  AUDIENCE_GROUPS_MAX,
  type Audience,
  type AudienceInput,
  AudienceInputSchema,
  deletedGroupId,
  deletedGroupRef,
  initialsFromEmail,
  isGeneratedListing,
  isValidSiteName,
  type KvsSiteValue,
  type Manifest,
  type ManifestFile,
  type NameCheck,
  NOT_FOUND_PAGE,
  nameSuggestions,
  parseLabel,
  reviewUrl,
  type SharedSite,
  SITE_PASS_PATH,
  type Site,
  type SiteDetail,
  shareKvsKey,
  shareLabel,
  siteKvsKey,
  siteLabel,
  siteObjectKey,
  sitePrefix,
  siteUrl,
  slugify,
  sortSites,
  type VersionFiles,
  type Visibility,
} from '@fling/shared'
import { PASS_HANDOFF_TTL_SECONDS, signPassHandoff } from '@fling/shared/site-cookie'
import { emailAllowed } from './auth/identity.ts'
import { manifestKey } from './blobs/types.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { newShareToken } from './lib/ids.ts'
import { type Action, type Actor, can, isRestricted, userActor } from './policy.ts'
import type { SiteAudience, SiteRecord, User } from './store/types.ts'
import type { Deps } from './types.ts'

/** A root index.html bigger than this can't be a generated listing page; don't read it. */
const MAX_LISTING_BYTES = 1024 * 1024

/**
 * What's kept at manifestKey(): the deploy manifest plus, once finalized, whether the root
 * index.html is Fling's generated "List HTML files" page (absent on versions finalized earlier).
 */
export type StoredManifest = Manifest & { generatedIndex?: boolean }

/** Is the version's root index.html the generated listing page? Reads it (it's small) to check. */
export async function detectGeneratedIndex(
  deps: Deps,
  siteId: string,
  versionId: string,
  files: readonly ManifestFile[]
): Promise<boolean> {
  const index = files.find(f => f.path === 'index.html')
  if (!index || index.size > MAX_LISTING_BYTES) return false
  const bytes = await deps.blobs.get(siteObjectKey(siteId, versionId, 'index.html'))
  return bytes ? isGeneratedListing(new TextDecoder().decode(bytes)) : false
}

const protocol = (deps: Deps) => `${deps.config.siteScheme}:`

export function toSite(deps: Deps, _user: User, site: SiteRecord): Site {
  const { sitesDomain } = deps.config
  return {
    name: site.name,
    url: siteUrl(siteLabel(site.name), sitesDomain, protocol(deps)),
    visibility: site.visibility,
    spa: site.spa,
    archived: site.archived,
    currentVersionId: site.currentVersionId,
    shareUrl: site.shareToken
      ? siteUrl(shareLabel(site.shareToken), sitesDomain, protocol(deps))
      : null,
    restricted: isRestricted(site),
    audienceSize: site.audience.emails.length + site.audience.groups.length,
    audienceGroups: site.audience.groups.length,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  }
}

/**
 * The audience as its owner sees it: each address, and whether it has signed in yet; each group by
 * slug, with its name and size. A group that has been deleted (kept because it was the only entry,
 * `dropGroup`) is `deleted`, named by its reference.
 */
export async function audienceOf(deps: Deps, site: SiteRecord): Promise<Audience> {
  const [known, groups] = await Promise.all([
    deps.store.knownEmails(site.audience.emails),
    deps.store.getGroups(site.audience.groups),
  ])
  const byId = new Map(groups.map(g => [g.id, g]))
  return {
    emails: site.audience.emails.map(email => ({ email, known: known.has(email) })),
    groups: site.audience.groups.map(id => {
      const g = byId.get(id)
      return g
        ? { slug: g.slug, name: g.name, size: g.size }
        : { slug: deletedGroupRef(id), name: 'a deleted group', size: 0, deleted: true }
    }),
  }
}

/** Make the route table reflect the site: live (not archived, has a version) → keys present, else gone. */
export async function syncRouteTable(deps: Deps, site: SiteRecord, oldShareToken?: string) {
  const { routeTable } = deps
  const label = siteLabel(site.name)
  if (oldShareToken && oldShareToken !== site.shareToken) {
    await routeTable.delete(shareKvsKey(oldShareToken))
  }
  if (site.archived || !site.currentVersionId) {
    await routeTable.delete(siteKvsKey(label))
    if (site.shareToken) await routeTable.delete(shareKvsKey(site.shareToken))
    return
  }
  const value: KvsSiteValue = {
    id: site.id,
    v: site.currentVersionId,
    vis: site.visibility,
    spa: site.spa,
    ...(isRestricted(site) ? { r: 1 as const } : {}),
  }
  const json = JSON.stringify(value)
  await routeTable.put(siteKvsKey(label), json)
  if (site.shareToken) await routeTable.put(shareKvsKey(site.shareToken), json)
}

const SUGGESTION_COUNT = 3
const MAX_CANDIDATES = 48

/** The first few free names from nameSuggestions(): `<base>-<initials>`, `<base>-<initials>2`, … */
export async function freeNameSuggestions(deps: Deps, user: User, base: string) {
  const initials = initialsFromEmail(user.email)
  const free: string[] = []
  let checked = 0
  for (let batch = 6; free.length < SUGGESTION_COUNT && checked < MAX_CANDIDATES; batch *= 2) {
    const candidates = nameSuggestions(base, initials, Math.min(checked + batch, MAX_CANDIDATES))
      .slice(checked)
      .filter(isValidSiteName)
    checked += batch
    const claims = await Promise.all(candidates.map(n => deps.store.getNameClaim(n)))
    candidates.forEach((n, i) => {
      if (!claims[i] && free.length < SUGGESTION_COUNT && !free.includes(n)) free.push(n)
    })
  }
  return free
}

const suggestionBase = (name: string) => slugify(name) || 'site'

export async function nameTaken(deps: Deps, user: User, name: string) {
  const suggestions = await freeNameSuggestions(deps, user, name)
  const hint = suggestions.length ? ` Try ${suggestions.join(', ')}.` : ''
  return conflict(`"${name}" is already taken by someone else.${hint}`, 'name_taken', {
    suggestions,
  })
}

/** GET /api/names/:name — can this user fling to `name`? */
export async function checkName(deps: Deps, user: User, name: string): Promise<NameCheck> {
  if (!isValidSiteName(name)) {
    return {
      name,
      status: 'invalid',
      suggestions: await freeNameSuggestions(deps, user, suggestionBase(name)),
    }
  }
  const yours: NameCheck = { name, status: 'yours', suggestions: [] }
  const taken = async (): Promise<NameCheck> => ({
    name,
    status: 'taken',
    suggestions: await freeNameSuggestions(deps, user, name),
  })
  const site = await deps.store.findSite(name)
  if (site) return can(userActor(user), 'site.deploy', site) ? yours : taken()
  // A claim without a site (only ever transient): it is the claimant's.
  const claim = await deps.store.getNameClaim(name)
  if (!claim) return { name, status: 'available', suggestions: [] }
  return claim.email === user.email ? yours : taken()
}

/** The ids of the groups `email` belongs to (one query): the one place policy's `groups` come from. */
function groupsOf(deps: Deps, email: string): Promise<string[]> {
  return deps.store.listMemberships(email)
}

/**
 * The actor as policy needs them for this site: a user carries their groups on a restricted site,
 * the only place policy reads them (so other sites cost no lookup).
 */
export async function actorOn(deps: Deps, actor: Actor, site: SiteRecord): Promise<Actor> {
  if (actor.kind !== 'user' || !isRestricted(site)) return actor
  return { ...actor, groups: await groupsOf(deps, actor.email) }
}

/**
 * The site named `name` and the actor resolved against it, if the actor may do every one of
 * `actions` to it; else 404, the same answer as for a name nobody holds.
 */
export async function resolveSite(
  deps: Deps,
  actor: Actor,
  name: string,
  ...actions: [Action, ...Action[]]
): Promise<{ site: SiteRecord; actor: Actor }> {
  const site = isValidSiteName(name) ? await deps.store.findSite(name) : null
  const resolved = site ? await actorOn(deps, actor, site) : actor
  if (!site || !actions.every(a => can(resolved, a, site))) {
    throw notFound(`No site named "${name}"`)
  }
  return { site, actor: resolved }
}

/** The site named `name`, if the user may do every one of `actions` to it; else 404. */
export async function requireSite(
  deps: Deps,
  user: User,
  name: string,
  ...actions: [Action, ...Action[]]
): Promise<SiteRecord> {
  return (await resolveSite(deps, userActor(user), name, ...actions)).site
}

/** Write the site and its routes; `before`: the audience it had, when the audience changed. */
export async function save(
  deps: Deps,
  site: SiteRecord,
  oldShareToken?: string,
  before?: SiteAudience
) {
  site.updatedAt = deps.clock.now().toISOString()
  await deps.store.putSite(site, before)
  await syncRouteTable(deps, site, oldShareToken)
}

/**
 * Refuse (400 `email_not_allowed`, naming them) any address the instance would not let sign in:
 * an audience or a group can't name someone who could never see the site.
 */
export function checkEmails(deps: Deps, emails: readonly string[]) {
  const policy = {
    allowedDomains: deps.config.allowedEmailDomains,
    allowedEmails: deps.config.allowedEmails,
  }
  const refused = emails.filter(e => !/^[^@\s]+@[^@\s]+$/.test(e) || !emailAllowed(e, policy))
  if (refused.length) {
    throw new ApiError(
      400,
      'email_not_allowed',
      `Not an address that can sign in to ${deps.config.instanceName}: ${refused.join(', ')}`,
      { emails: refused }
    )
  }
}

/**
 * A new audience for the site, checked: every address one the instance would let sign in, every
 * group slug one that exists (400 `unknown_group`, naming them), stored by id. A deleted group's
 * reference (`#<id>`) keeps it, if the audience already names it. Returns the audience it had.
 */
export async function applyAudience(
  deps: Deps,
  site: SiteRecord,
  input: AudienceInput
): Promise<SiteAudience> {
  const audience = AudienceInputSchema.parse(input)
  const emails = [...new Set(audience.emails)]
  if (emails.length > AUDIENCE_EMAILS_MAX) {
    throw badRequest(`An audience holds at most ${AUDIENCE_EMAILS_MAX} addresses`)
  }
  const slugs = [...new Set(audience.groups)]
  if (slugs.length > AUDIENCE_GROUPS_MAX) {
    throw badRequest(`An audience names at most ${AUDIENCE_GROUPS_MAX} groups`)
  }
  checkEmails(deps, emails)
  const ids = await Promise.all(
    slugs.map(async slug => {
      const kept = deletedGroupId(slug)
      if (kept !== null) return site.audience.groups.includes(kept) ? kept : null
      return (await deps.store.findGroup(slug))?.id ?? null
    })
  )
  const unknown = slugs.filter((_, i) => !ids[i])
  if (unknown.length) {
    throw new ApiError(400, 'unknown_group', `No group named ${unknown.join(', ')}`, {
      groups: unknown,
    })
  }
  const before = site.audience
  site.audience = { emails, groups: [...new Set(ids as string[])] }
  return before
}

/**
 * Take a group out of the audiences that name it (deleting the group), never widening who sees a
 * site: an audience that names others as well loses it (each site saved the usual way); one it is
 * the only entry of keeps its id, which matches nobody, so the site stays restricted to its owner
 * until they change the audience.
 */
export async function dropGroup(deps: Deps, groupId: string) {
  for (const item of await deps.store.listGroupSites(groupId)) {
    const site = await deps.store.findSite(item.name)
    if (site?.id !== item.siteId || !site.audience.groups.includes(groupId)) continue
    const before = site.audience
    const groups = before.groups.filter(g => g !== groupId)
    if (before.emails.length + groups.length === 0) continue
    site.audience = { ...before, groups }
    await save(deps, site, undefined, before)
  }
}

export function applySettings(site: SiteRecord, opts: { spa?: boolean; visibility?: Visibility }) {
  if (opts.spa !== undefined) site.spa = opts.spa
  if (opts.visibility !== undefined) site.visibility = opts.visibility
}

export async function listSites(deps: Deps, user: User, archived: boolean): Promise<Site[]> {
  const sites = await deps.store.listSites(user.email)
  return sites
    .filter(s => s.archived === archived && (archived || s.currentVersionId !== null))
    .map(s => toSite(deps, user, s))
}

/** Sites read at once while listing the ones shared with a user. */
const SHARED_READ_CONCURRENCY = 10

/**
 * GET /api/shared — the restricted sites of others that the user may see because the audience
 * names them, directly or through a group they are in: their direct grants and their groups'
 * site items (index items only), each site then asked of policy, so an index item out of step with
 * the audience (a removed member, a deleted group) never shows a site. Sites that aren't live
 * (archived, or no current version) are left out, as are merely private ones, which every member
 * sees anyway. Last updated first.
 */
export async function listShared(deps: Deps, user: User): Promise<SharedSite[]> {
  const [grants, groups] = await Promise.all([
    deps.store.listSiteGrants(user.email),
    groupsOf(deps, user.email),
  ])
  const groupSites = await mapLimit(groups, SHARED_READ_CONCURRENCY, id =>
    deps.store.listGroupSites(id)
  )
  const candidates = new Map<string, string>()
  for (const item of [...grants, ...groupSites.flat()]) candidates.set(item.siteId, item.name)
  const found = await mapLimit([...candidates], SHARED_READ_CONCURRENCY, async ([id, name]) => {
    const site = await deps.store.findSite(name)
    return site?.id === id ? site : null
  })
  const actor: Actor = { kind: 'user', email: user.email, groups }
  const visible = found.filter(
    (site): site is SiteRecord =>
      site !== null &&
      site.email !== user.email &&
      !site.archived &&
      site.currentVersionId !== null &&
      isRestricted(site) &&
      can(actor, 'site.view', site)
  )
  const via = (site: SiteRecord) => site.audience.groups.filter(id => groups.includes(id))
  const slugs = new Map(
    (await deps.store.getGroups([...new Set(visible.flatMap(via))])).map(g => [g.id, g.slug])
  )
  const { sitesDomain, appOrigin, comments } = deps.config
  return sortSites(
    visible.map(site => ({
      name: site.name,
      url: siteUrl(siteLabel(site.name), sitesDomain, protocol(deps)),
      ...(comments ? { reviewUrl: reviewUrl(appOrigin, site.name) } : {}),
      owner: site.email,
      via: {
        direct: site.audience.emails.includes(user.email),
        groups: via(site).flatMap(id => slugs.get(id) ?? []),
      },
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
    }))
  )
}

export async function siteDetail(deps: Deps, user: User, name: string): Promise<SiteDetail> {
  const site = await requireSite(deps, user, name, 'site.read', 'version.list', 'site.audience')
  const [versions, audience] = await Promise.all([
    deps.store.listVersions(site),
    audienceOf(deps, site),
  ])
  return {
    ...toSite(deps, user, site),
    audience,
    versions: versions
      .filter(v => v.status === 'complete')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(v => ({
        id: v.id,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        createdAt: v.createdAt,
      })),
  }
}

/** GET /api/sites/:name/versions/:versionId/files — one (complete) version's files, by path. */
export async function versionFiles(
  deps: Deps,
  user: User,
  name: string,
  versionId: string
): Promise<VersionFiles> {
  const site = await requireSite(deps, user, name, 'version.read')
  const version = await deps.store.getVersion(site, versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} for "${name}"`)
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(site.id, versionId))
  if (!manifest) throw notFound(`Manifest for version ${versionId} of "${name}" is gone`)
  const files = manifest.files
    .map(f => ({ path: f.path, size: f.size, contentType: f.contentType }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    versionId,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    generatedIndex:
      manifest.generatedIndex ??
      (await detectGeneratedIndex(deps, site.id, versionId, manifest.files)),
  }
}

export async function updateSite(
  deps: Deps,
  user: User,
  name: string,
  patch: { spa?: boolean; visibility?: Visibility; audience?: AudienceInput }
): Promise<Site & { audience?: Audience }> {
  const actions: Action[] = [
    ...(patch.visibility === undefined ? [] : (['site.visibility'] as const)),
    ...(patch.spa === undefined ? [] : (['site.settings'] as const)),
    ...(patch.audience === undefined ? [] : (['site.audience'] as const)),
  ]
  const [first = 'site.settings', ...rest] = actions
  const site = await requireSite(deps, user, name, first, ...rest)
  applySettings(site, patch)
  const before =
    patch.audience === undefined ? undefined : await applyAudience(deps, site, patch.audience)
  await save(deps, site, undefined, before)
  return {
    ...toSite(deps, user, site),
    ...(before ? { audience: await audienceOf(deps, site) } : {}),
  }
}

export async function rollback(deps: Deps, user: User, name: string, versionId: string) {
  const site = await requireSite(deps, user, name, 'site.rollback')
  const version = await deps.store.getVersion(site, versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} for "${name}"`)
  site.currentVersionId = versionId
  await save(deps, site)
  return toSite(deps, user, site)
}

export async function rotateShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name, 'share.create')
  const old = site.shareToken ?? undefined
  site.shareToken = newShareToken()
  await save(deps, site, old)
  return {
    shareUrl: siteUrl(shareLabel(site.shareToken), deps.config.sitesDomain, protocol(deps)),
  }
}

export async function revokeShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name, 'share.revoke')
  const old = site.shareToken ?? undefined
  site.shareToken = null
  await save(deps, site, old)
  return toSite(deps, user, site)
}

export async function setArchived(deps: Deps, user: User, name: string, archived: boolean) {
  const site = await requireSite(deps, user, name, 'site.archive')
  site.archived = archived
  await save(deps, site)
  return toSite(deps, user, site)
}

/**
 * Where `/auth/login` sends a signed-in user (`ret`, already through safeReturnUrl). A restricted
 * site's host is let in only through a site pass: someone policy lets view it goes by its
 * `/_fling-pass` with a 60-second handoff naming them and the site; anyone else gets the sites'
 * 404 page, as for a site that doesn't exist. Every other return URL is unchanged.
 */
export async function signedInReturn(deps: Deps, user: User, ret: string): Promise<string> {
  const { config } = deps
  const suffix = `.${config.sitesDomain}`
  let url: URL
  try {
    url = new URL(ret)
  } catch {
    return ret
  }
  if (url.protocol !== `${config.siteScheme}:` || !url.host.endsWith(suffix)) return ret
  const label = parseLabel(url.host.slice(0, -suffix.length))
  if (label?.kind !== 'site') return ret
  const site = await deps.store.findSite(label.name)
  if (!site || !isRestricted(site)) return ret
  const actor = await actorOn(deps, userActor(user), site)
  if (!can(actor, 'site.view', site)) return `${url.origin}${NOT_FOUND_PAGE}`
  const x = Math.floor(deps.clock.now().getTime() / 1000) + PASS_HANDOFF_TTL_SECONDS
  const t = signPassHandoff({ s: site.id, e: user.email, x }, config.secrets.siteHmacKey)
  const r = encodeURIComponent(`${url.pathname}${url.search}`)
  return `${url.origin}${SITE_PASS_PATH}?t=${t}&r=${r}`
}

/**
 * Delete a site: its route-table keys, files, versions, record and name claim. The site comes from
 * the name claim (requireSite → findSite), so the `site:<name>` key removed here is always this
 * site's; a stale record of another user's for the same name can never reach it.
 */
export async function deleteSite(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name, 'site.delete')
  await deps.routeTable.delete(siteKvsKey(siteLabel(site.name)))
  if (site.shareToken) await deps.routeTable.delete(shareKvsKey(site.shareToken))
  await deps.blobs.deletePrefix(sitePrefix(site.id))
  await deps.store.deleteSite(site)
}
