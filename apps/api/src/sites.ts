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
 * Access levels (access.ts): a site is open to its owner only, every member, an audience, or
 * anyone (`applyAccess`, through `updateSite` and a new site's first deploy, `initialAccess`). A
 * new site that names no level gets the instance's default (`SITE_DEFAULT_ACCESS`).
 *
 * Audiences: the owner may limit a private site to listed addresses and groups (`applyAudience`
 * through `updateSite`), each address one the instance would let sign in or one they invite as a
 * guest (invitations.ts, with `INVITES` on), each group one that exists (named by slug, stored by
 * id). A restricted site (an audience, or only the owner) has a
 * route value carrying `r: 1`, and the edge wants a site pass, which `/auth/login` hands to whoever
 * policy lets view it (`signedInReturn`). Deleting a group takes it out of the audiences that name
 * it, never widening one (`dropGroup`).
 *
 * Shared with me (`listShared`): the restricted sites of others that the user may see, listed from
 * their direct grants and their groups' site items, which carry each site's listing.
 *
 * Owners and publishers (site-roles.ts): the owners may name other members, people or groups, as
 * owners or publishers (`applyRoles` through `updateSite`); the owners always keep an address.
 * A user's sites (`listSites`) are those they hold a role on: the sites they created while they
 * still do, and those their role items and their groups' role items name. Deleting a group takes
 * it out of every site's roles.
 */
import {
  type AccessLevel,
  AUDIENCE_EMAILS_MAX,
  AUDIENCE_GROUPS_MAX,
  type Audience,
  type AudienceEmail,
  type AudienceInput,
  AudienceInputSchema,
  accessProblem,
  deletedGroupId,
  deletedGroupRef,
  initialsFromEmail,
  isGeneratedListing,
  isValidSiteName,
  type KvsSiteValue,
  type Manifest,
  type ManifestFile,
  type NameCheck,
  nameSuggestions,
  needsAudience,
  OWNER_EMAILS_MAX,
  OWNER_GROUPS_MAX,
  OwnersInputSchema,
  PUBLISHER_EMAILS_MAX,
  PUBLISHER_GROUPS_MAX,
  PublishersInputSchema,
  parseLabel,
  reviewUrl,
  type SharedSite,
  SITE_PASS_PATH,
  type Site,
  type SiteDetail,
  type SiteRole,
  type SiteRoleInput,
  type SiteRoleMembers,
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
  WHY_SITE_NAME,
  type WhySite,
} from '@fling/shared'
import {
  PASS_HANDOFF_TTL_SECONDS,
  signDenyHandoff,
  signPassHandoff,
} from '@fling/shared/site-cookie'
import { audit } from './audit.ts'
import { admittedByConfig, asRequestUser } from './auth/standing.ts'
import { manifestKey } from './blobs/types.ts'
import {
  checkAddresses,
  checkMembers,
  guestsAmong,
  type Inviter,
  inviteGuests,
  inviterOf,
} from './invitations.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { newShareToken } from './lib/ids.ts'
import { actingOf, notifyAudienceChange, notifyRoleChange } from './notifications/notify.ts'
import {
  type Action,
  type Actor,
  byAdminOnly,
  can,
  isRestricted,
  type Principal,
  rolesOf,
  SITE_CHANGES,
  userActor,
} from './policy.ts'
import {
  accessOfSite,
  firstOwner,
  hasListing,
  listingOf,
  type SharedListing,
  type SiteAudience,
  type SiteRecord,
  type SiteRoleList,
  type User,
} from './store/types.ts'
import type { Deps } from './types.ts'

/** A root index.html bigger than this can't be a generated listing page; don't read it. */
const MAX_LISTING_BYTES = 1024 * 1024

/**
 * What's kept at manifestKey(): the deploy manifest plus, once finalized, whether the root
 * index.html is Fling's generated "List HTML files" page (absent on versions finalized earlier).
 * A path publish's manifest is the whole merged version, with `layer`: the folder it replaced, the
 * version it builds on, and the paths it carries forward from it (copied at finalize).
 */
export type StoredManifest = Manifest & {
  generatedIndex?: boolean
  layer?: { path: string; base: string; kept: string[] }
}

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

/**
 * The caller's role on the site, as clients show it: owner, publisher, or an admin administering
 * it; none for anyone else.
 */
export function siteRoleOf(actor: Actor, site: SiteRecord): SiteRole | undefined {
  const [role] = rolesOf(actor, site)
  if (role === 'owner' || role === 'publisher') return role
  return role === 'admin' || role === 'admin-token' ? 'admin' : undefined
}

/**
 * The site as `actor` (resolved against it, `actorOn`) sees it: with their role, and the share
 * link only if they may read it (not a publisher).
 */
export function toSite(deps: Deps, actor: Actor, site: SiteRecord): Site {
  const { sitesDomain } = deps.config
  const role = siteRoleOf(actor, site)
  return {
    name: site.name,
    url: siteUrl(siteLabel(site.name), sitesDomain, protocol(deps)),
    visibility: site.visibility,
    spa: site.spa,
    archived: site.archived,
    currentVersionId: site.currentVersionId,
    shareUrl:
      site.shareToken && can(actor, 'share.read', site)
        ? siteUrl(shareLabel(site.shareToken), sitesDomain, protocol(deps))
        : null,
    access: accessOfSite(site),
    restricted: isRestricted(site),
    audienceSize: site.audience.emails.length + site.audience.groups.length,
    audienceGroups: site.audience.groups.length,
    ...(role ? { role } : {}),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  }
}

/**
 * The audience as its owner sees it: each address, whether it has signed in yet and whether it is a
 * guest (`guestsAmong`); each group by
 * slug, with its name and size. A group that has been deleted (kept because it was the only entry,
 * `dropGroup`) is `deleted`, named by its reference.
 */
export function audienceOf(deps: Deps, site: SiteRecord): Promise<Audience> {
  return peopleOf(deps, site.audience)
}

/**
 * Addresses and groups (an audience, the owners or the publishers) as the API reports them: each
 * address, whether it has signed in yet and whether it is a guest; each group by slug, with its
 * name and size, or `deleted`.
 */
async function peopleOf(
  deps: Deps,
  list: SiteAudience | SiteRoleList
): Promise<{ emails: AudienceEmail[]; groups: Audience['groups'] }> {
  const [known, guests, groups] = await Promise.all([
    deps.store.knownEmails(list.emails),
    guestsAmong(deps, list.emails),
    deps.store.getGroups(list.groups),
  ])
  const byId = new Map(groups.map(g => [g.id, g]))
  return {
    emails: list.emails.map(email => ({
      email,
      known: known.has(email),
      ...(guests.has(email) ? { guest: true } : {}),
    })),
    groups: list.groups.map(id => {
      const g = byId.get(id)
      return g
        ? { slug: g.slug, name: g.name, size: g.size }
        : { slug: deletedGroupRef(id), name: 'a deleted group', size: 0, deleted: true }
    }),
  }
}

/** The site's owners and publishers as the API reports them (`peopleOf`). */
export async function rolesView(
  deps: Deps,
  site: SiteRecord
): Promise<{ owners: SiteRoleMembers; publishers: SiteRoleMembers }> {
  const [owners, publishers] = await Promise.all([
    peopleOf(deps, site.owners),
    peopleOf(deps, site.publishers),
  ])
  return { owners, publishers }
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
  if (site) return can(await siteActor(deps, user, site), 'site.deploy', site) ? yours : taken()
  // A claim without a site (only ever transient): it is the claimant's.
  const claim = await deps.store.getNameClaim(name)
  if (!claim) return { name, status: 'available', suggestions: [] }
  return claim.email === user.email ? yours : taken()
}

/**
 * The instance's why-fling site, when anyone may open it: public, live and not archived. A site of
 * that name that is not public gives `null`, the same as none, so it reveals nothing.
 */
export async function whySite(deps: Deps): Promise<WhySite> {
  const site = await deps.store.findSite(WHY_SITE_NAME)
  const open =
    site && !site.archived && site.currentVersionId && can({ kind: 'anonymous' }, 'site.view', site)
  return {
    url: open ? siteUrl(siteLabel(site.name), deps.config.sitesDomain, protocol(deps)) : null,
  }
}

/** The ids of the groups `email` belongs to (one query): the one place policy's `groups` come from. */
function groupsOf(deps: Deps, email: string): Promise<string[]> {
  return deps.store.listMemberships(email)
}

/** Whether policy reads the actor's groups for this site: where groups hold roles or let people in. */
const readsGroups = (site: SiteRecord) =>
  site.owners.groups.length > 0 ||
  site.publishers.groups.length > 0 ||
  (isRestricted(site) && site.audience.groups.length > 0)

/**
 * The actor as policy needs them for this site: a user carries their groups where the site's
 * owners or publishers name groups, or it is restricted to an audience that does, the only places
 * policy reads them (so other sites cost no lookup).
 */
export async function actorOn(deps: Deps, actor: Actor, site: SiteRecord): Promise<Actor> {
  if (actor.kind !== 'user' || actor.groups || !readsGroups(site)) return actor
  return { ...actor, groups: await groupsOf(deps, actor.email) }
}

/** A signed-in user as policy needs them for this site (`actorOn`). */
export function siteActor(deps: Deps, user: User, site: SiteRecord): Promise<Actor> {
  return actorOn(deps, userActor(user), site)
}

/**
 * The site named `name` and the actor resolved against it, if the actor may do every one of
 * `actions` to it; else 404, the same answer as for a name nobody holds. A change an admin may make
 * only because they are one is audited first (`site.change`, one entry per action), so it is on
 * record before it happens.
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
  for (const action of actions) {
    if (SITE_CHANGES.has(action)) await auditAdmin(deps, resolved, site, action)
  }
  return { site, actor: resolved }
}

/**
 * Audit what an admin does to a site only because they are one: `site.change` for a change,
 * `site.open` for a site pass. Nothing for anyone else, nor for what they could do anyway.
 */
export async function auditAdmin(deps: Deps, actor: Actor, site: SiteRecord, action: Action) {
  if (actor.kind !== 'user' || !byAdminOnly(actor, action, site)) return
  await audit(deps, {
    action: action === 'site.view' ? 'site.open' : 'site.change',
    actor: actor.email,
    target: site.name,
    owner: firstOwner(site),
    ...(action === 'site.view' ? {} : { change: action }),
  })
}

/** The site named `name`, if the user may do every one of `actions` to it; else 404. */
export async function requireSite(
  deps: Deps,
  user: User,
  name: string,
  ...actions: [Action, ...Action[]]
): Promise<SiteRecord> {
  return (await requireSiteAs(deps, user, name, ...actions)).site
}

/** `requireSite`, with the user resolved against the site (for `toSite`). */
export function requireSiteAs(
  deps: Deps,
  user: User,
  name: string,
  ...actions: [Action, ...Action[]]
): Promise<{ site: SiteRecord; actor: Actor }> {
  return resolveSite(deps, userActor(user), name, ...actions)
}

/**
 * Write the site (with its index items) and its routes. `ifCurrentVersion`: only while the stored
 * site's current version is that one (`ConditionFailed` otherwise, nothing written).
 */
export async function save(
  deps: Deps,
  site: SiteRecord,
  oldShareToken?: string,
  opts: { ifCurrentVersion?: string } = {}
) {
  site.updatedAt = deps.clock.now().toISOString()
  await deps.store.putSite(site, opts)
  await syncRouteTable(deps, site, oldShareToken)
}

/**
 * A new audience for the site, checked: every address it adds one the instance would let sign in,
 * or one `inviter` may invite (`checkAddresses`, invitations.ts), every group slug one that exists
 * (400 `unknown_group`, naming them), stored by id. A deleted group's reference (`#<id>`) keeps
 * it, if the audience already names it. Returns the audience it had: once the site is saved,
 * `inviteAdded` invites the outside addresses it added and `notifyAudienceChange` tells the
 * addresses and groups it added.
 */
export async function applyAudience(
  deps: Deps,
  site: Pick<SiteRecord, 'audience'>,
  input: AudienceInput,
  inviter: Inviter
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
  const had = new Set(site.audience.emails)
  await checkAddresses(
    deps,
    emails.filter(e => !had.has(e)),
    inviter
  )
  const groups = await groupIds(deps, slugs, site.audience.groups)
  const before = site.audience
  site.audience = { emails, groups }
  return before
}

/**
 * Group slugs as ids, each once: every slug one that exists (400 `unknown_group`, naming them). A
 * deleted group's reference (`#<id>`) keeps it, if `current` already names it.
 */
async function groupIds(
  deps: Deps,
  slugs: readonly string[],
  current: readonly string[]
): Promise<string[]> {
  const ids = await Promise.all(
    slugs.map(async slug => {
      const kept = deletedGroupId(slug)
      if (kept !== null) return current.includes(kept) ? kept : null
      return (await deps.store.findGroup(slug))?.id ?? null
    })
  )
  const unknown = slugs.filter((_, i) => !ids[i])
  if (unknown.length) {
    throw new ApiError(400, 'unknown_group', `No group named ${unknown.join(', ')}`, {
      groups: unknown,
    })
  }
  return [...new Set(ids as string[])]
}

/**
 * New owners and publishers for the site, checked (site-roles.ts): each list within its caps,
 * every address it adds a member of the instance (`checkMembers`: never a guest, and nobody is
 * invited), every group slug one that exists, stored by id. The owners must keep an address (400
 * `last_owner`), and whoever is in both lists stays an owner only. What isn't given is kept.
 */
export async function applyRoles(
  deps: Deps,
  site: Pick<SiteRecord, 'owners' | 'publishers'>,
  input: { owners?: SiteRoleInput; publishers?: SiteRoleInput }
): Promise<void> {
  const parse = (
    given: SiteRoleInput | undefined,
    schema: typeof OwnersInputSchema,
    caps: [emails: number, groups: number, what: string]
  ) => {
    if (given === undefined) return undefined
    const parsed = schema.parse(given)
    const emails = [...new Set(parsed.emails)]
    const slugs = [...new Set(parsed.groups)]
    const [emailsMax, groupsMax, what] = caps
    if (emails.length > emailsMax) {
      throw badRequest(`A site has at most ${emailsMax} ${what} addresses`)
    }
    if (slugs.length > groupsMax)
      throw badRequest(`A site names at most ${groupsMax} ${what} groups`)
    return { emails, slugs }
  }
  const owners = parse(input.owners, OwnersInputSchema, [
    OWNER_EMAILS_MAX,
    OWNER_GROUPS_MAX,
    'owner',
  ])
  const publishers = parse(input.publishers, PublishersInputSchema, [
    PUBLISHER_EMAILS_MAX,
    PUBLISHER_GROUPS_MAX,
    'publisher',
  ])
  if (owners && owners.emails.length === 0) {
    throw new ApiError(
      400,
      'last_owner',
      'A site needs at least one person as an owner: add another owner before removing the last'
    )
  }
  const had = new Set([...site.owners.emails, ...site.publishers.emails])
  await checkMembers(
    deps,
    [...(owners?.emails ?? []), ...(publishers?.emails ?? [])].filter(e => !had.has(e))
  )
  const next = {
    owners: owners
      ? {
          emails: owners.emails,
          groups: await groupIds(deps, owners.slugs, site.owners.groups),
        }
      : site.owners,
    publishers: publishers
      ? {
          emails: publishers.emails,
          groups: await groupIds(deps, publishers.slugs, site.publishers.groups),
        }
      : site.publishers,
  }
  site.owners = next.owners
  site.publishers = {
    emails: next.publishers.emails.filter(e => !next.owners.emails.includes(e)),
    groups: next.publishers.groups.filter(g => !next.owners.groups.includes(g)),
  }
}

/**
 * Once the site is saved with a new audience: invite as guests the outside addresses it added
 * since `before` (invitations.ts `inviteGuests`; nothing when invitations are off).
 */
export async function inviteAdded(
  deps: Deps,
  inviter: Inviter,
  site: SiteRecord,
  before: SiteAudience
) {
  const had = new Set(before.emails)
  const added = site.audience.emails.filter(e => !had.has(e) && !admittedByConfig(deps.config, e))
  if (added.length) await inviteGuests(deps, inviter, added, { via: 'share', siteId: site.id })
}

/** What an access level sets on a site. */
export type AccessFields = Pick<SiteRecord, 'visibility' | 'restricted' | 'audience'>

const NO_AUDIENCE = (): SiteAudience => ({ emails: [], groups: [] })

/**
 * Set the site's access level, checked (400 when `audience` doesn't fit it, `accessProblem`):
 * `only_me` and `members` make it private and empty the audience, `groups` and `people` make it
 * private and restricted to `audience` (`applyAudience`), and `public` keeps the private settings
 * for when it is private again. Returns the audience it had, for `notifyAudienceChange`.
 */
export async function applyAccess(
  deps: Deps,
  site: AccessFields,
  level: AccessLevel,
  audience: AudienceInput | undefined,
  inviter: Inviter
): Promise<SiteAudience> {
  const problem = accessProblem(level, audience)
  if (problem) throw badRequest(problem)
  const before = site.audience
  if (level === 'public') {
    site.visibility = 'public'
    return before
  }
  site.visibility = 'private'
  site.restricted = level !== 'members'
  if (needsAudience(level)) await applyAudience(deps, site, audience as AudienceInput, inviter)
  else site.audience = NO_AUDIENCE()
  return before
}

/**
 * Who can open a new site: the level its first deploy names (with its audience), else the
 * instance's default (`SITE_DEFAULT_ACCESS`). A new public site keeps the default's private
 * settings for when it is made private. Checked before the name is claimed, so a bad audience
 * claims nothing.
 */
export async function initialAccess(
  deps: Deps,
  req: { access?: AccessLevel; audience?: AudienceInput },
  inviter: Inviter
): Promise<AccessFields> {
  const level = req.access ?? deps.config.siteDefaultAccess
  if (req.access === undefined && req.audience !== undefined) {
    throw badRequest('`audience` goes with `access` ("groups" or "people")')
  }
  const fields: AccessFields = {
    visibility: 'private',
    restricted: deps.config.siteDefaultAccess === 'only_me',
    audience: NO_AUDIENCE(),
  }
  await applyAccess(deps, fields, level, req.audience, inviter)
  return fields
}

/**
 * Take a group out of the audiences and the roles that name it (deleting the group), never
 * widening who sees a site: an audience that names others as well loses it; one it is the only
 * entry of keeps its id, which matches nobody, so the site stays restricted to its owners until
 * they change the audience. Owners and publishers always lose it (the owners keep their
 * addresses). Each site is saved the usual way.
 */
export async function dropGroup(deps: Deps, groupId: string) {
  const [audiences, roles] = await Promise.all([
    deps.store.listGroupSites(groupId),
    deps.store.listGroupRoleSites(groupId),
  ])
  const named = new Map<string, string>()
  for (const item of audiences) named.set(item.siteId, item.name)
  for (const item of roles) named.set(item.id, item.name)
  const without = (list: SiteRoleList) => ({
    ...list,
    groups: list.groups.filter(g => g !== groupId),
  })
  for (const [siteId, name] of named) {
    const site = await deps.store.findSite(name)
    if (site?.id !== siteId) continue
    let changed = false
    const audience = site.audience
    const groups = audience.groups.filter(g => g !== groupId)
    if (groups.length < audience.groups.length && audience.emails.length + groups.length > 0) {
      site.audience = { ...audience, groups }
      changed = true
    }
    for (const role of ['owners', 'publishers'] as const) {
      if (site[role].groups.includes(groupId)) {
        site[role] = without(site[role])
        changed = true
      }
    }
    if (changed) await save(deps, site)
  }
}

export function applySettings(site: SiteRecord, opts: { spa?: boolean; visibility?: Visibility }) {
  if (opts.spa !== undefined) site.spa = opts.spa
  if (opts.visibility !== undefined) site.visibility = opts.visibility
}

/**
 * The sites `email` holds a role on (owner or publisher), each once, newest copy first, read from
 * index items alone: the sites they created (kept only while they still hold a role), their role
 * items, and their groups' role items (`groups`, their memberships). Each copy is asked of policy,
 * so an item a role no longer backs (two saves of a site racing) lists nothing.
 */
export async function roleSites(
  deps: Deps,
  user: { email: string; guest?: true },
  groups: readonly string[]
): Promise<SiteRecord[]> {
  // A guest holds no role, even one an address or a group names.
  if (user.guest) return []
  const { email } = user
  const [created, held, viaGroups] = await Promise.all([
    deps.store.listSites(email),
    deps.store.listRoleSites(email),
    mapLimit([...groups], SHARED_READ_CONCURRENCY, id => deps.store.listGroupRoleSites(id)),
  ])
  const newest = new Map<string, SiteRecord>()
  for (const copy of [...created, ...held, ...viaGroups.flat()]) {
    const { role: _role, ...site } = copy as SiteRecord & { role?: string }
    if ((newest.get(site.id)?.updatedAt ?? '') < site.updatedAt) newest.set(site.id, site)
  }
  // No admin flag: an admin's sites are the ones they hold a role on.
  const actor: Actor = { kind: 'user', email, groups }
  return [...newest.values()].filter(s =>
    rolesOf(actor, s).some(r => r === 'owner' || r === 'publisher')
  )
}

/**
 * GET /api/sites — the sites the user owns or publishes (`roleSites`), newest first: live ones, or
 * the archived ones.
 */
export async function listSites(deps: Deps, user: User, archived: boolean): Promise<Site[]> {
  const groups = await groupsOf(deps, user.email)
  const actor: Actor = { ...userActor(user), groups }
  const sites = await roleSites(deps, user, groups)
  return sites
    .filter(s => s.archived === archived && (archived || s.currentVersionId !== null))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(s => toSite(deps, actor, s))
}

/** Group-site queries, and sites read for v1 index items, run at once while listing. */
const SHARED_READ_CONCURRENCY = 10

/**
 * GET /api/shared — the restricted sites of others that the user may see because the audience
 * names them, directly or through a group they are in. One query for their direct grants, one for
 * their memberships and one per group for its site items; each item carries the site's listing
 * (`SharedListing`), so no site is read. Sites that aren't live (archived, or no current version)
 * are left out, as are merely private ones, which every member sees anyway, and those the user
 * owns or publishes (`roleSites`), which are in their own list. Last updated first.
 *
 * Being in the audience is implied by the item existing (items are written and removed with the
 * audience, `putSite`), and a group counts only while the user is a member of it now. An item the
 * audience no longer backs (two saves of a site racing) lists the site's name until it is
 * cleaned, nothing more: opening the site goes through `requireSite`, policy and the edge's site
 * pass, which read the audience. A v1 item (no listing) is answered from the site itself, asked
 * of policy.
 */
export async function listShared(deps: Deps, user: User): Promise<SharedSite[]> {
  const [grants, groups] = await Promise.all([
    deps.store.listSiteGrants(user.email),
    groupsOf(deps, user.email),
  ])
  const [groupSites, held] = await Promise.all([
    mapLimit(groups, SHARED_READ_CONCURRENCY, id => deps.store.listGroupSites(id)).then(s =>
      s.flat()
    ),
    roleSites(deps, user, groups).then(sites => new Set(sites.map(s => s.id))),
  ])

  const listed = new Map<string, SharedListing>()
  const unlisted = new Map<string, string>()
  for (const item of [...grants, ...groupSites]) {
    if (!hasListing(item)) unlisted.set(item.siteId, item.name)
    else if ((listed.get(item.siteId)?.updatedAt ?? '') < item.updatedAt) {
      listed.set(item.siteId, item)
    }
  }
  const direct = new Set(grants.map(g => g.siteId))
  const viaGroups = new Map<string, string[]>()
  for (const item of groupSites) {
    viaGroups.set(item.siteId, [...(viaGroups.get(item.siteId) ?? []), item.groupId])
  }
  const shown = (s: SharedListing) => !held.has(s.siteId) && !s.archived && s.live && s.restricted
  const visible: { listing: SharedListing; direct: boolean; groups: string[] }[] = [
    ...listed.values(),
  ]
    .filter(shown)
    .map(listing => ({
      listing,
      direct: direct.has(listing.siteId),
      groups: viaGroups.get(listing.siteId) ?? [],
    }))

  // v1 items: read the site and ask policy, as the listing would have answered.
  const actor: Actor = {
    kind: 'user',
    email: user.email,
    groups,
    ...(user.guest ? { guest: true as const } : {}),
  }
  const fromSites = await mapLimit(
    [...unlisted].filter(([id]) => !listed.has(id)),
    SHARED_READ_CONCURRENCY,
    async ([id, name]) => {
      const site = await deps.store.findSite(name)
      if (site?.id !== id || !shown(listingOf(site)) || !can(actor, 'site.view', site)) return []
      return [
        {
          listing: listingOf(site),
          direct: site.audience.emails.includes(user.email),
          groups: site.audience.groups.filter(g => groups.includes(g)),
        },
      ]
    }
  )
  visible.push(...fromSites.flat())

  const slugs = new Map(
    (await deps.store.getGroups([...new Set(visible.flatMap(v => v.groups))])).map(g => [
      g.id,
      g.slug,
    ])
  )
  const { sitesDomain, appOrigin, comments } = deps.config
  return sortSites(
    visible.map(({ listing, direct, groups }) => ({
      name: listing.name,
      url: siteUrl(siteLabel(listing.name), sitesDomain, protocol(deps)),
      ...(comments ? { reviewUrl: reviewUrl(appOrigin, listing.name) } : {}),
      owner: listing.owner,
      via: { direct, groups: groups.flatMap(id => slugs.get(id) ?? []) },
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
    }))
  )
}

export async function siteDetail(deps: Deps, user: User, name: string): Promise<SiteDetail> {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.read', 'version.list')
  const [versions, audience, roles] = await Promise.all([
    deps.store.listVersions(site),
    audienceOf(deps, site),
    rolesView(deps, site),
  ])
  return {
    ...toSite(deps, actor, site),
    owner: firstOwner(site),
    audience,
    ...roles,
    versions: versions
      .filter(v => v.status === 'complete')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(v => ({
        id: v.id,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        ...(v.publishedBy ? { publishedBy: v.publishedBy } : {}),
        ...(v.path ? { path: v.path } : {}),
        ...(v.base ? { base: v.base } : {}),
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

/**
 * PATCH /api/sites/:name. `access` sets the level (with `audience` for `groups` and `people`);
 * without it, `visibility` and `audience` edit those alone, and an audience edit restricts the site
 * when the audience names someone and opens it to every member when it is empty. `owners` and
 * `publishers` replace those lists (`applyRoles`).
 */
export async function updateSite(
  deps: Deps,
  user: User,
  name: string,
  patch: {
    spa?: boolean
    visibility?: Visibility
    audience?: AudienceInput
    access?: AccessLevel
    owners?: SiteRoleInput
    publishers?: SiteRoleInput
  },
  principal: Principal
): Promise<Site & { audience?: Audience; owners?: SiteRoleMembers; publishers?: SiteRoleMembers }> {
  if (patch.access !== undefined && patch.visibility !== undefined) {
    throw badRequest('Pass `access` or `visibility`, not both')
  }
  const actions: Action[] = [
    ...(patch.visibility === undefined && patch.access === undefined
      ? []
      : (['site.visibility'] as const)),
    ...(patch.spa === undefined ? [] : (['site.settings'] as const)),
    ...(patch.audience === undefined && patch.access === undefined
      ? []
      : (['site.audience'] as const)),
    ...(patch.owners === undefined ? [] : (['site.owners'] as const)),
    ...(patch.publishers === undefined ? [] : (['site.publishers'] as const)),
  ]
  const [first = 'site.settings', ...rest] = actions
  const site = await requireSite(deps, user, name, first, ...rest)
  const roles = patch.owners !== undefined || patch.publishers !== undefined
  const rolesBefore = { owners: site.owners, publishers: site.publishers }
  if (roles) await applyRoles(deps, site, patch)
  applySettings(site, patch)
  let before: SiteAudience | undefined
  const inviter = inviterOf(principal)
  if (patch.access !== undefined) {
    before = await applyAccess(deps, site, patch.access, patch.audience, inviter)
  } else if (patch.audience !== undefined) {
    before = await applyAudience(deps, site, patch.audience, inviter)
    site.restricted = site.audience.emails.length + site.audience.groups.length > 0
  }
  await save(deps, site)
  // The invitations first: the share's email, sent later, goes only to people with standing.
  if (before) await inviteAdded(deps, inviter, site, before)
  if (before) await notifyAudienceChange(deps, user.email, site, before, actingOf(principal))
  if (roles) await notifyRoleChange(deps, user.email, site, rolesBefore, actingOf(principal))
  // The caller may have just changed their own role.
  const after = await siteActor(deps, user, site)
  return {
    ...toSite(deps, after, site),
    ...(before ? { audience: await audienceOf(deps, site) } : {}),
    ...(roles ? await rolesView(deps, site) : {}),
  }
}

export async function rollback(deps: Deps, user: User, name: string, versionId: string) {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.rollback')
  const version = await deps.store.getVersion(site, versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} for "${name}"`)
  site.currentVersionId = versionId
  await save(deps, site)
  return toSite(deps, actor, site)
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
  const { site, actor } = await requireSiteAs(deps, user, name, 'share.revoke')
  const old = site.shareToken ?? undefined
  site.shareToken = null
  await save(deps, site, old)
  return toSite(deps, actor, site)
}

export async function setArchived(deps: Deps, user: User, name: string, archived: boolean) {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.archive')
  site.archived = archived
  await save(deps, site)
  return toSite(deps, actor, site)
}

/**
 * Where `/auth/login` sends a signed-in user (`ret`, already through safeReturnUrl). A restricted
 * site's host, and a members-level site's to a guest, is let in only through a site pass: someone
 * policy lets view it goes by its
 * `/_fling-pass` with a 60-second handoff naming them and the site; anyone else goes the same way
 * with a 60-second deny handoff naming only the site, after which the edge answers the site as a
 * missing one (its 404 page at the address asked for). An admin is let in to any site, and an
 * admin let in only as one is audited (`site.open`). Every other return URL is unchanged.
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
  // The edge wants a pass for a restricted site, and for a members-level one from a guest.
  if (!site || site.visibility === 'public') return ret
  if (!isRestricted(site) && !user.guest) return ret
  // Always a browser session here: an admin opens any site, on the record.
  const actor = await actorOn(deps, userActor(asRequestUser(config, user, 'session')), site)
  const x = Math.floor(deps.clock.now().getTime() / 1000) + PASS_HANDOFF_TTL_SECONDS
  const key = config.secrets.siteHmacKey
  const viewer = can(actor, 'site.view', site)
  if (viewer) await auditAdmin(deps, actor, site, 'site.view')
  const t = viewer
    ? signPassHandoff({ s: site.id, e: user.email, x }, key)
    : signDenyHandoff({ s: site.id, x }, key)
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
