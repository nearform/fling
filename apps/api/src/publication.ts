/**
 * Publication: the only way a version becomes live, and the server-side half of "Fling never
 * publishes dotfiles, secret files or secrets". The CLI and the local MCP server check the same
 * rules first (that's UX: early, specific messages); this module is the guarantee — it also holds
 * for old CLIs, custom scripts and inline publishes.
 *
 *   stage(raw)              bytes the server never sees (CLI): admit the manifest, record a pending
 *                           version, return upload URLs that only accept the exact bytes named in
 *                           the manifest (sha256 signed in) and expire after UPLOAD_URL_TTL_SECONDS.
 *   publish(versionId)      make a staged version live: every object present at the right size,
 *                           read back and scanned for secrets first. No way to skip the scan.
 *   publishBytes(files)     bytes the server holds (remote MCP): admit, scan exactly these bytes,
 *                           write them and go live in one call.
 *
 * Admission (both paths), in this order: size limits → 413 `too_large`; dotfiles / secret files →
 * 400 `dotfile` / `secret_file`; then the schema → 400 `validation_failed`. A secret in the
 * contents → 422 `secret_detected` (path, line and rule — never the value), and anything staged
 * for that version is deleted.
 *
 * Deploy semantics (versionId = computeVersionId(manifest)): equal to the current version →
 * `unchanged`; a complete version with that id exists → `repointed`; otherwise a pending version
 * is recorded (manifest kept in storage). The first deploy to a name claims it; a name another
 * user owns → 409 `name_taken` with free suggestions. Going live (including unchanged/repointed)
 * unarchives the site; `spa`/`visibility` are applied when the deploy takes effect, omitted → the
 * site's current setting (new sites: non-SPA). `access` (with its audience) is who can open a site
 * that has never been live, checked before the name is claimed; omitted → the instance's default
 * (`initialAccess`). It never changes a site that has been live. When the site first goes live
 * restricted to an audience, the audience hears it was shared with them.
 *
 * Owners and publishers deploy (`site.deploy`). A deploy that would change the site's settings
 * needs what changing them needs (`deployChanges`): `spa` needs `site.settings`, `visibility` and a
 * never-live site's `access` need `site.visibility` (and `site.audience` for `access`); a publisher
 * asking for one gets 400 `owner_only` before anything is stored. The settings a pending version
 * carries are applied when it goes live only as far as whoever makes it live may change them.
 * Unarchiving is the owners' (`site.archive`): a publisher's deploy to an archived site, or making
 * one of its versions live, is 400 `owner_only` (`checkRestore`).
 *
 * Who published (`VersionRecord.publishedBy`): the user who makes a version live. A pending
 * version records whoever staged it, and finalizing records whoever finalized it. A version is
 * content-addressed, so an `unchanged` or `repointed` deploy creates nothing and the version keeps
 * the publisher it was first published by.
 *
 * Path publish (`DeployRequest.path`, publish-path.ts in @fling/shared): replace one folder of the
 * site and keep the rest. The edge serves `sites/<id>/<versionId>/<file>` straight from the route,
 * so every version holds every file: a path publish makes a whole new version, its files those
 * sent (each under `<path>/`, else 400 `outside_path`) plus the current version's files outside
 * the folder. That current version is its **base**.
 *   - `prepare` reads the base's manifest, merges, checks the caps on the merged set, and computes
 *     the version id from it: the unchanged/repointed shortcuts then mean what they always mean
 *     (this exact site is current, or was published before). The stored manifest carries
 *     `layer: {path, base, kept}`; the version records `path` and `base`. Upload URLs are only for
 *     the files sent. At most MAX_KEPT_FILES files are carried forward (413 `too_large`), since
 *     each is a copy in the request that makes the version live.
 *   - Finalizing refuses with 409 `base_changed` once the site's current version is no longer the
 *     base (someone published, or rolled back, meanwhile: going live would undo it). It HEADs and
 *     scans only the files sent, then copies the kept files (`Blobs.copy`). Kept files need no
 *     rescan or HEAD: they are byte-for-byte copies of a version that passed this scan to go live,
 *     and a copy whose source is missing fails rather than leaving a gap.
 *   - Going live saves the site only while its current version is still the base
 *     (`putSite(…, { ifCurrentVersion })`), so of two path publishes racing on the same base one
 *     wins and the other gets 409 `base_changed` (its version goes back to pending). Clients
 *     publish again on top of the new current version. The shortcuts are guarded the same way.
 *   - A site with no current version has nothing to carry forward: the path publish is a plain
 *     publish of those files (the site's root has nothing until something is published there).
 *     There is no base to guard on, and the Table port can't condition on a null field, so two
 *     racing first publishes behave like two plain ones: the last to go live wins.
 *   - The generated index (a root index.html listing the HTML pages, `listHtml`) is a file like
 *     any other: a path publish carries the base's forward as it is, so it doesn't list the pages
 *     under the new folder until the whole site is published again. A folder published with
 *     `listHtml` gets its own `<path>/index.html` listing.
 *   - Rollback needs nothing new: a layered version is complete, so rolling back to the base
 *     removes the folder's new files.
 */
import { createHash } from 'node:crypto'
import {
  type AccessLevel,
  type AudienceInput,
  cacheControlFor,
  type DeployRequest,
  DeployRequestSchema,
  type DeployResponse,
  describeSecretFindings,
  displayPublishPath,
  forbiddenPathReason,
  isScannablePath,
  isUnderPath,
  isValidSiteName,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_KEPT_FILES,
  type ManifestFile,
  NEVER_PUBLISHED_NOTE,
  SECRET_SCAN_MAX_FILE_BYTES,
  type SecretFinding,
  SITE_NAME_MAX,
  type Site,
  scanBytesForSecrets,
  siteObjectKey,
  siteVersionPrefix,
  type Visibility,
} from '@fling/shared'
import { computeVersionId } from '@fling/shared/version-id'
import { guestRefusal } from './auth/middleware.ts'
import { manifestKey } from './blobs/types.ts'
import { inviterOf } from './invitations.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { newId } from './lib/ids.ts'
import { contentTypeFor } from './lib/mime.ts'
import { type Acting, notifyAudienceChange } from './notifications/notify.ts'
import {
  type Action,
  type Actor,
  can,
  canInstance,
  isRestricted,
  type Principal,
  restrictsToAudience,
  userActor,
} from './policy.ts'
import {
  type AccessFields,
  applySettings,
  auditAdmin,
  detectGeneratedIndex,
  initialAccess,
  inviteAdded,
  nameTaken,
  requireSiteAs,
  type StoredManifest,
  save,
  siteActor,
  toSite,
} from './sites.ts'
import type { SiteRecord, User, VersionRecord } from './store/types.ts'
import { ConditionFailed } from './table/types.ts'
import type { Deps } from './types.ts'

/** Upload URLs from stage() live this long; the CLI uploads straight away. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60

const MAX_LISTED = 20
const MAX_MISSING_LISTED = 50
const HEAD_CONCURRENCY = 16
const PRESIGN_CONCURRENCY = 32
const PUT_CONCURRENCY = 16
/** Objects read back in parallel at publish. */
const SCAN_CONCURRENCY = 8
/** Kept files copied in parallel by a path publish. */
const COPY_CONCURRENCY = 16

export type Published = {
  status: 'live' | 'unchanged' | 'repointed'
  versionId: string
  site: Site
  /** this deploy made the site live for the first time: a new site, with its access just set */
  first?: boolean
}

// --- admission ----------------------------------------------------------------------------------

const list = (paths: readonly string[]) =>
  paths.slice(0, MAX_LISTED).join(', ') +
  (paths.length > MAX_LISTED ? ` (+${paths.length - MAX_LISTED} more)` : '')

const tooLarge = (message: string) => new ApiError(413, 'too_large', message)

/**
 * 400 `dotfile` / `secret_file` if any path can never be published. Accepts unvalidated input.
 * Exported for early, per-file checks (chunked MCP uploads); admission always runs it again.
 */
export function assertPublishablePaths(paths: readonly unknown[]): void {
  const dotfiles: string[] = []
  const secretFiles: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string') continue
    const reason = forbiddenPathReason(p)
    if (reason === 'dotfile') dotfiles.push(p)
    else if (reason === 'secret_file') secretFiles.push(p)
  }
  if (secretFiles.length > 0) {
    throw new ApiError(
      400,
      'secret_file',
      `Refusing to publish secret files (keys, certificates, credentials): ${list(secretFiles)}. ${NEVER_PUBLISHED_NOTE} Remove them and deploy again.`,
      { paths: secretFiles }
    )
  }
  if (dotfiles.length > 0) {
    throw new ApiError(
      400,
      'dotfile',
      `Refusing to publish dotfiles: ${list(dotfiles)}. ${NEVER_PUBLISHED_NOTE} Remove them and deploy again.`,
      { paths: dotfiles }
    )
  }
}

/** Size caps are 413s, checked before the schema (whose refinements would make them 400s). */
function assertWithinLimits(files: readonly unknown[]) {
  if (files.length > MAX_FILES) throw tooLarge(`Too many files (max ${MAX_FILES})`)
  let total = 0
  for (const f of files) {
    const { path, size } = (f ?? {}) as { path?: unknown; size?: unknown }
    const bytes = typeof size === 'number' ? size : 0
    if (bytes > MAX_FILE_BYTES) {
      throw tooLarge(`${String(path)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`)
    }
    total += bytes
  }
  if (total > MAX_DEPLOY_BYTES) {
    throw tooLarge(`The site is larger than ${MAX_DEPLOY_BYTES / 1024 / 1024} MB`)
  }
}

/**
 * Limits → path rules → schema, so the specific errors win over the schema's generic ones; then,
 * for a path publish, every file under the path (400 `outside_path`).
 */
function admit(raw: unknown): DeployRequest {
  const files = (raw as { manifest?: { files?: unknown } } | null)?.manifest?.files
  if (Array.isArray(files)) {
    assertWithinLimits(files)
    assertPublishablePaths(files.map(f => (f as { path?: unknown } | null)?.path))
  }
  const req = DeployRequestSchema.parse(raw)
  if (req.path !== undefined) {
    const path = req.path
    const outside = req.manifest.files.filter(f => !isUnderPath(f.path, path)).map(f => f.path)
    if (outside.length > 0) {
      throw new ApiError(
        400,
        'outside_path',
        `Publishing to ${displayPublishPath(path)} takes only files under it: ${list(outside)}`,
        { paths: outside }
      )
    }
  }
  return req
}

/** 409 `base_changed`: the site moved on while a path publish was on its way. */
const baseChanged = (name: string, path: string) =>
  conflict(
    `"${name}" changed while publishing to ${displayPublishPath(path)}: publish it again`,
    'base_changed'
  )

/** Save the site; with a base, only while that is still its current version. */
async function saveOnBase(
  deps: Deps,
  site: SiteRecord,
  layer: { path: string; base: string } | null
) {
  if (!layer) return save(deps, site)
  try {
    await save(deps, site, undefined, { ifCurrentVersion: layer.base })
  } catch (err) {
    if (err instanceof ConditionFailed) throw baseChanged(site.name, layer.path)
    throw err
  }
}

/** Copy a path publish's kept files from its base into the new version. */
async function copyKept(
  deps: Deps,
  siteId: string,
  versionId: string,
  layer: { base: string; kept: readonly string[] }
) {
  await mapLimit(layer.kept, COPY_CONCURRENCY, path =>
    deps.blobs.copy(siteObjectKey(siteId, layer.base, path), siteObjectKey(siteId, versionId, path))
  )
}

// --- secret scanning ----------------------------------------------------------------------------

/** 422 `secret_detected`: which file and line, and what kind of secret — never the value. */
function secretDetected(findings: readonly SecretFinding[]): ApiError {
  return new ApiError(
    422,
    'secret_detected',
    `Not published: found secrets in ${new Set(findings.map(f => f.path)).size} file(s) — ` +
      `${describeSecretFindings(findings, MAX_LISTED).join('; ')}. ${NEVER_PUBLISHED_NOTE} ` +
      'Remove the secret (and rotate it if it was ever shared), then deploy again.',
    { findings: findings.map(({ path, line, rule }) => ({ path, line, rule })) }
  )
}

/**
 * Read back a staged version's objects and scan them: every text-like file up to
 * SECRET_SCAN_MAX_FILE_BYTES (= the per-file limit), SCAN_CONCURRENCY at a time.
 */
async function scanStoredVersion(
  deps: Deps,
  siteId: string,
  versionId: string,
  files: readonly ManifestFile[]
): Promise<SecretFinding[]> {
  const toScan = files.filter(
    f => isScannablePath(f.path) && f.size > 0 && f.size <= SECRET_SCAN_MAX_FILE_BYTES
  )
  const results = await mapLimit(toScan, SCAN_CONCURRENCY, async f => {
    const bytes = await deps.blobs.get(siteObjectKey(siteId, versionId, f.path))
    return bytes ? scanBytesForSecrets(bytes, f.path) : []
  })
  return results.flat()
}

// --- shared steps -------------------------------------------------------------------------------

type Layer = NonNullable<StoredManifest['layer']>

type Prepared =
  | { kind: 'done'; result: Published & { status: 'unchanged' | 'repointed' } }
  | {
      kind: 'pending'
      site: SiteRecord
      actor: Actor
      version: VersionRecord
      /** every file of the version */
      files: ManifestFile[]
      /** the files this deploy sends (all of them, unless it is a path publish with a base) */
      sent: ManifestFile[]
      layer: Layer | null
    }

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every(x => b.includes(x))

/**
 * What changing the site's settings as a deploy asks would need: `spa` → `site.settings`,
 * `visibility` → `site.visibility`, and `access` (never-live sites only: the fields it sets) →
 * `site.visibility` and `site.audience`. Settings that match the site's need nothing.
 */
function deployChanges(
  site: SiteRecord,
  req: { spa?: boolean; visibility?: Visibility },
  access: AccessFields | null
): Action[] {
  const actions = new Set<Action>()
  if (req.spa !== undefined && req.spa !== site.spa) actions.add('site.settings')
  if (req.visibility !== undefined && req.visibility !== site.visibility) {
    actions.add('site.visibility')
  }
  if (
    access &&
    (access.visibility !== site.visibility ||
      restrictsToAudience(access) !== restrictsToAudience(site) ||
      !sameSet(access.audience.emails, site.audience.emails) ||
      !sameSet(access.audience.groups, site.audience.groups))
  ) {
    actions.add('site.visibility')
    actions.add('site.audience')
  }
  return [...actions]
}

/**
 * Refuse (400 `owner_only`) a deploy that changes settings the actor may not change, and audit
 * those an admin changes only because they are one.
 */
async function checkDeployChanges(deps: Deps, actor: Actor, site: SiteRecord, actions: Action[]) {
  if (!actions.every(a => can(actor, a, site))) {
    throw new ApiError(
      400,
      'owner_only',
      `Only an owner of "${site.name}" changes its access or settings: deploy without them, or ask an owner`
    )
  }
  for (const action of actions) await auditAdmin(deps, actor, site, action)
}

/**
 * Making a version of an archived site live restores it, which is the owners' call (`site.archive`):
 * a publisher gets 400 `owner_only`, and an admin restoring it only as one is audited.
 */
async function checkRestore(deps: Deps, actor: Actor, site: SiteRecord) {
  if (!site.archived) return
  if (!can(actor, 'site.archive', site)) {
    throw new ApiError(
      400,
      'owner_only',
      `"${site.name}" is archived: only its owners restore it. Ask an owner to unarchive it first`
    )
  }
  await auditAdmin(deps, actor, site, 'site.archive')
}

/** The settings a version carries that `actor` may apply to the site as it goes live. */
function settingsFor(actor: Actor, site: SiteRecord, version: VersionRecord) {
  return {
    ...(can(actor, 'site.settings', site) ? { spa: version.spa } : {}),
    ...(can(actor, 'site.visibility', site) ? { visibility: version.visibility } : {}),
  }
}

/**
 * A path publish on a site with a current version: the base's files outside the path, merged with
 * those sent and checked against the caps. Null for any other deploy.
 */
async function layerFor(
  deps: Deps,
  site: SiteRecord | null,
  req: DeployRequest
): Promise<{ layer: Layer; files: ManifestFile[] } | null> {
  const { path } = req
  const base = site?.currentVersionId
  if (path === undefined || !site || !base) return null
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(site.id, base))
  if (!manifest) {
    throw conflict(
      `The files of "${site.name}"'s current version are missing: publish the whole site`,
      'base_missing'
    )
  }
  const kept = manifest.files.filter(f => !isUnderPath(f.path, path))
  if (kept.length > MAX_KEPT_FILES) {
    throw tooLarge(
      `Publishing to ${displayPublishPath(path)} carries the rest of "${site.name}" forward, at most ${MAX_KEPT_FILES} files; it has ${kept.length} outside that folder. Publish the whole site instead`
    )
  }
  const files = [...kept, ...req.manifest.files]
  assertWithinLimits(files)
  return { layer: { path, base, kept: kept.map(f => f.path) }, files }
}

/** Name checks, the unchanged / repointed shortcuts, else a pending version (manifest stored). */
async function prepare(
  deps: Deps,
  user: User,
  name: string,
  req: DeployRequest,
  principal: Principal
): Promise<Prepared> {
  if (!isValidSiteName(name)) {
    throw badRequest(
      `Site names are 1-${SITE_NAME_MAX} chars of a-z, 0-9 and single hyphens, starting and ending alphanumeric, and not reserved`,
      'invalid_name'
    )
  }
  const { store, blobs, clock } = deps
  const existing = await store.findSite(name)
  const actor = existing ? await siteActor(deps, user, existing) : userActor(user)
  if (existing && !can(actor, 'site.deploy', existing)) {
    throw await nameTaken(deps, user, name)
  }
  if (!existing) {
    const claim = await store.getNameClaim(name)
    if (claim && claim.email !== user.email) throw await nameTaken(deps, user, name)
    if (!canInstance(principal, 'account.site.create')) throw guestRefusal()
  }
  if (req.access !== undefined && req.visibility !== undefined) {
    throw badRequest('Pass `access` or `visibility`, not both')
  }
  // Who can open a site that has never been live. One that has keeps its access: PATCH changes it.
  const neverLive = !existing || existing.currentVersionId === null
  const inviter = inviterOf(principal)
  const access = neverLive ? await initialAccess(deps, req, inviter) : null
  if (existing) {
    const asked = req.access === undefined ? null : access
    await checkDeployChanges(deps, actor, existing, deployChanges(existing, req, asked))
    await checkRestore(deps, actor, existing)
  }
  if (existing && access && req.access !== undefined) {
    const before = existing.audience
    Object.assign(existing, access)
    await save(deps, existing)
    await inviteAdded(deps, inviter, existing, before)
  }

  const layered = await layerFor(deps, existing, req)
  const layer = layered?.layer ?? null
  const files = layered?.files ?? req.manifest.files
  const versionId = computeVersionId(files)

  if (existing && existing.currentVersionId === versionId) {
    applySettings(existing, req)
    existing.archived = false
    await saveOnBase(deps, existing, layer)
    return {
      kind: 'done',
      result: { status: 'unchanged', versionId, site: toSite(deps, actor, existing) },
    }
  }

  if (existing) {
    const version = await store.getVersion(existing, versionId)
    if (version?.status === 'complete') {
      existing.currentVersionId = versionId
      existing.archived = false
      applySettings(existing, req)
      await saveOnBase(deps, existing, layer)
      return {
        kind: 'done',
        result: { status: 'repointed', versionId, site: toSite(deps, actor, existing) },
      }
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
      ...(access as AccessFields),
      owners: { emails: [user.email], groups: [] },
      publishers: { emails: [], groups: [] },
      spa: false,
      archived: false,
      currentVersionId: null,
      shareToken: null,
      createdAt: now,
      updatedAt: now,
    }))
  // Lost a race for the name to another user.
  if (!site) throw await nameTaken(deps, user, name)
  if (!existing) await inviteAdded(deps, inviter, site, { emails: [], groups: [] })

  const version: VersionRecord = {
    siteId: site.id,
    id: versionId,
    status: 'pending',
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    spa: req.spa,
    visibility: req.visibility,
    publishedBy: user.email,
    ...(req.path !== undefined ? { path: req.path } : {}),
    ...(layer ? { base: layer.base } : {}),
    createdAt: now,
  }
  await blobs.putJson(manifestKey(site.id, versionId), {
    files,
    ...(layer ? { layer } : {}),
  } satisfies StoredManifest)
  await store.putVersion(site, version)
  return { kind: 'pending', site, actor, version, files, sent: req.manifest.files, layer }
}

/**
 * Pending → complete → current. Only reached once the version's bytes have been scanned. With a
 * `layer`, the site is saved only while its base is current; otherwise the version goes back to
 * pending and this is 409 `base_changed`.
 */
async function goLive(
  deps: Deps,
  user: User,
  actor: Actor,
  site: SiteRecord,
  version: VersionRecord,
  files: readonly ManifestFile[],
  acting: Acting,
  layer: Layer | null = null
): Promise<Published> {
  const first = site.currentVersionId === null
  if (version.status === 'pending') {
    const generatedIndex = await detectGeneratedIndex(deps, site.id, version.id, files)
    await deps.blobs.putJson(manifestKey(site.id, version.id), {
      files: [...files],
      generatedIndex,
      ...(layer ? { layer } : {}),
    } satisfies StoredManifest)
    await deps.store.putVersion(site, { ...version, status: 'complete', publishedBy: user.email })
  }
  site.currentVersionId = version.id
  site.archived = false
  applySettings(site, settingsFor(actor, site, version))
  try {
    await saveOnBase(deps, site, layer)
  } catch (err) {
    if (version.status === 'pending') await deps.store.putVersion(site, version)
    throw err
  }
  if (first && isRestricted(site)) {
    await notifyAudienceChange(deps, user.email, site, { emails: [], groups: [] }, acting)
  }
  return {
    status: 'live',
    versionId: version.id,
    site: toSite(deps, actor, site),
    ...(first ? { first } : {}),
  }
}

/** S3's `x-amz-checksum-sha256` wants base64; manifests carry hex. */
const _sha256Base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64')

// --- the interface ------------------------------------------------------------------------------

/** POST /api/sites/:name/deploys — `raw` is the request body as sent. */
export async function stage(
  deps: Deps,
  user: User,
  name: string,
  raw: unknown,
  principal: Principal
): Promise<DeployResponse> {
  const prepared = await prepare(deps, user, name, admit(raw), principal)
  if (prepared.kind === 'done') return prepared.result
  const { site, version, sent } = prepared
  const uploads = await mapLimit(sent, PRESIGN_CONCURRENCY, async file => {
    const signed = await deps.blobs.presignPut(siteObjectKey(site.id, version.id, file.path), {
      contentType: file.contentType,
      cacheControl: cacheControlFor(file.path),
      sha256: file.sha256,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    })
    return { path: file.path, url: signed.url, headers: signed.headers }
  })
  return { status: 'upload', versionId: version.id, uploads }
}

/** POST /api/sites/:name/deploys/:versionId/finalize — idempotent once live. */
export async function publish(
  deps: Deps,
  user: User,
  name: string,
  versionId: string,
  acting: Acting = {}
): Promise<Published> {
  const { store, blobs } = deps
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.deploy')
  const version = await store.getVersion(site, versionId)
  if (!version) throw notFound(`No deploy ${versionId} for "${name}"`)
  await checkRestore(deps, actor, site)
  if (version.status === 'complete') {
    // Finalizing again: a path publish still goes live only on top of its base.
    if (!version.base || site.currentVersionId === version.id) {
      return goLive(deps, user, actor, site, version, [], acting)
    }
    const layer = { path: version.path ?? '', base: version.base, kept: [] }
    if (site.currentVersionId !== version.base) throw baseChanged(name, layer.path)
    return goLive(deps, user, actor, site, version, [], acting, layer)
  }

  const manifest = await blobs.getJson<StoredManifest>(manifestKey(site.id, versionId))
  if (!manifest) throw notFound(`Manifest for deploy ${versionId} is gone; deploy again`)
  const layer = manifest.layer ?? null
  if (layer && site.currentVersionId !== layer.base) throw baseChanged(name, layer.path)
  const kept = new Set(layer?.kept)
  const sent = manifest.files.filter(f => !kept.has(f.path))
  const checks = await mapLimit(sent, HEAD_CONCURRENCY, async file => {
    const head = await blobs.head(siteObjectKey(site.id, versionId, file.path))
    return head && head.size === file.size ? null : file.path
  })
  const missing = checks.filter((p): p is string => p !== null)
  if (missing.length > 0) {
    const listed = missing.slice(0, MAX_MISSING_LISTED)
    const more = missing.length > listed.length ? ` (+${missing.length - listed.length} more)` : ''
    throw conflict(
      `${missing.length} file(s) missing or the wrong size: ${listed.join(', ')}${more}`,
      'missing_uploads',
      { missing }
    )
  }
  // The server never saw these bytes: read them back and scan them before the version can go
  // live. (Upload URLs only accept the manifest's bytes, so what was scanned is what is served.)
  // A secret → delete what was uploaded (the version stays pending with no manifest; deploying
  // again starts over) and refuse.
  const findings = await scanStoredVersion(deps, site.id, versionId, sent)
  if (findings.length > 0) {
    await blobs.deletePrefix(siteVersionPrefix(site.id, versionId))
    await blobs.delete(manifestKey(site.id, versionId))
    throw secretDetected(findings)
  }
  if (layer) await copyKept(deps, site.id, versionId, layer)
  return goLive(deps, user, actor, site, version, manifest.files, acting, layer)
}

/**
 * Remote MCP: publish files the server holds. Paths must already be site-relative (see
 * mcp/publish.ts normalizePath), and with `path` already under it; content types come from the
 * extension.
 */
export async function publishBytes(
  deps: Deps,
  user: User,
  name: string,
  input: readonly { path: string; bytes: Uint8Array }[],
  opts: {
    /** who is publishing: a new site needs `account.site.create` */
    principal: Principal
    /** a path publish: replace only this folder (publish-path.ts) */
    path?: string
    spa?: boolean
    visibility?: Visibility
    access?: AccessLevel
    audience?: AudienceInput
  }
): Promise<Published> {
  const bytesByPath = new Map(input.map(f => [f.path, f.bytes]))
  const files: ManifestFile[] = input.map(({ path, bytes }) => ({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    contentType: contentTypeFor(path),
  }))
  const req = admit({
    manifest: { files },
    path: opts.path,
    spa: opts.spa,
    visibility: opts.visibility,
    access: opts.access,
    audience: opts.audience,
  })
  // Scan exactly the bytes we are about to write, before anything is stored.
  const findings = input.flatMap(f => scanBytesForSecrets(f.bytes, f.path))
  if (findings.length > 0) throw secretDetected(findings)

  const prepared = await prepare(deps, user, name, req, opts.principal)
  if (prepared.kind === 'done') return prepared.result
  const { site, actor, version, layer } = prepared
  await mapLimit(prepared.sent, PUT_CONCURRENCY, async f => {
    await deps.blobs.put(
      siteObjectKey(site.id, version.id, f.path),
      bytesByPath.get(f.path) as Uint8Array,
      { contentType: f.contentType, cacheControl: cacheControlFor(f.path) }
    )
  })
  if (layer) await copyKept(deps, site.id, version.id, layer)
  return goLive(deps, user, actor, site, version, prepared.files, {}, layer)
}
