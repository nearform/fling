/**
 * Pull: a version's files, for someone who will change some or all of them and publish again
 * (`GET /api/sites/:name/pull`). Publishing on the pulled
 * version as the base sends only what changed (publication.ts).
 *
 * Who may pull is policy's (`site.pull`): anyone signed in who can see the site, for its current
 * version while it is live and not archived. Any other version, or an archived site's, also needs
 * `version.read` (owners, publishers, admins): viewers never saw those. A refusal is a 404 like a
 * missing site.
 *
 * The bytes never pass through the API (a buffered Lambda response is capped well below a site's
 * size): the API answers with each file's path, size, type and SHA-256, and a short-lived signed GET
 * for its bytes (`Blobs.presignGet`). The version's forms config (forms.ts) comes with them, so
 * the client can write `fling.forms.json` back into the folder.
 *
 * With `path`, the pull is of that Path of the site (paths.ts): its version (the current one
 * unless `versionId` names another), on the same terms with the Path's roles (`pathPolicySite`)
 * for other versions. Its files are the Path's, named within it (`pullable`) and, in the API's
 * answer, by site path (`<path>/…`).
 */
import {
  type ManifestFile,
  PULL_URL_TTL_SECONDS,
  type PullResponse,
  siteObjectKey,
} from '@fling/shared'
import { manifestKey } from './blobs/types.ts'
import { readForms } from './forms.ts'
import { mapLimit } from './lib/concurrency.ts'
import { notFound } from './lib/errors.ts'
import { pathRef } from './paths.ts'
import { can, pathPolicySite } from './policy.ts'
import { requireSiteAs, type StoredManifest } from './sites.ts'
import type { SiteRecord, User } from './store/types.ts'
import type { Deps } from './types.ts'

const PRESIGN_CONCURRENCY = 32

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * The version the user may pull of the site named `name`, or with `path` of that Path (the current
 * one unless `versionId` names another), where its files are stored (`storage`), and its files,
 * sorted by path (a Path's named within it).
 */
export async function pullable(
  deps: Deps,
  user: User,
  name: string,
  opts: { versionId?: string; path?: string } = {}
): Promise<{ site: SiteRecord; storage: string; versionId: string; files: ManifestFile[] }> {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.pull')
  const what = opts.path === undefined ? `"${name}"` : `/${opts.path}/ of "${name}"`
  const path = opts.path === undefined ? null : await deps.store.getPath(site.id, opts.path)
  if (opts.path !== undefined && !path) throw notFound(`${what} is not a Path`)
  const target = path
    ? {
        ref: pathRef(site, path),
        storage: path.id,
        current: path.currentVersionId,
        archived: path.archived || site.archived,
        policy: pathPolicySite(site, path),
      }
    : {
        ref: site,
        storage: site.id,
        current: site.currentVersionId,
        archived: site.archived,
        policy: site,
      }
  const versionId = opts.versionId ?? target.current
  const current = versionId !== null && versionId === target.current && !target.archived
  if (!versionId || (!current && !can(actor, 'version.read', target.policy))) {
    throw notFound(
      opts.versionId ? `No version ${opts.versionId} for ${what}` : `${what} is not live`
    )
  }
  const version = current ? null : await deps.store.getVersion(target.ref, versionId)
  if (!current && version?.status !== 'complete') {
    throw notFound(`No version ${versionId} for ${what}`)
  }
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(target.storage, versionId))
  if (!manifest) throw notFound(`The files of version ${versionId} of ${what} are gone`)
  return { site, storage: target.storage, versionId, files: manifest.files.slice().sort(byPath) }
}

/** GET /api/sites/:name/pull — the files to download, each with a signed URL, and the forms. */
export async function pull(
  deps: Deps,
  user: User,
  name: string,
  opts: { versionId?: string; path?: string } = {}
): Promise<PullResponse> {
  const { storage, versionId, files } = await pullable(deps, user, name, opts)
  const expiresAt = new Date(deps.clock.now().getTime() + PULL_URL_TTL_SECONDS * 1000)
  const forms = await readForms(deps, storage, versionId)
  const prefix = opts.path === undefined ? '' : `${opts.path}/`
  const signed = await mapLimit(files, PRESIGN_CONCURRENCY, async f => ({
    path: `${prefix}${f.path}`,
    size: f.size,
    contentType: f.contentType,
    sha256: f.sha256,
    url: await deps.blobs.presignGet(siteObjectKey(storage, versionId, f.path), {
      expiresIn: PULL_URL_TTL_SECONDS,
    }),
  }))
  return {
    versionId,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    files: signed,
    expiresAt: expiresAt.toISOString(),
    ...(forms ? { forms } : {}),
  }
}
