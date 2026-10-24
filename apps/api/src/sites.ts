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
 */
import {
  initialsFromEmail,
  isGeneratedListing,
  isValidSiteName,
  type KvsSiteValue,
  type Manifest,
  type ManifestFile,
  type NameCheck,
  nameSuggestions,
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
  type VersionFiles,
  type Visibility,
} from '@fling/shared'
import { manifestKey } from './blobs/types.ts'
import { conflict, notFound } from './lib/errors.ts'
import { newShareToken } from './lib/ids.ts'
import { type Action, can, userActor } from './policy.ts'
import type { SiteRecord, User } from './store/types.ts'
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
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  }
}

/** Make the route table reflect the site: live (not archived, has a version) → keys present, else gone. */
export async function syncRouteTable(
  deps: Deps,
  _user: User,
  site: SiteRecord,
  oldShareToken?: string
) {
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

/**
 * The site named `name`, if the user may do every one of `actions` to it; else 404, the same
 * answer as for a name nobody holds.
 */
export async function requireSite(
  deps: Deps,
  user: User,
  name: string,
  ...actions: [Action, ...Action[]]
): Promise<SiteRecord> {
  const site = isValidSiteName(name) ? await deps.store.findSite(name) : null
  if (!site || !actions.every(a => can(userActor(user), a, site))) {
    throw notFound(`No site named "${name}"`)
  }
  return site
}

export async function save(deps: Deps, user: User, site: SiteRecord, oldShareToken?: string) {
  site.updatedAt = deps.clock.now().toISOString()
  await deps.store.putSite(site)
  await syncRouteTable(deps, user, site, oldShareToken)
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

export async function siteDetail(deps: Deps, user: User, name: string): Promise<SiteDetail> {
  const site = await requireSite(deps, user, name, 'site.read', 'version.list')
  const versions = await deps.store.listVersions(site)
  return {
    ...toSite(deps, user, site),
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
  patch: { spa?: boolean; visibility?: Visibility }
) {
  const site = await requireSite(
    deps,
    user,
    name,
    patch.visibility === undefined ? 'site.settings' : 'site.visibility',
    ...(patch.spa === undefined ? [] : (['site.settings'] as const))
  )
  applySettings(site, patch)
  await save(deps, user, site)
  return toSite(deps, user, site)
}

export async function rollback(deps: Deps, user: User, name: string, versionId: string) {
  const site = await requireSite(deps, user, name, 'site.rollback')
  const version = await deps.store.getVersion(site, versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} for "${name}"`)
  site.currentVersionId = versionId
  await save(deps, user, site)
  return toSite(deps, user, site)
}

export async function rotateShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name, 'share.create')
  const old = site.shareToken ?? undefined
  site.shareToken = newShareToken()
  await save(deps, user, site, old)
  return {
    shareUrl: siteUrl(shareLabel(site.shareToken), deps.config.sitesDomain, protocol(deps)),
  }
}

export async function revokeShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name, 'share.revoke')
  const old = site.shareToken ?? undefined
  site.shareToken = null
  await save(deps, user, site, old)
  return toSite(deps, user, site)
}

export async function setArchived(deps: Deps, user: User, name: string, archived: boolean) {
  const site = await requireSite(deps, user, name, 'site.archive')
  site.archived = archived
  await save(deps, user, site)
  return toSite(deps, user, site)
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
