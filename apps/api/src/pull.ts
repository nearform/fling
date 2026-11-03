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
 */
import {
  isUnderPath,
  type ManifestFile,
  PULL_URL_TTL_SECONDS,
  type PullResponse,
  siteObjectKey,
} from '@fling/shared'
import { manifestKey } from './blobs/types.ts'
import { readForms } from './forms.ts'
import { mapLimit } from './lib/concurrency.ts'
import { notFound } from './lib/errors.ts'
import { can } from './policy.ts'
import { requireSiteAs, type StoredManifest } from './sites.ts'
import type { SiteRecord, User } from './store/types.ts'
import type { Deps } from './types.ts'

const PRESIGN_CONCURRENCY = 32

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * The version of the site named `name` the user may pull (the current one unless `versionId` names
 * another) and its files, sorted by path; with `path`, only those under that folder.
 */
export async function pullable(
  deps: Deps,
  user: User,
  name: string,
  opts: { versionId?: string; path?: string } = {}
): Promise<{ site: SiteRecord; versionId: string; files: ManifestFile[] }> {
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.pull')
  const versionId = opts.versionId ?? site.currentVersionId
  const current = versionId !== null && versionId === site.currentVersionId && !site.archived
  if (!versionId || (!current && !can(actor, 'version.read', site))) {
    throw notFound(
      opts.versionId ? `No version ${opts.versionId} for "${name}"` : `"${name}" is not live`
    )
  }
  const version = current ? null : await deps.store.getVersion(site, versionId)
  if (!current && version?.status !== 'complete') {
    throw notFound(`No version ${versionId} for "${name}"`)
  }
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(site.id, versionId))
  if (!manifest) throw notFound(`The files of version ${versionId} of "${name}" are gone`)
  const { path } = opts
  const files = (
    path === undefined ? manifest.files : manifest.files.filter(f => isUnderPath(f.path, path))
  )
    .slice()
    .sort(byPath)
  return { site, versionId, files }
}

/** GET /api/sites/:name/pull — the files to download, each with a signed URL, and the forms. */
export async function pull(
  deps: Deps,
  user: User,
  name: string,
  opts: { versionId?: string; path?: string } = {}
): Promise<PullResponse> {
  const { site, versionId, files } = await pullable(deps, user, name, opts)
  const expiresAt = new Date(deps.clock.now().getTime() + PULL_URL_TTL_SECONDS * 1000)
  const forms = await readForms(deps, site.id, versionId)
  const signed = await mapLimit(files, PRESIGN_CONCURRENCY, async f => ({
    path: f.path,
    size: f.size,
    contentType: f.contentType,
    sha256: f.sha256,
    url: await deps.blobs.presignGet(siteObjectKey(site.id, versionId, f.path), {
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
