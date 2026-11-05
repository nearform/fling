/**
 * Paths: top-level folders of a site, each with its own versions, owners and publishers (PathRecord
 * in store/types.ts). A path publish to one folder (`--path PAY-412`) publishes to that folder's
 * Path, making it on first use; nested folders (`reports/2026`) are path publishes of the site
 * itself (publication.ts). Publishing to a Path never touches the site's version or another Path,
 * so teammates publishing to different Paths never wait on each other.
 *
 * Serving: a site with live Paths says so in its route value (`p`), and each live Path has its own
 * route key, `path:<siteId>/<folder>` → `{id, v, m?}` (kvs.ts). The edge serves a request whose
 * first folder is a live Path from the Path's version; everything else from the site's. A Path
 * hides the site's own copy of its folder.
 *
 * Access is the site's: whoever sees the site sees its Paths. Changing a Path is asked of policy as
 * the site action on `pathPolicySite` (policy.ts): its owners and publishers, and the site's
 * owners. Making a new Path is `site.deploy` on the site.
 *
 * The home page: while a site has live Paths and its home page asks for them (a Paths block in its
 * root index.html, or no home page at all: `VersionRecord.home`, rendering.ts), the API renders
 * the page with the listing filled in (paths-index.ts in shared) to
 * `sites/<siteId>/_rendered/<hash>.html`, with the listing's data beside it as `.json`, and the
 * route value names the hash (`i`), so the edge serves them for `/` and `/_fling-paths.json`. The
 * hash names the content, so the objects are immutable. `refreshHome` brings it up to date after
 * any change to the site's version or its Paths.
 */
import { createHash } from 'node:crypto'
import {
  cacheControlFor,
  displayPublishPath,
  type KvsPathValue,
  type PathDetail,
  pathKvsKey,
  renderedObjectKey,
  type SitePath,
  type SiteRoleInput,
  siteObjectKey,
  sitePrefix,
  type VersionFiles,
} from '@fling/shared'
import { type PathListing, renderPathsIndex } from '@fling/shared/paths-index'
import { manifestKey } from './blobs/types.ts'
import { conflict, notFound } from './lib/errors.ts'
import { type Action, type Actor, can, pathPolicySite } from './policy.ts'
import {
  actorOn,
  applyRoles,
  detectGeneratedIndex,
  requireSiteAs,
  rolesView,
  type StoredManifest,
  syncRouteTable,
  toSite,
} from './sites.ts'
import type { PathRecord, SiteRecord, SiteRef, User } from './store/types.ts'
import { ConditionFailed } from './table/types.ts'
import type { Deps } from './types.ts'

/** Where a Path's versions are kept: its own partition, under the site's creator for the old keys. */
export const pathRef = (
  site: Pick<SiteRecord, 'email'>,
  path: Pick<PathRecord, 'id'>
): SiteRef => ({
  id: path.id,
  email: site.email,
})

/** A path publish to one top-level folder publishes to its Path (`nested/folders` don't). */
export const isPathFolder = (path: string) => path.indexOf('/') === -1

/** Served at `/<folder>/`: not archived, and published. */
export const isLivePath = (path: PathRecord) => !path.archived && path.currentVersionId !== null

/** Make the Path's route key match it: present while it is live (and its site is), else gone. */
export async function syncPathRoute(deps: Deps, site: SiteRecord, path: PathRecord) {
  const key = pathKvsKey(site.id, path.folder)
  if (!isLivePath(path) || !path.currentVersionId) {
    await deps.routeTable.delete(key)
    return
  }
  const version = await deps.store.getVersion(pathRef(site, path), path.currentVersionId)
  const value: KvsPathValue = {
    id: path.id,
    v: path.currentVersionId,
    ...(version?.markdown ? { m: 1 as const } : {}),
  }
  await deps.routeTable.put(key, JSON.stringify(value))
}

/** The listing the home page shows: the live Paths, as paths-index.ts takes them. */
export function pathListing(paths: readonly PathRecord[]): PathListing[] {
  return paths.filter(isLivePath).map(p => ({
    folder: p.folder,
    title: p.title,
    updated: p.updatedAt,
    version: p.currentVersionId as string,
  }))
}

/**
 * Bring the site's Paths flag (`paths`) and rendered home page (`home`) up to date with its
 * current version and live Paths, and its routes with them. Writes only what changed, and the site
 * only while its current version is the one this read: a publish meanwhile refreshes it again.
 */
export async function refreshHome(deps: Deps, site: SiteRecord) {
  const paths = pathListing(await deps.store.listPaths(site.id))
  let home: string | undefined
  if (paths.length > 0 && site.currentVersionId) {
    const version = await deps.store.getVersion(site, site.currentVersionId)
    let html: string | null = null
    if (version?.home === 'block') {
      const bytes = await deps.blobs.get(
        siteObjectKey(site.id, site.currentVersionId, 'index.html')
      )
      html = bytes ? new TextDecoder().decode(bytes) : null
    }
    if (version?.home) {
      const page = renderPathsIndex(html, paths, { siteName: site.name })
      home = createHash('sha256')
        .update(page.html)
        .update('\0')
        .update(page.json)
        .digest('hex')
        .slice(0, 16)
      if (home !== site.home) {
        const encoder = new TextEncoder()
        await deps.blobs.put(renderedObjectKey(site.id, home, 'html'), encoder.encode(page.html), {
          contentType: 'text/html; charset=utf-8',
          cacheControl: cacheControlFor('a.html'),
        })
        await deps.blobs.put(renderedObjectKey(site.id, home, 'json'), encoder.encode(page.json), {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'no-cache',
        })
      }
    }
  }
  const hasPaths = paths.length > 0
  if ((site.paths === true) === hasPaths && site.home === home) return
  if (hasPaths) site.paths = true
  else delete site.paths
  if (home) site.home = home
  else delete site.home
  // A rendered page is not a change to the site: `updatedAt` stays.
  try {
    await deps.store.putSite(
      site,
      site.currentVersionId ? { ifCurrentVersion: site.currentVersionId } : {}
    )
  } catch (err) {
    if (err instanceof ConditionFailed) return
    throw err
  }
  await syncRouteTable(deps, site)
}

/**
 * Point the Path at a complete version (unarchiving it), then its route and the site's home page.
 * The Path is written only while its current version is still `base` (the one read): a change
 * meanwhile wins, and this is 409 `base_changed`.
 */
export async function makePathCurrent(
  deps: Deps,
  site: SiteRecord,
  path: PathRecord,
  versionId: string,
  title: string | null,
  base: string | null = path.currentVersionId
) {
  path.currentVersionId = versionId
  path.archived = false
  if (title !== null) path.title = title
  path.updatedAt = deps.clock.now().toISOString()
  await putPathOn(deps, site, path, base)
  await syncPathRoute(deps, site, path)
  await refreshHome(deps, site)
}

/** Write the Path while its current version is still `base`; else 409 `base_changed`. */
async function putPathOn(deps: Deps, site: SiteRecord, path: PathRecord, base: string | null) {
  try {
    await deps.store.putPath(path, base === null ? {} : { ifCurrentVersion: base })
  } catch (err) {
    if (err instanceof ConditionFailed) {
      throw conflict(
        `${displayPublishPath(path.folder)} of "${site.name}" changed meanwhile: try again`,
        'base_changed'
      )
    }
    throw err
  }
}

// --- the Path routes (/api/sites/:name/paths…) -------------------------------------------------

/**
 * The site named `name`, its Path at `folder` and the user resolved against the Path
 * (`pathPolicySite`), if they may see the site and do every one of `actions` to the Path; else
 * 404, as for a Path that isn't there.
 */
export async function requirePath(
  deps: Deps,
  user: User,
  name: string,
  folder: string,
  ...actions: Action[]
): Promise<{ site: SiteRecord; path: PathRecord; actor: Actor; siteActor: Actor }> {
  const { site, actor: siteActor } = await requireSiteAs(deps, user, name, 'site.view')
  const path = await deps.store.getPath(site.id, folder)
  const policySite = path ? pathPolicySite(site, path) : site
  const actor = path ? await actorOn(deps, siteActor, policySite) : siteActor
  if (!path || !actions.every(a => can(actor, a, policySite))) {
    throw notFound(`"${name}" has no Path ${displayPublishPath(folder)}`)
  }
  return { site, path, actor, siteActor }
}

/** The Path as the API shows it to `actor` (SitePathSchema). */
async function toSitePath(
  deps: Deps,
  site: SiteRecord,
  siteActor: Actor,
  path: PathRecord
): Promise<SitePath> {
  const policySite = pathPolicySite(site, path)
  const actor = await actorOn(deps, siteActor, policySite)
  const onSite = can(siteActor, 'site.read', site)
  return {
    folder: path.folder,
    title: path.title,
    url: `${toSite(deps, siteActor, site).url}${encodeURIComponent(path.folder)}/`,
    currentVersionId: path.currentVersionId,
    archived: path.archived,
    ...(onSite ? { ...(await rolesView(deps, path)), createdBy: path.createdBy } : {}),
    canPublish: can(actor, 'site.deploy', policySite),
    createdAt: path.createdAt,
    updatedAt: path.updatedAt,
  }
}

/**
 * GET /api/sites/:name/paths: whoever sees the site sees its live Paths (as its home page lists
 * them); those on the site (`site.read`) see the archived and unpublished ones too, with roles.
 */
export async function listPathsOf(deps: Deps, user: User, name: string): Promise<SitePath[]> {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.view')
  const onSite = can(actor, 'site.read', site)
  const paths = (await deps.store.listPaths(site.id)).filter(p => onSite || isLivePath(p))
  return Promise.all(paths.map(p => toSitePath(deps, site, actor, p)))
}

/** GET /api/sites/:name/paths/:folder: the Path and its versions (`version.list` on it). */
export async function pathDetail(
  deps: Deps,
  user: User,
  name: string,
  folder: string
): Promise<PathDetail> {
  const { site, path, siteActor } = await requirePath(deps, user, name, folder, 'version.list')
  const versions = await deps.store.listVersions(pathRef(site, path))
  return {
    ...(await toSitePath(deps, site, siteActor, path)),
    versions: versions
      .filter(v => v.status === 'complete')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(v => ({
        id: v.id,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        ...(v.publishedBy ? { publishedBy: v.publishedBy } : {}),
        path: path.folder,
        ...(v.base ? { base: v.base } : {}),
        createdAt: v.createdAt,
      })),
  }
}

/** POST /api/sites/:name/paths/:folder/current: make an earlier version current again. */
export async function rollbackPath(
  deps: Deps,
  user: User,
  name: string,
  folder: string,
  versionId: string
): Promise<SitePath> {
  const { site, path, siteActor } = await requirePath(deps, user, name, folder, 'site.rollback')
  const version = await deps.store.getVersion(pathRef(site, path), versionId)
  if (version?.status !== 'complete') {
    throw notFound(`No version ${versionId} of ${displayPublishPath(folder)} of "${name}"`)
  }
  await makePathCurrent(deps, site, path, versionId, version.title ?? '')
  return toSitePath(deps, site, siteActor, path)
}

/**
 * PATCH /api/sites/:name/paths/:folder: its owners and publishers (`site.owners` /
 * `site.publishers` on the Path: its owners and the site's), and archiving (`site.archive`).
 */
export async function updatePath(
  deps: Deps,
  user: User,
  name: string,
  folder: string,
  patch: { owners?: SiteRoleInput; publishers?: SiteRoleInput; archived?: boolean }
): Promise<SitePath> {
  const actions: Action[] = [
    ...(patch.owners === undefined ? [] : (['site.owners'] as const)),
    ...(patch.publishers === undefined ? [] : (['site.publishers'] as const)),
    ...(patch.archived === undefined ? [] : (['site.archive'] as const)),
  ]
  const { site, path, siteActor } = await requirePath(
    deps,
    user,
    name,
    folder,
    ...(actions.length ? actions : (['site.owners'] as const))
  )
  const base = path.currentVersionId
  if (patch.owners !== undefined || patch.publishers !== undefined) {
    await applyRoles(deps, path, patch)
  }
  if (patch.archived !== undefined) path.archived = patch.archived
  path.updatedAt = deps.clock.now().toISOString()
  await putPathOn(deps, site, path, base)
  await syncPathRoute(deps, site, path)
  await refreshHome(deps, site)
  return toSitePath(deps, site, siteActor, path)
}

/** DELETE /api/sites/:name/paths/:folder: the Path, its versions and files (`site.delete` on it). */
export async function deletePathOf(deps: Deps, user: User, name: string, folder: string) {
  const { site, path } = await requirePath(deps, user, name, folder, 'site.delete')
  await removePath(deps, site, path)
  await refreshHome(deps, site)
}

/** Take a Path off its site: its route key, files and records. */
export async function removePath(deps: Deps, site: SiteRecord, path: PathRecord) {
  await deps.routeTable.delete(pathKvsKey(site.id, path.folder))
  await deps.blobs.deletePrefix(sitePrefix(path.id))
  await deps.store.deletePath(site, path)
}

/** GET /api/sites/:name/versions/:versionId/files?path=: one (complete) version of the Path. */
export async function pathVersionFiles(
  deps: Deps,
  user: User,
  name: string,
  folder: string,
  versionId: string
): Promise<VersionFiles> {
  const { site, path } = await requirePath(deps, user, name, folder, 'version.read')
  const what = `${displayPublishPath(folder)} of "${name}"`
  const version = await deps.store.getVersion(pathRef(site, path), versionId)
  if (version?.status !== 'complete') throw notFound(`No version ${versionId} of ${what}`)
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(path.id, versionId))
  if (!manifest) throw notFound(`Manifest for version ${versionId} of ${what} is gone`)
  const files = manifest.files
    .map(f => ({ path: f.path, size: f.size, contentType: f.contentType }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    versionId,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    generatedIndex:
      manifest.generatedIndex ??
      (await detectGeneratedIndex(deps, path.id, versionId, manifest.files)),
  }
}
