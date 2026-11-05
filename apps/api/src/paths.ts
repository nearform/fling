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
  type KvsPathValue,
  pathKvsKey,
  renderedObjectKey,
  siteObjectKey,
} from '@fling/shared'
import { type PathListing, renderPathsIndex } from '@fling/shared/paths-index'
import { syncRouteTable } from './sites.ts'
import type { PathRecord, SiteRecord, SiteRef } from './store/types.ts'
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
