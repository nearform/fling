/**
 * Site lifecycle: deploy → (upload) → finalize, rollback, settings, share links, archive,
 * delete. The KVS is a projection of the store: `syncKvs` writes `site:<label>` (and
 * `share:<token>`) for a live site and removes them otherwise.
 *
 * Names are one global namespace (first come, first served): the first deploy to a name claims
 * it (store.createSite); deploying to a name another user owns → 409 `name_taken` with free
 * suggestions. Deleting a site frees its name; archiving keeps it.
 *
 * Deploy semantics (versionId = computeVersionId(manifest)):
 *  - equals the current version → `unchanged`
 *  - a complete version with that id exists for this site → `repointed`
 *  - otherwise → `upload`: a pending version is recorded (manifest kept in storage) and presigned
 *    PUTs are returned; `finalize` verifies every object and makes it live.
 * Deploying (including unchanged/repointed) an archived site unarchives it. `spa`/`visibility`
 * on the request are applied when the deploy takes effect; omitted → keep the site's current
 * setting (new sites: private, non-SPA).
 */
import {
  type DeployRequest,
  type DeployResponse,
  initialsFromEmail,
  isValidSiteName,
  type KvsSiteValue,
  type Manifest,
  type ManifestFile,
  type NameCheck,
  nameSuggestions,
  SITE_NAME_MAX,
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
  type Visibility,
} from '@fling/shared'
import { computeVersionId } from '@fling/shared/version-id'
import { mapLimit } from './lib/concurrency.ts'
import { badRequest, conflict, notFound } from './lib/errors.ts'
import { newId, newShareToken } from './lib/ids.ts'
import { manifestKey } from './storage/types.ts'
import type { SiteRecord, User, VersionRecord } from './store/types.ts'
import type { Deps } from './types.ts'

const HEAD_CONCURRENCY = 16
const MAX_MISSING_LISTED = 50

export const cacheControlFor = (path: string) =>
  /\.html?$/i.test(path) ? 'public, max-age=60' : 'public, max-age=31536000, immutable'

const protocol = (deps: Deps) => `${deps.config.siteScheme}:`

export function toSite(deps: Deps, user: User, site: SiteRecord): Site {
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

/** Make the KVS reflect the site: live (not archived, has a version) → keys present, else gone. */
export async function syncKvs(deps: Deps, user: User, site: SiteRecord, oldShareToken?: string) {
  const { kvs } = deps
  const label = siteLabel(site.name)
  if (oldShareToken && oldShareToken !== site.shareToken) {
    await kvs.delete(shareKvsKey(oldShareToken))
  }
  if (site.archived || !site.currentVersionId) {
    await kvs.delete(siteKvsKey(label))
    if (site.shareToken) await kvs.delete(shareKvsKey(site.shareToken))
    return
  }
  const value: KvsSiteValue = {
    id: site.id,
    v: site.currentVersionId,
    vis: site.visibility,
    spa: site.spa,
  }
  const json = JSON.stringify(value)
  await kvs.put(siteKvsKey(label), json)
  if (site.shareToken) await kvs.put(shareKvsKey(site.shareToken), json)
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

async function nameTaken(deps: Deps, user: User, name: string) {
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
  if (await deps.store.getSite(user.email, name)) return { name, status: 'yours', suggestions: [] }
  const claim = await deps.store.getNameClaim(name)
  if (!claim) return { name, status: 'available', suggestions: [] }
  if (claim.email === user.email) return { name, status: 'yours', suggestions: [] }
  return { name, status: 'taken', suggestions: await freeNameSuggestions(deps, user, name) }
}

export async function requireSite(deps: Deps, user: User, name: string): Promise<SiteRecord> {
  const site = isValidSiteName(name) ? await deps.store.getSite(user.email, name) : null
  if (!site) throw notFound(`No site named "${name}"`)
  return site
}

async function save(deps: Deps, user: User, site: SiteRecord, oldShareToken?: string) {
  site.updatedAt = deps.clock.now().toISOString()
  await deps.store.putSite(site)
  await syncKvs(deps, user, site, oldShareToken)
}

function applySettings(site: SiteRecord, opts: { spa?: boolean; visibility?: Visibility }) {
  if (opts.spa !== undefined) site.spa = opts.spa
  if (opts.visibility !== undefined) site.visibility = opts.visibility
}

export async function deploy(
  deps: Deps,
  user: User,
  name: string,
  req: DeployRequest,
  /** presign: false → no presigned URLs (`uploads: []`); the caller writes objects itself */
  opts: { presign?: boolean } = {}
): Promise<DeployResponse> {
  if (!isValidSiteName(name)) {
    throw badRequest(
      `Site names are 1-${SITE_NAME_MAX} chars of a-z, 0-9 and single hyphens, starting and ending alphanumeric, and not reserved`,
      'invalid_name'
    )
  }
  const { store, storage, clock } = deps
  const versionId = computeVersionId(req.manifest.files)
  const existing = await store.getSite(user.email, name)
  if (!existing) {
    const claim = await store.getNameClaim(name)
    if (claim && claim.email !== user.email) throw await nameTaken(deps, user, name)
  }

  if (existing && existing.currentVersionId === versionId) {
    applySettings(existing, req)
    existing.archived = false
    await save(deps, user, existing)
    return { status: 'unchanged', versionId, site: toSite(deps, user, existing) }
  }

  if (existing) {
    const version = await store.getVersion(user.email, existing.id, versionId)
    if (version?.status === 'complete') {
      existing.currentVersionId = versionId
      existing.archived = false
      applySettings(existing, req)
      await save(deps, user, existing)
      return { status: 'repointed', versionId, site: toSite(deps, user, existing) }
    }
  }

  const now = clock.now().toISOString()
  // First deploy reserves the siteId; it stays unlisted until a version goes live.
  const site =
    existing ??
    (await store.createSite({
      id: newId(),
      email: user.email,
      name,
      visibility: 'private',
      spa: false,
      archived: false,
      currentVersionId: null,
      shareToken: null,
      createdAt: now,
      updatedAt: now,
    }))
  // Lost a race for the name to another user.
  if (!site) throw await nameTaken(deps, user, name)

  const files = req.manifest.files
  const pending: VersionRecord = {
    siteId: site.id,
    id: versionId,
    status: 'pending',
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    spa: req.spa,
    visibility: req.visibility,
    createdAt: now,
  }
  await storage.putJson(manifestKey(site.id, versionId), { files } satisfies Manifest)
  await store.putVersion(user.email, pending)

  if (opts.presign === false) return { status: 'upload', versionId, uploads: [] }
  const uploads = await mapLimit(files, 32, async file => {
    const signed = await storage.presignPut(siteObjectKey(site.id, versionId, file.path), {
      contentType: file.contentType,
      cacheControl: cacheControlFor(file.path),
    })
    return { path: file.path, url: signed.url, headers: signed.headers }
  })
  return { status: 'upload', versionId, uploads }
}

export async function finalize(deps: Deps, user: User, name: string, versionId: string) {
  const { store, storage } = deps
  const site = await requireSite(deps, user, name)
  const version = await store.getVersion(user.email, site.id, versionId)
  if (!version) throw notFound(`No deploy ${versionId} for "${name}"`)

  if (version.status === 'pending') {
    const manifest = await storage.getJson<{ files: ManifestFile[] }>(
      manifestKey(site.id, versionId)
    )
    if (!manifest) throw notFound(`Manifest for deploy ${versionId} is gone; deploy again`)
    const checks = await mapLimit(manifest.files, HEAD_CONCURRENCY, async file => {
      const head = await storage.head(siteObjectKey(site.id, versionId, file.path))
      return head && head.size === file.size ? null : file.path
    })
    const missing = checks.filter((p): p is string => p !== null)
    if (missing.length > 0) {
      const listed = missing.slice(0, MAX_MISSING_LISTED)
      const more =
        missing.length > listed.length ? ` (+${missing.length - listed.length} more)` : ''
      throw conflict(
        `${missing.length} file(s) missing or the wrong size: ${listed.join(', ')}${more}`,
        'missing_uploads',
        { missing }
      )
    }
    await store.putVersion(user.email, { ...version, status: 'complete' })
  }

  site.currentVersionId = versionId
  site.archived = false
  applySettings(site, version)
  await save(deps, user, site)
  return { status: 'live' as const, versionId, site: toSite(deps, user, site) }
}

export async function listSites(deps: Deps, user: User, archived: boolean): Promise<Site[]> {
  const sites = await deps.store.listSites(user.email)
  return sites
    .filter(s => s.archived === archived && (archived || s.currentVersionId !== null))
    .map(s => toSite(deps, user, s))
}

export async function siteDetail(deps: Deps, user: User, name: string): Promise<SiteDetail> {
  const site = await requireSite(deps, user, name)
  const versions = await deps.store.listVersions(user.email, site.id)
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

export async function updateSite(
  deps: Deps,
  user: User,
  name: string,
  patch: { spa?: boolean; visibility?: Visibility }
) {
  const site = await requireSite(deps, user, name)
  applySettings(site, patch)
  await save(deps, user, site)
  return toSite(deps, user, site)
}

export async function rollback(deps: Deps, user: User, name: string, versionId: string) {
  const site = await requireSite(deps, user, name)
  const version = await deps.store.getVersion(user.email, site.id, versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} for "${name}"`)
  site.currentVersionId = versionId
  await save(deps, user, site)
  return toSite(deps, user, site)
}

export async function rotateShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name)
  const old = site.shareToken ?? undefined
  site.shareToken = newShareToken()
  await save(deps, user, site, old)
  return {
    shareUrl: siteUrl(shareLabel(site.shareToken), deps.config.sitesDomain, protocol(deps)),
  }
}

export async function revokeShare(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name)
  const old = site.shareToken ?? undefined
  site.shareToken = null
  await save(deps, user, site, old)
  return toSite(deps, user, site)
}

export async function setArchived(deps: Deps, user: User, name: string, archived: boolean) {
  const site = await requireSite(deps, user, name)
  site.archived = archived
  await save(deps, user, site)
  return toSite(deps, user, site)
}

export async function deleteSite(deps: Deps, user: User, name: string) {
  const site = await requireSite(deps, user, name)
  await deps.kvs.delete(siteKvsKey(siteLabel(site.name)))
  if (site.shareToken) await deps.kvs.delete(shareKvsKey(site.shareToken))
  await deps.storage.deletePrefix(sitePrefix(site.id))
  await deps.store.deleteVersions(user.email, site.id)
  await deps.store.deleteSite(user.email, site.name)
}
