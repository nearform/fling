/**
 * Publication: the only way a version becomes live, and the server-side half of "Fling never
 * publishes dotfiles, secret files or secrets". The CLI and the local MCP server check the same
 * rules first (that's UX: early, specific messages); this module is the guarantee — it also holds
 * for old CLIs, custom scripts and inline publishes.
 *
 *   stage(raw)              bytes the server never sees (CLI): admit the manifest, record a pending
 *                           version, return upload URLs that only accept the exact bytes named in
 *                           the manifest (a digest signed in) and expire after UPLOAD_URL_TTL_SECONDS.
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
 * Paths (paths.ts): a deploy with `path` (one top-level folder) publishes that folder's Path, its
 * files taken out of `<path>/` (400 `outside_path` for any that aren't under it), and makes the
 * Path on first use. It is a publish like a site's, against the Path's own versions: admission,
 * staging, the scan and going live are the same; the site's version and its other Paths are
 * untouched. A site whose first publish is a Path gets a default home page that lists its Paths.
 * Making a Path is `site.deploy`; publishing to one is `site.deploy` on `pathPolicySite`, so a
 * site publisher can't replace someone else's Path (403 `path_not_yours`). Going live writes the
 * Path only while its current version is still the one the publish read (`putPath(…, {
 * ifCurrentVersion })`), so of two publishes racing on one Path one wins and the other gets 409
 * `base_changed`; publishes to different Paths never wait on each other. A staged Path version is
 * found again at finalize by `notePathDeploy`, since finalize names only the site.
 *
 * Publish on a base (`DeployRequest.base`, after a pull: pull.ts): the edge serves
 * `<storage>/<versionId>/<file>` straight from the route, so every version holds every file. A
 * deploy can still send only part of a site, or of a Path (with `path`), and have the server carry
 * the rest forward from the version the client pulled, by copying (`Blobs.copy`). That version
 * must still be current (409 `base_changed` otherwise, also with no current version). Without
 * `partial` the manifest is the whole new version; with `partial: true` it holds only what changed
 * or is new, `remove` lists the base's files to leave out, and the base's other files are kept. A
 * file sent that the base has byte for byte (same path and SHA-256) is kept rather than uploaded
 * again. At most MAX_KEPT_FILES files are kept, since each is a copy in the request that makes the
 * version live: over it, files the client did not send are a 413 `too_large`, and files it sent
 * are uploaded instead.
 *   - `prepare` reads the base's manifest, merges, checks the caps on the merged set, and computes
 *     the version id from it: the unchanged/repointed shortcuts then mean what they always mean
 *     (this exact site or Path is current, or was published before). The stored manifest carries
 *     `layer: {base, kept}`; the version records `base`. Upload URLs are only for the files not
 *     kept.
 *   - Finalizing refuses with 409 `base_changed` once the base is no longer current (someone
 *     published, or rolled back, meanwhile: going live would undo it). It HEADs and scans only
 *     the files uploaded, then copies the kept files. Kept files need no rescan or HEAD: they are
 *     byte-for-byte copies of a version that passed this scan to go live, and a copy whose source
 *     is missing fails rather than leaving a gap.
 *   - Going live saves the site (or the Path) only while its current version is still the base,
 *     so of two publishes racing on the same base one wins and the other gets 409
 *     `base_changed` (its version goes back to pending). The client pulls again, as only its user
 *     knows how to merge their changes. The shortcuts are guarded the same way.
 *   - Rollback needs nothing new: a version on a base is complete, so rolling back to the base
 *     undoes it.
 *
 * Site servers (servers/index.ts): a version whose files include `_fling/server.mjs` has a server,
 * run for `/api/*`. Admission checks it from the manifest (`admitServer`: who may publish one, its
 * size, a Path at `api`, the instance's cap, a public site's confirmation; a Path publish carrying
 * `_fling/` is 400 `server_on_path`), and the version records the server mark (`server`: the
 * deploy's `fling.json`). A publish on a base that sends no `fling.json` and keeps the base's
 * `_fling/server.mjs` (same SHA-256) keeps the base version's mark (`inheritedServer`): the file is
 * a build input, so a pulled folder may not have it; one sent is the version's. Going live reads the bundle back (`checkBundle`: 400
 * `server_not_bundled`) and starts the server (`startServer`: `secrets_missing`, the start probe,
 * 422 `server_failed_to_start`) before the version is complete and the route changes; a repointed
 * version starts it the same way. A pending version refused only for `secrets_missing` waits for
 * them (`SiteServerState.awaiting`, until another version is staged or goes live): setting the last
 * one publishes it, and if its server then fails to start, each later secret set or removed tries
 * again (servers/api.ts).
 *
 * Forms (forms.ts): a deploy's `forms` (the folder's `fling.forms.json`) is the version's forms
 * config, a blob beside its manifest written when the deploy is made (`formsForDeploy`). Omitted,
 * a publish on a base keeps the base's and any other new version has none; `null` removes them. A
 * version is named by its files, so an `unchanged` or `repointed` deploy that sends `forms` (or is
 * on a base) sets that version's config. A Path's version keeps its own, beside its manifest. The
 * config is scanned for secrets like a file sent.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  type AccessLevel,
  type AudienceInput,
  cacheControlFor,
  type DeployRequest,
  DeployRequestSchema,
  type DeployResponse,
  describeSecretFindings,
  displayPublishPath,
  FORMS_FILE,
  type FormsConfig,
  forbiddenPathReason,
  isScannablePath,
  isUnderPath,
  isValidSiteName,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_KEPT_FILES,
  MAX_PATHS_PER_SITE,
  type ManifestFile,
  NEVER_PUBLISHED_NOTE,
  type PublishHint,
  SECRET_SCAN_MAX_FILE_BYTES,
  SERVER_BUNDLE,
  type SecretFinding,
  type ServerConfig,
  SITE_NAME_MAX,
  type Site,
  scanBytesForSecrets,
  siteObjectKey,
  siteVersionPrefix,
  type Visibility,
} from '@fling/shared'
import { pathsTemplate } from '@fling/shared/paths-templates'
import { computeVersionId } from '@fling/shared/version-id'
import { guestRefusal } from './auth/middleware.ts'
import {
  manifestKey,
  stagedObjectKey,
  stagedPrefix,
  UPLOAD_URL_TTL_SECONDS,
} from './blobs/types.ts'
import { formsForDeploy, writeForms } from './forms.ts'
import { inviterOf } from './invitations.ts'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { newId } from './lib/ids.ts'
import { contentTypeFor } from './lib/mime.ts'
import {
  PENDING_TTL_MS,
  queueMaintenance,
  reviveVersion,
  unqueueStaleCheck,
} from './maintenance.ts'
import { type Acting, notifyAudienceChange } from './notifications/notify.ts'
import {
  ensureRoomForLivePath,
  isLivePath,
  makePathCurrent,
  pathRef,
  refreshHome,
} from './paths.ts'
import {
  type Action,
  type Actor,
  can,
  canInstance,
  isRestricted,
  type Principal,
  pathPolicySite,
  restrictsToAudience,
  userActor,
} from './policy.ts'
import { renderVersion } from './rendering.ts'
import {
  admitServer,
  applyServer,
  checkBundle,
  noteLive,
  principalOfUser,
  SERVER_PATH_FOLDER,
  serverVersion,
  startServer,
} from './servers/index.ts'
import {
  type AccessFields,
  actorOn,
  applySettings,
  auditAdmin,
  awaitsSecretsLive,
  changeSite,
  detectGeneratedIndex,
  initialAccess,
  inviteAdded,
  nameTaken,
  requireSiteAs,
  type StoredManifest,
  siteActor,
  toSite,
  writeSite,
} from './sites.ts'
import type { PathRecord, ServerMark, SiteRecord, User, VersionRecord } from './store/types.ts'
import { ConditionFailed } from './table/types.ts'
import type { Deps } from './types.ts'
import { countPush } from './views.ts'

export { UPLOAD_URL_TTL_SECONDS } from './blobs/types.ts'

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
  /** for the publisher to act on (PublishHintSchema) */
  hints?: PublishHint[]
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
 * Limits → path rules → schema, so the specific errors win over the schema's generic ones; then no
 * file both sent and removed, and for a path publish every file under the path (400
 * `outside_path`).
 */
function admit(raw: unknown): DeployRequest {
  const files = (raw as { manifest?: { files?: unknown } } | null)?.manifest?.files
  if (Array.isArray(files)) {
    assertWithinLimits(files)
    assertPublishablePaths(files.map(f => (f as { path?: unknown } | null)?.path))
  }
  const req = DeployRequestSchema.parse(raw)
  if (req.remove?.length) {
    const removed = new Set(req.remove)
    const both = req.manifest.files.filter(f => removed.has(f.path)).map(f => f.path)
    if (both.length > 0) {
      throw badRequest(`Files both sent and removed: ${list(both)}`, 'validation_failed')
    }
  }
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
  if (req.forms) {
    const findings = scanBytesForSecrets(
      new TextEncoder().encode(JSON.stringify(req.forms, null, 2)),
      FORMS_FILE
    )
    if (findings.length > 0) throw secretDetected(findings)
  }
  return req
}

/**
 * 409 `base_changed`: the site (or the Path, `what`) is no longer at the base a publish on a base
 * builds on, and publishing it would undo what was published since.
 */
const baseChanged = (what: string, base: string) =>
  conflict(
    `${what} has changed since version ${base}, the one these changes are based on: pull it again and redo them, or publish without a base to replace what is there`,
    'base_changed',
    { base }
  )

/**
 * Make a deploy's `change` to the site and save it; with a base, only while that is still its
 * current version (409 `base_changed`). When the site was saved since this deploy read it, the
 * change is made to the newer copy only as far as the deployer still may: they still deploy to it
 * (404 otherwise), and restore it if it is archived now (`checkRestore`), with `recheck` for what
 * else the change needs. So a deploy in flight never undoes an owner's or admin's change made
 * meanwhile, nor brings back an archived site for a publisher or a deleted one for anyone.
 * Returns the actor as resolved against the site saved.
 */
async function saveOnBase(
  deps: Deps,
  actor: Actor,
  site: SiteRecord,
  layer: { base: string } | null,
  change: (site: SiteRecord, actor: Actor) => void,
  recheck?: (site: SiteRecord, actor: Actor) => Promise<void>
): Promise<Actor> {
  try {
    return await changeSite(
      deps,
      actor,
      site,
      ['site.deploy'],
      (s, a) => {
        if (layer && s.currentVersionId !== layer.base) throw new ConditionFailed()
        change(s, a)
        return true
      },
      {
        ...(layer ? { ifCurrentVersion: layer.base } : {}),
        recheck: async (s, a) => {
          await checkRestore(deps, a, s)
          await recheck?.(s, a)
        },
      }
    )
  } catch (err) {
    if (err instanceof ConditionFailed && layer) throw baseChanged(`"${site.name}"`, layer.base)
    throw err
  }
}

/** Copy a publish on a base's kept files from its base into the new version. */
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
 * SECRET_SCAN_MAX_FILE_BYTES (= the per-file limit), SCAN_CONCURRENCY at a time. With `verify` (a
 * store whose uploads are bound only to an MD5), every file is read and its SHA-256 checked too;
 * the paths whose bytes are not the manifest's are `mismatched`.
 */
async function scanStoredVersion(
  deps: Deps,
  keyOf: (f: ManifestFile) => string,
  files: readonly ManifestFile[],
  verify = false
): Promise<{ findings: SecretFinding[]; mismatched: string[] }> {
  const scannable = (f: ManifestFile) =>
    isScannablePath(f.path) && f.size > 0 && f.size <= SECRET_SCAN_MAX_FILE_BYTES
  const toRead = verify ? files : files.filter(scannable)
  const results = await mapLimit(toRead, SCAN_CONCURRENCY, async f => {
    const bytes = await deps.blobs.get(keyOf(f))
    if (!bytes) return { findings: [], mismatched: verify ? [f.path] : [] }
    const wrong = verify && createHash('sha256').update(bytes).digest('hex') !== f.sha256
    return {
      findings: scannable(f) ? scanBytesForSecrets(bytes, f.path) : [],
      mismatched: wrong ? [f.path] : [],
    }
  })
  return {
    findings: results.flatMap(r => r.findings),
    mismatched: results.flatMap(r => r.mismatched),
  }
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
      /** the files to upload: all of them, but for those a layered publish keeps */
      sent: ManifestFile[]
      layer: Layer | null
      /** where the version's files go: the site's id, or its Path's storage id */
      storage: string
      /** a publish to a Path: the Path, and each stored file's path as the client named it */
      path?: { record: PathRecord; folder: string }
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
 * A publish on `base` (see the header) of the site or a Path (`target`: where its versions are
 * stored, its current version, and how messages name it). The version's files (the base's merged
 * with those sent, checked against the caps) and its layer: the base, and the files kept (copied
 * from it rather than uploaded). Null without a base; 409 `base_changed` when it is not current.
 */
async function layerOn(
  deps: Deps,
  target: { storage: string; current: string | null; what: string },
  req: Pick<DeployRequest, 'base' | 'partial' | 'remove'> & { files: ManifestFile[] }
): Promise<{ layer: Layer; files: ManifestFile[]; baseBundle?: string } | null> {
  const { base } = req
  if (!base) return null
  if (target.current !== base) throw baseChanged(target.what, base)
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(target.storage, base))
  if (!manifest) {
    throw conflict(
      `The files of ${target.what}'s current version are missing: publish all of it`,
      'base_missing'
    )
  }
  const sent = new Set(req.files.map(f => f.path))
  const removed = new Set(req.remove)
  // The base's files the version keeps without the client sending them.
  const carried = req.partial
    ? manifest.files.filter(f => !sent.has(f.path) && !removed.has(f.path))
    : []
  if (carried.length > MAX_KEPT_FILES) {
    throw tooLarge(
      `Publishing part of ${target.what} carries the rest forward, at most ${MAX_KEPT_FILES} files; this would carry ${carried.length}. Publish all of it instead`
    )
  }
  const files = [...carried, ...req.files]
  assertWithinLimits(files)
  // Files sent that the base has byte for byte are copied too, as far as the cap allows.
  const hashes = new Map(manifest.files.map(f => [f.path, f.sha256]))
  const kept = carried.map(f => f.path)
  for (const f of req.files) {
    if (kept.length >= MAX_KEPT_FILES) break
    if (hashes.get(f.path) === f.sha256) kept.push(f.path)
  }
  const baseBundle = hashes.get(SERVER_BUNDLE)
  return { layer: { base, kept }, files, ...(baseBundle ? { baseBundle } : {}) }
}

/**
 * The server config a publish on a base carries over (see the header): the base version's, when
 * the deploy sends none and its `_fling/server.mjs` is the base's byte for byte. `fling.json` is a
 * build input, never published, so a pulled folder or a fling_read_files agent may not have it.
 */
async function inheritedServer(
  deps: Deps,
  site: SiteRecord | null,
  layered: { layer: Layer; files: ManifestFile[]; baseBundle?: string } | null,
  sent: ServerConfig | undefined
): Promise<ServerConfig | undefined> {
  if (sent || !site || !layered?.baseBundle) return sent
  const bundle = layered.files.find(f => f.path === SERVER_BUNDLE)
  if (bundle?.sha256 !== layered.baseBundle) return undefined
  const mark = (await deps.store.getVersion(site, layered.layer.base))?.server
  if (!mark) return undefined
  return { secrets: mark.secrets, ...(mark.health ? { health: mark.health } : {}) }
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
  const asked = req.access === undefined ? null : access
  // What this deploy's changes need, asked again of a newer copy of the site (`saveOnBase`).
  const recheck = (s: SiteRecord, a: Actor) =>
    checkDeployChanges(deps, a, s, deployChanges(s, req, asked))
  if (existing) {
    await recheck(existing, actor)
    await checkRestore(deps, actor, existing)
  }
  // On a base, the server is admitted on the merged files: a partial publish carries its bundle.
  const layered =
    req.path === undefined
      ? await layerOn(
          deps,
          {
            storage: existing?.id ?? '',
            current: existing?.currentVersionId ?? null,
            what: `"${name}"`,
          },
          { ...req, files: req.manifest.files }
        )
      : null
  const server = await inheritedServer(deps, existing, layered, req.server)
  const mark = await admitServer(deps, principal, {
    name,
    site: existing,
    files: layered?.files ?? req.manifest.files,
    ...(req.path === undefined ? {} : { path: req.path }),
    ...(server ? { server } : {}),
    visibility: req.visibility ?? access?.visibility ?? existing?.visibility ?? 'private',
    ...(req.confirmPublicServer ? { confirmPublicServer: true } : {}),
  })
  if (existing && access && req.access !== undefined) {
    let before = existing.audience
    await changeSite(
      deps,
      actor,
      existing,
      ['site.deploy'],
      s => {
        before = s.audience
        Object.assign(s, access)
        return true
      },
      { recheck }
    )
    await inviteAdded(deps, inviter, existing, before)
  }

  if (req.path !== undefined) {
    if (req.base !== undefined && !existing) throw baseChanged(`"${name}"`, req.base)
    const site = existing ?? (await createSiteFor(deps, user, name, access, inviter))
    return preparePath(deps, user, actor, site, req.path, req, {})
  }

  const layer = layered?.layer ?? null
  const files = layered?.files ?? req.manifest.files
  const versionId = computeVersionId(files)
  const forms = existing
    ? await formsForDeploy(deps, existing.id, req, layer?.base ?? null)
    : req.forms

  if (existing && existing.currentVersionId === versionId) {
    if (forms !== undefined) await writeForms(deps, existing.id, versionId, forms)
    const as = await saveOnBase(
      deps,
      actor,
      existing,
      layer,
      s => {
        applySettings(s, req)
        s.archived = false
      },
      recheck
    )
    return {
      kind: 'done',
      result: { status: 'unchanged', versionId, site: toSite(deps, as, existing) },
    }
  }

  if (existing) {
    const version = await reviveVersion(deps, existing, await store.getVersion(existing, versionId))
    if (version?.status === 'sweeping') {
      throw conflict(
        `This version of "${name}" is being deleted: publish again in a minute`,
        'retry_later'
      )
    }
    if (version?.status === 'complete') {
      if (forms !== undefined) await writeForms(deps, existing.id, versionId, forms)
      const live = await withMark(deps, existing, version, mark)
      const target = await startServer(deps, principal, existing, live)
      const as = await saveOnBase(
        deps,
        actor,
        existing,
        layer,
        s => {
          s.currentVersionId = versionId
          s.archived = false
          applySettings(s, req)
          applyServer(s, live, target)
        },
        recheck
      )
      await noteLive(deps, user.email, existing, live)
      await countPush(deps, existing.id)
      await queueMaintenance(deps, existing)
      return {
        kind: 'done',
        result: { status: 'repointed', versionId, site: toSite(deps, as, existing) },
      }
    }
  }

  const now = clock.now().toISOString()
  const site = existing ?? (await createSiteFor(deps, user, name, access, inviter))

  const version: VersionRecord = {
    siteId: site.id,
    id: versionId,
    status: 'pending',
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    spa: req.spa,
    visibility: req.visibility,
    publishedBy: user.email,
    ...(layer ? { base: layer.base } : {}),
    ...(mark ? { server: mark } : {}),
    createdAt: now,
  }
  await blobs.putJson(manifestKey(site.id, versionId), {
    files,
    ...(layer ? { layer } : {}),
  } satisfies StoredManifest)
  await writeForms(deps, site.id, versionId, forms ?? null)
  await store.putVersion(site, version)
  // A deploy nobody finalizes is maintenance's to delete, once it is stale.
  await queueMaintenance(deps, site, Date.parse(now) + PENDING_TTL_MS)
  // A newer publish: the one that waited for secrets no longer goes live when they are set. A
  // restored site's live version waiting to start its server keeps waiting until another goes live.
  if (
    site.server?.awaiting &&
    site.server.awaiting.versionId !== version.id &&
    !awaitsSecretsLive(site)
  ) {
    await writeSite(deps, site, s => {
      if (!s.server?.awaiting || s.server.awaiting.versionId === version.id) return false
      if (awaitsSecretsLive(s)) return false
      const { awaiting: _, ...rest } = s.server
      s.server = rest
      return true
    })
  }
  const kept = new Set(layer?.kept)
  const sent = req.manifest.files.filter(f => !kept.has(f.path))
  return { kind: 'pending', site, actor, version, files, sent, layer, storage: site.id }
}

const isSecretsMissing = (err: unknown): err is ApiError & { extra: { secrets: string[] } } =>
  err instanceof ApiError && err.code === 'secrets_missing' && Array.isArray(err.extra?.secrets)

/**
 * A pending version refused only for unset secrets waits for them (`SiteServerState.awaiting`):
 * setting the last one takes it live, or tries to, again at every later change (servers/api.ts).
 */
async function awaitSecrets(deps: Deps, site: SiteRecord, versionId: string, secrets: string[]) {
  await writeSite(deps, site, s => {
    s.server = { ...s.server, awaiting: { versionId, secrets } }
    return true
  })
}

/**
 * A complete version deployed again with its `fling.json` (`mark`): it keeps the mark the deploy
 * sends, as a version is named by its files alone.
 */
async function withMark(
  deps: Deps,
  site: SiteRecord,
  version: VersionRecord,
  mark: ServerMark | undefined
): Promise<VersionRecord> {
  if (!mark || JSON.stringify(mark) === JSON.stringify(version.server)) return version
  const marked = { ...version, server: mark }
  await deps.store.putVersion(site, marked)
  return marked
}

/**
 * The first deploy to a name reserves the siteId, with the access asked for; it stays unlisted
 * until a version goes live. Lost a race for the name to another user → `name_taken`.
 */
async function createSiteFor(
  deps: Deps,
  user: User,
  name: string,
  access: AccessFields | null,
  inviter: ReturnType<typeof inviterOf>
): Promise<SiteRecord> {
  const now = deps.clock.now().toISOString()
  const site = await deps.store.createSite({
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
  })
  if (!site) throw await nameTaken(deps, user, name)
  await inviteAdded(deps, inviter, site, { emails: [], groups: [] })
  return site
}

// --- Paths (paths.ts) ---------------------------------------------------------------------------

/** Staged deploys to a Path are found again at finalize for this long. */
const PATH_DEPLOY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A publish to the Path at `folder`: the files sent, each under `<folder>/`, become a version of
 * the Path with the folder taken off. Makes the Path on first use (its owner: whoever publishes
 * it), and the site's own first version (the default home page listing its Paths) when the site
 * has none, so it can be served. Publishing to someone else's Path needs one of its roles (or to
 * own the site): otherwise 403 `path_not_yours`.
 */
async function preparePath(
  deps: Deps,
  user: User,
  actor: Actor,
  site: SiteRecord,
  folder: string,
  req: DeployRequest,
  acting: Acting
): Promise<Prepared> {
  const { store, blobs, clock } = deps
  const now = clock.now().toISOString()
  if (site.currentVersionId === null) await publishDefaultHome(deps, user, actor, site, acting)
  let path = await store.getPath(site.id, folder)
  if (!path) {
    if (folder === SERVER_PATH_FOLDER && site.server?.live) {
      throw conflict(
        `"${site.name}" has a server, which answers /${SERVER_PATH_FOLDER}/: publish the Path to another folder`,
        'path_conflict'
      )
    }
    const paths = await store.listPaths(site.id)
    if (paths.length >= MAX_PATHS_PER_SITE) {
      throw tooLarge(
        `"${site.name}" has ${MAX_PATHS_PER_SITE} Paths, the most a site may have: delete one, or publish to an existing one`
      )
    }
    await ensureRoomForLivePath(deps, site, { folder }, paths)
    const made: PathRecord = {
      siteId: site.id,
      folder,
      id: newId(),
      currentVersionId: null,
      owners: { emails: [user.email], groups: [] },
      publishers: { emails: [], groups: [] },
      archived: false,
      title: '',
      createdBy: user.email,
      createdAt: now,
      updatedAt: now,
    }
    path = (await store.createPath(made)) ? made : await store.getPath(site.id, folder)
    if (!path) throw conflict(`${displayPublishPath(folder)} changed meanwhile: publish again`)
  }
  const policySite = pathPolicySite(site, path)
  // The Path's roles may name groups the site's don't.
  const pathActor = await actorOn(deps, actor, policySite)
  if (!can(pathActor, 'site.deploy', policySite)) {
    throw new ApiError(
      403,
      'path_not_yours',
      `${displayPublishPath(folder)} of "${site.name}" is a Path someone else publishes: ask one of its owners (${path.owners.emails.join(', ') || 'the site’s owners'}) to make you a publisher of it, or publish to another folder`
    )
  }
  if (path.archived) {
    if (!can(pathActor, 'site.archive', policySite)) {
      throw new ApiError(
        400,
        'owner_only',
        `${displayPublishPath(folder)} of "${site.name}" is archived: only its owners restore it`
      )
    }
  }
  // Checked before the upload, and again as it goes live (makePathCurrent).
  if (!isLivePath(path)) await ensureRoomForLivePath(deps, site, path)
  const prefix = `${folder}/`
  const what = `${displayPublishPath(folder)} of "${site.name}"`
  const layered = await layerOn(
    deps,
    { storage: path.id, current: path.currentVersionId, what },
    {
      ...req,
      files: req.manifest.files.map(f => ({ ...f, path: f.path.slice(prefix.length) })),
      ...(req.remove
        ? { remove: req.remove.map(r => (r.startsWith(prefix) ? r.slice(prefix.length) : r)) }
        : {}),
    }
  )
  const layer = layered?.layer ?? null
  const files =
    layered?.files ?? req.manifest.files.map(f => ({ ...f, path: f.path.slice(prefix.length) }))
  const versionId = computeVersionId(files)
  const ref = pathRef(site, path)
  // Forms are the site's: its review page reads them from the site's live version.
  if (req.forms) {
    throw badRequest(
      `Forms belong to the site, not to the Path /${folder}/: publish them with the site's root, without a path`
    )
  }
  const result = async (status: 'unchanged' | 'repointed'): Promise<Prepared> => {
    const hints = await pathHints(deps, site)
    return {
      kind: 'done',
      result: {
        status,
        versionId,
        site: toSite(deps, actor, site),
        ...(hints.length ? { hints } : {}),
      },
    }
  }
  if (path.currentVersionId === versionId) {
    if (path.archived) await makePathCurrent(deps, site, path, versionId, null)
    return result('unchanged')
  }
  const known = await reviveVersion(deps, ref, await store.getVersion(ref, versionId))
  if (known?.status === 'complete') {
    await makePathCurrent(deps, site, path, versionId, known.title ?? null)
    await countPush(deps, site.id)
    return result('repointed')
  }
  if (known && known.status !== 'pending') throw retryLater(folder)
  const version: VersionRecord = {
    siteId: path.id,
    id: versionId,
    status: 'pending',
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    publishedBy: user.email,
    path: folder,
    ...(layer ? { base: layer.base } : {}),
    createdAt: now,
  }
  await blobs.putJson(manifestKey(path.id, versionId), {
    files,
    ...(layer ? { layer } : {}),
  } satisfies StoredManifest)
  await store.putVersion(ref, version)
  await queueMaintenance(deps, site, Date.parse(now) + PENDING_TTL_MS)
  const expires = new Date(clock.now().getTime() + PATH_DEPLOY_TTL_MS).toISOString()
  await store.notePathDeploy(site.id, versionId, folder, expires)
  const kept = new Set(layer?.kept)
  return {
    kind: 'pending',
    site,
    actor,
    version,
    files,
    sent: files.filter(f => !kept.has(f.path)),
    layer,
    storage: path.id,
    path: { record: path, folder },
  }
}

/** 409 `retry_later`: the version is being deleted (retention) as it is published again. */
const retryLater = (folder: string) =>
  conflict(
    `This version of ${displayPublishPath(folder)} is being deleted: publish again in a minute`,
    'retry_later'
  )

/** A staged Path version passed its checks: render it, mark it complete and make it current. */
async function goLivePath(
  deps: Deps,
  user: User,
  actor: Actor,
  site: SiteRecord,
  path: PathRecord,
  version: VersionRecord,
  files: readonly ManifestFile[],
  layer: Layer | null = null
): Promise<Published> {
  const what = `${displayPublishPath(path.folder)} of "${site.name}"`
  if (layer && path.currentVersionId !== layer.base) throw baseChanged(what, layer.base)
  if (layer && version.status === 'pending') await copyKept(deps, path.id, version.id, layer)
  let title: string | null = version.title ?? null
  if (version.status === 'pending') {
    const rendered = await renderVersion(deps, path.id, version.id, files)
    const complete: VersionRecord = {
      ...version,
      ...rendered,
      status: 'complete',
      publishedBy: user.email,
    }
    await deps.store.putVersion(pathRef(site, path), complete)
    title = rendered.title ?? ''
  }
  try {
    await makePathCurrent(deps, site, path, version.id, title, layer?.base ?? path.currentVersionId)
  } catch (err) {
    // Lost the race: the version waits, pending, to be published again.
    if (version.status === 'pending') await deps.store.putVersion(pathRef(site, path), version)
    if (layer && err instanceof ApiError && err.code === 'base_changed') {
      throw baseChanged(what, layer.base)
    }
    throw err
  }
  await countPush(deps, site.id)
  await queueMaintenance(deps, site)
  if (version.status === 'pending') await unqueueStaleCheck(deps, site, version)
  const hints = await pathHints(deps, site)
  return {
    status: 'live',
    versionId: version.id,
    site: toSite(deps, actor, site),
    ...(hints.length ? { hints } : {}),
  }
}

/**
 * The site's first version, when its first publish is to a Path: the default home page, which
 * lists its Paths (paths-templates.ts), so the site can be served. Its owners replace it like any
 * home page; one with a Paths block keeps the listing.
 */
async function publishDefaultHome(
  deps: Deps,
  user: User,
  actor: Actor,
  site: SiteRecord,
  acting: Acting
) {
  const bytes = new TextEncoder().encode(pathsTemplate('minimal', { title: site.name }))
  const file: ManifestFile = {
    path: 'index.html',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    contentType: 'text/html; charset=utf-8',
  }
  const findings = scanBytesForSecrets(bytes, file.path)
  if (findings.length > 0) throw secretDetected(findings)
  const versionId = computeVersionId([file])
  const version: VersionRecord = {
    siteId: site.id,
    id: versionId,
    status: 'pending',
    fileCount: 1,
    totalBytes: file.size,
    publishedBy: user.email,
    createdAt: deps.clock.now().toISOString(),
  }
  await deps.blobs.put(siteObjectKey(site.id, versionId, file.path), bytes, {
    contentType: file.contentType,
    cacheControl: cacheControlFor(file.path),
  })
  await deps.blobs.putJson(manifestKey(site.id, versionId), {
    files: [file],
  } satisfies StoredManifest)
  await deps.store.putVersion(site, version)
  await goLive(deps, user, actor, site, version, [file], acting)
}

/** Finalize a staged deploy to one of the site's Paths (`notePathDeploy`), if it is one. */
async function finalizePath(
  deps: Deps,
  user: User,
  actor: Actor,
  site: SiteRecord,
  versionId: string
): Promise<Published | null> {
  const { store, blobs } = deps
  for (const folder of await store.pathDeploys(site.id, versionId)) {
    const path = await store.getPath(site.id, folder)
    if (!path) continue
    const ref = pathRef(site, path)
    const version = await store.getVersion(ref, versionId)
    if (!version) continue
    const policySite = pathPolicySite(site, path)
    if (!can(await actorOn(deps, actor, policySite), 'site.deploy', policySite)) continue
    if (version.status === 'complete') {
      if (path.currentVersionId === version.id || !version.base) {
        return goLivePath(deps, user, actor, site, path, version, [])
      }
      return goLivePath(deps, user, actor, site, path, version, [], {
        base: version.base,
        kept: [],
      })
    }
    if (version.status !== 'pending') throw retryLater(folder)
    const claimed = await finalizing(deps, path.id, versionId, async () => {
      // Read again under the claim: a finalize that held it before may have made it live.
      const pending = await deps.store.getVersion(ref, versionId)
      if (pending?.status !== 'pending') return null
      const manifest = await blobs.getJson<StoredManifest>(manifestKey(path.id, versionId))
      if (!manifest) throw notFound(`Manifest for deploy ${versionId} is gone; deploy again`)
      const layer = manifest.layer ?? null
      if (layer && path.currentVersionId !== layer.base) {
        throw baseChanged(`${displayPublishPath(folder)} of "${site.name}"`, layer.base)
      }
      const kept = new Set(layer?.kept)
      await checkUploads(
        deps,
        path.id,
        versionId,
        manifest.files.filter(f => !kept.has(f.path)),
        async () => (await deps.store.getVersion(ref, versionId))?.status === 'pending'
      )
      return goLivePath(deps, user, actor, site, path, pending, manifest.files, layer)
    })
    return claimed ?? finalizePath(deps, user, actor, site, versionId)
  }
  return null
}

/**
 * Every file uploaded, at its size (409 `missing_uploads` otherwise), and read back and scanned
 * for secrets: the server never saw these bytes. A secret → what was uploaded is deleted (the
 * version stays pending with no manifest; deploying again starts over) and 422.
 *
 * On a store whose uploads are bound only to an MD5 (`Blobs.uploadDigest`), the uploads are at
 * their staging keys, whose URLs stay good after finalize. Each one is first copied into the
 * version, which no URL can write, and the copy is what is checked (its size and SHA-256) and
 * scanned, so what is served is what was checked, whatever is PUT to a staging URL meanwhile.
 * One that isn't the manifest's is deleted like a secret, with 409 `upload_mismatch`. The staging
 * copies are deleted either way. A file already copied in (a finalize that stopped part way) and
 * no longer staged is checked where it is.
 */
async function checkUploads(
  deps: Deps,
  storage: string,
  versionId: string,
  sent: readonly ManifestFile[],
  stillPending: () => Promise<boolean>
) {
  const { blobs } = deps
  const staging = blobs.uploadDigest === 'md5'
  const finalKey = (f: ManifestFile) => siteObjectKey(storage, versionId, f.path)
  const stagedKey = (f: ManifestFile) => stagedObjectKey(storage, versionId, f.path)
  if (staging) {
    await mapLimit(sent, HEAD_CONCURRENCY, async f => {
      if (await blobs.head(stagedKey(f))) await blobs.copy(stagedKey(f), finalKey(f))
    })
  }
  const discard = async () => {
    // Never a version's files once it is live (a finalize whose claim lapsed, say).
    if (!(await stillPending())) {
      throw conflict(`Deploy ${versionId} was finalized meanwhile`, 'finalize_in_progress')
    }
    await blobs.deletePrefix(siteVersionPrefix(storage, versionId))
    if (staging) await blobs.deletePrefix(stagedPrefix(storage, versionId))
  }
  const checks = await mapLimit(sent, HEAD_CONCURRENCY, async file => {
    const head = await blobs.head(finalKey(file))
    return head && head.size === file.size ? null : file.path
  })
  const missing = checks.filter((p): p is string => p !== null)
  if (missing.length > 0) {
    // Nothing is discarded: the publisher may upload what is missing and finalize again.
    const listed = missing.slice(0, MAX_MISSING_LISTED)
    const more = missing.length > listed.length ? ` (+${missing.length - listed.length} more)` : ''
    throw conflict(
      `${missing.length} file(s) missing or the wrong size: ${listed.join(', ')}${more}`,
      'missing_uploads',
      { missing }
    )
  }
  const { findings, mismatched } = await scanStoredVersion(deps, finalKey, sent, staging)
  if (findings.length > 0 || mismatched.length > 0) {
    await discard()
    await blobs.delete(manifestKey(storage, versionId))
    if (findings.length > 0) throw secretDetected(findings)
    const listed = mismatched.slice(0, MAX_MISSING_LISTED)
    const more =
      mismatched.length > listed.length ? ` (+${mismatched.length - listed.length} more)` : ''
    throw conflict(
      `${mismatched.length} file(s) uploaded are not the bytes the manifest names: ` +
        `${listed.join(', ')}${more}. Deploy again.`,
      'upload_mismatch',
      { mismatched }
    )
  }
  if (staging) await blobs.deletePrefix(stagedPrefix(storage, versionId))
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
  // A server starts before anything about the version changes: a refusal leaves it as it was.
  let started: string | null = null
  if (version.server && site.currentVersionId !== version.id) {
    if (version.status === 'pending') {
      const bundle = await deps.blobs.get(serverVersion(site.id, version.id).bundle)
      if (!bundle) throw notFound(`The server of deploy ${version.id} is gone; deploy again`)
      checkBundle(bundle)
    }
    try {
      started = await startServer(deps, principalOfUser(user), site, version)
    } catch (err) {
      if (version.status === 'pending' && isSecretsMissing(err)) {
        await awaitSecrets(deps, site, version.id, err.extra.secrets)
      }
      throw err
    }
  }
  if (version.status === 'pending') {
    const generatedIndex = await detectGeneratedIndex(deps, site.id, version.id, files)
    await deps.blobs.putJson(manifestKey(site.id, version.id), {
      files: [...files],
      generatedIndex,
      ...(layer ? { layer } : {}),
    } satisfies StoredManifest)
    const rendered = await renderVersion(deps, site.id, version.id, files)
    await deps.store.putVersion(site, {
      ...version,
      ...rendered,
      status: 'complete',
      publishedBy: user.email,
    })
  }
  let as = actor
  try {
    as = await saveOnBase(deps, actor, site, layer, (s, a) => {
      s.currentVersionId = version.id
      s.archived = false
      applySettings(s, settingsFor(a, s, version))
      applyServer(s, version, started ?? s.server?.target ?? null)
    })
  } catch (err) {
    // Back to pending, unless the site was deleted meanwhile (404): nothing to keep it for.
    const gone = err instanceof ApiError && err.status === 404
    if (version.status === 'pending' && !gone) await deps.store.putVersion(site, version)
    throw err
  }
  await noteLive(deps, user.email, site, version)
  await countPush(deps, site.id)
  // Retention: the version this one replaced may now be past the newest N.
  await queueMaintenance(deps, site)
  if (version.status === 'pending') await unqueueStaleCheck(deps, site, version)
  if (first && isRestricted(site)) {
    await notifyAudienceChange(deps, user.email, site, { emails: [], groups: [] }, acting)
  }
  if (site.paths) await refreshHome(deps, site)
  const hints = site.paths ? await pathHints(deps, site, files) : []
  return {
    status: 'live',
    versionId: version.id,
    site: toSite(deps, as, site),
    ...(first ? { first } : {}),
    ...(hints.length ? { hints } : {}),
  }
}

/**
 * The hints a publish to a site with Paths gets (PublishHintSchema): the site's own files it sent
 * under a live Path's folder, which the Path hides (`paths_block_hidden`); and, with two or more
 * live Paths, a home page that doesn't list them (`paths_index_missing`: its current version has
 * an index.html without a Paths block, `VersionRecord.home`).
 */
async function pathHints(
  deps: Deps,
  site: SiteRecord,
  sent: readonly ManifestFile[] = []
): Promise<PublishHint[]> {
  const live = (await deps.store.listPaths(site.id)).filter(isLivePath)
  const hints: PublishHint[] = []
  const hidden = live
    .map(p => p.folder)
    .filter(folder => sent.some(f => f.path.startsWith(`${folder}/`)))
  if (hidden.length > 0) {
    hints.push({
      code: 'paths_block_hidden',
      message: `The site's own files under ${hidden.map(displayPublishPath).join(', ')} are hidden: ${hidden.length === 1 ? 'that folder is a Path' : 'those folders are Paths'}, served from ${hidden.length === 1 ? 'its' : 'their'} own versions. Publish to ${hidden.length === 1 ? 'it' : 'them'} with path, or leave the files out.`,
      folders: hidden,
    })
  }
  if (live.length >= 2 && site.currentVersionId) {
    const version = await deps.store.getVersion(site, site.currentVersionId)
    if (version && !version.home) {
      hints.push({
        code: 'paths_index_missing',
        message: `"${site.name}" has ${live.length} Paths and its home page doesn't list them. Offer the user a home page that does: fling_paths_template gives a starter index.html with a Paths block (or \`fling paths init\`), to adapt and publish as the site's root.`,
      })
    }
  }
  return hints
}

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
  const { storage, version, sent, path } = prepared
  const asSent = (p: string) => (path ? `${path.folder}/${p}` : p)
  const uploads = await mapLimit(sent, PRESIGN_CONCURRENCY, async file => {
    // A store bound by MD5 takes uploads at a staging key, checked and copied in at finalize.
    const key =
      deps.blobs.uploadDigest === 'md5'
        ? stagedObjectKey(storage, version.id, file.path)
        : siteObjectKey(storage, version.id, file.path)
    const signed = await deps.blobs.presignPut(key, {
      contentType: file.contentType,
      cacheControl: cacheControlFor(file.path),
      sha256: file.sha256,
      ...(file.md5 ? { md5: file.md5 } : {}),
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    })
    return { path: asSent(file.path), url: signed.url, headers: signed.headers }
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
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.view')
  const version = await store.getVersion(site, versionId)
  if (!version) {
    const toPath = await finalizePath(deps, user, actor, site, versionId)
    if (toPath) return toPath
  }
  // Refused like a site that isn’t there (requireSiteAs).
  if (!can(actor, 'site.deploy', site)) await requireSiteAs(deps, user, name, 'site.deploy')
  if (!version) throw notFound(`No deploy ${versionId} for "${name}"`)
  if (version.status === 'pruning' || version.status === 'sweeping') {
    throw conflict(
      `Version ${versionId} of "${name}" is being deleted: deploy again in a minute`,
      'retry_later'
    )
  }
  await checkRestore(deps, actor, site)
  if (version.status === 'complete') {
    // Finalizing again: a layered publish still goes live only on top of its base.
    if (!version.base || site.currentVersionId === version.id) {
      return goLive(deps, user, actor, site, version, [], acting)
    }
    const layer = { base: version.base, kept: [] }
    if (site.currentVersionId !== version.base) throw baseChanged(`"${name}"`, version.base)
    return goLive(deps, user, actor, site, version, [], acting, layer)
  }

  const claimed = await finalizing(deps, site.id, versionId, async () => {
    // Read again under the claim: a finalize that held it before may have made it live.
    const pending = await store.getVersion(site, versionId)
    if (pending?.status !== 'pending') return null
    const manifest = await blobs.getJson<StoredManifest>(manifestKey(site.id, versionId))
    if (!manifest) throw notFound(`Manifest for deploy ${versionId} is gone; deploy again`)
    const layer = manifest.layer ?? null
    if (layer && site.currentVersionId !== layer.base) throw baseChanged(`"${name}"`, layer.base)
    const kept = new Set(layer?.kept)
    await checkUploads(
      deps,
      site.id,
      versionId,
      manifest.files.filter(f => !kept.has(f.path)),
      async () => (await store.getVersion(site, versionId))?.status === 'pending'
    )
    if (layer) await copyKept(deps, site.id, versionId, layer)
    return goLive(deps, user, actor, site, pending, manifest.files, acting, layer)
  })
  // Made live (or deleted) by the finalize before: answered as a finalize of what it is now.
  return claimed ?? publish(deps, user, name, versionId, acting)
}

/**
 * How long a finalize's claim holds: past the longest request any platform lets a finalize run
 * (the API Lambda's timeout, a Worker's request), and short, because a finalize killed before it
 * releases (a timeout, an evicted isolate) blocks every retry until its claim lapses.
 */
const FINALIZE_CLAIM_MS = 5 * 60_000

/**
 * `fn` holding the claim on finalizing `versionId` (Store.claimFinalize), so one finalize at a
 * time copies, checks, discards or makes it live: another one meanwhile is 409
 * `finalize_in_progress` and touches nothing. A crashed finalize's claim lapses after
 * FINALIZE_CLAIM_MS. Every store takes it, MD5-bound or not: two finalizes racing are a hazard
 * anywhere (one discarding what the other made live).
 */
async function finalizing<T>(
  deps: Deps,
  storage: string,
  versionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const owner = randomUUID()
  const until = new Date(deps.clock.now().getTime() + FINALIZE_CLAIM_MS).toISOString()
  if (!(await deps.store.claimFinalize(storage, versionId, owner, until))) {
    throw conflict(
      `Deploy ${versionId} is being finalized already: deploy again in a few minutes (a finalize that stopped part way frees it within ${FINALIZE_CLAIM_MS / 60_000} minutes)`,
      'finalize_in_progress'
    )
  }
  try {
    return await fn()
  } finally {
    // the claim lapses anyway: a failed release must not turn a finalize that worked into an error
    await deps.store
      .releaseFinalize(storage, versionId, owner)
      .catch(err =>
        console.warn(
          JSON.stringify({ level: 'warn', msg: 'finalize claim release failed', err: String(err) })
        )
      )
  }
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
    /**
     * a partial publish on this version (it must be current): `input` holds only the files that
     * changed or are new, and `remove` the base's files to leave out
     */
    base?: string
    remove?: readonly string[]
    spa?: boolean
    visibility?: Visibility
    access?: AccessLevel
    audience?: AudienceInput
    /** the version's forms config (null: none); omitted, as DeployRequest.forms */
    forms?: FormsConfig | null
    /** the folder's `fling.json`, for a version with a server (DeployRequest.server) */
    server?: ServerConfig
    /** a server on a public site (DeployRequest.confirmPublicServer) */
    confirmPublicServer?: boolean
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
    ...(opts.base === undefined
      ? {}
      : {
          base: opts.base,
          partial: true,
          ...(opts.remove?.length ? { remove: opts.remove } : {}),
        }),
    spa: opts.spa,
    visibility: opts.visibility,
    access: opts.access,
    audience: opts.audience,
    ...(opts.forms === undefined ? {} : { forms: opts.forms }),
    ...(opts.server ? { server: opts.server } : {}),
    ...(opts.confirmPublicServer ? { confirmPublicServer: true } : {}),
  })
  const bundle = bytesByPath.get(SERVER_BUNDLE)
  if (bundle && opts.path === undefined) checkBundle(bundle)
  // Scan exactly the bytes we are about to write, before anything is stored.
  const findings = input.flatMap(f => scanBytesForSecrets(f.bytes, f.path))
  if (findings.length > 0) throw secretDetected(findings)

  const prepared = await prepare(deps, user, name, req, opts.principal)
  if (prepared.kind === 'done') return prepared.result
  const { site, actor, version, layer, storage, path } = prepared
  await mapLimit(prepared.sent, PUT_CONCURRENCY, async f => {
    await deps.blobs.put(
      siteObjectKey(storage, version.id, f.path),
      bytesByPath.get(path ? `${path.folder}/${f.path}` : f.path) as Uint8Array,
      { contentType: f.contentType, cacheControl: cacheControlFor(f.path) }
    )
  })
  if (path) return goLivePath(deps, user, actor, site, path.record, version, prepared.files, layer)
  if (layer) await copyKept(deps, site.id, version.id, layer)
  return goLive(deps, user, actor, site, version, prepared.files, {}, layer)
}
