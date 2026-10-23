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
 * site's current setting (new sites: private, non-SPA).
 */
import { createHash } from 'node:crypto'
import {
  cacheControlFor,
  type DeployRequest,
  DeployRequestSchema,
  type DeployResponse,
  describeSecretFindings,
  forbiddenPathReason,
  isScannablePath,
  isValidSiteName,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  type Manifest,
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
import { mapLimit } from './lib/concurrency.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { newId } from './lib/ids.ts'
import { contentTypeFor } from './lib/mime.ts'
import {
  applySettings,
  detectGeneratedIndex,
  nameTaken,
  requireSite,
  type StoredManifest,
  save,
  toSite,
} from './sites.ts'
import { manifestKey } from './storage/types.ts'
import type { SiteRecord, User, VersionRecord } from './store/types.ts'
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

export type Published = {
  status: 'live' | 'unchanged' | 'repointed'
  versionId: string
  site: Site
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

/** Limits → path rules → schema, so the specific errors win over the schema's generic ones. */
function admit(raw: unknown): DeployRequest {
  const files = (raw as { manifest?: { files?: unknown } } | null)?.manifest?.files
  if (Array.isArray(files)) {
    assertWithinLimits(files)
    assertPublishablePaths(files.map(f => (f as { path?: unknown } | null)?.path))
  }
  return DeployRequestSchema.parse(raw)
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
    const bytes = await deps.storage.get(siteObjectKey(siteId, versionId, f.path))
    return bytes ? scanBytesForSecrets(bytes, f.path) : []
  })
  return results.flat()
}

// --- shared steps -------------------------------------------------------------------------------

type Prepared =
  | { kind: 'done'; result: Published & { status: 'unchanged' | 'repointed' } }
  | { kind: 'pending'; site: SiteRecord; version: VersionRecord; files: ManifestFile[] }

/** Name checks, the unchanged / repointed shortcuts, else a pending version (manifest stored). */
async function prepare(
  deps: Deps,
  user: User,
  name: string,
  req: DeployRequest
): Promise<Prepared> {
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
    return {
      kind: 'done',
      result: { status: 'unchanged', versionId, site: toSite(deps, user, existing) },
    }
  }

  if (existing) {
    const version = await store.getVersion(user.email, existing.id, versionId)
    if (version?.status === 'complete') {
      existing.currentVersionId = versionId
      existing.archived = false
      applySettings(existing, req)
      await save(deps, user, existing)
      return {
        kind: 'done',
        result: { status: 'repointed', versionId, site: toSite(deps, user, existing) },
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
  const version: VersionRecord = {
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
  await store.putVersion(user.email, version)
  return { kind: 'pending', site, version, files }
}

/** Pending → complete → current. Only reached once the version's bytes have been scanned. */
async function goLive(
  deps: Deps,
  user: User,
  site: SiteRecord,
  version: VersionRecord,
  files: readonly ManifestFile[]
): Promise<Published> {
  if (version.status === 'pending') {
    const generatedIndex = await detectGeneratedIndex(deps, site.id, version.id, files)
    await deps.storage.putJson(manifestKey(site.id, version.id), {
      files: [...files],
      generatedIndex,
    } satisfies StoredManifest)
    await deps.store.putVersion(user.email, { ...version, status: 'complete' })
  }
  site.currentVersionId = version.id
  site.archived = false
  applySettings(site, version)
  await save(deps, user, site)
  return { status: 'live', versionId: version.id, site: toSite(deps, user, site) }
}

/** S3's `x-amz-checksum-sha256` wants base64; manifests carry hex. */
const _sha256Base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64')

// --- the interface ------------------------------------------------------------------------------

/** POST /api/sites/:name/deploys — `raw` is the request body as sent. */
export async function stage(
  deps: Deps,
  user: User,
  name: string,
  raw: unknown
): Promise<DeployResponse> {
  const prepared = await prepare(deps, user, name, admit(raw))
  if (prepared.kind === 'done') return prepared.result
  const { site, version, files } = prepared
  const uploads = await mapLimit(files, PRESIGN_CONCURRENCY, async file => {
    const signed = await deps.storage.presignPut(siteObjectKey(site.id, version.id, file.path), {
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
  versionId: string
): Promise<Published> {
  const { store, storage } = deps
  const site = await requireSite(deps, user, name)
  const version = await store.getVersion(user.email, site.id, versionId)
  if (!version) throw notFound(`No deploy ${versionId} for "${name}"`)
  if (version.status === 'complete') return goLive(deps, user, site, version, [])

  const manifest = await storage.getJson<StoredManifest>(manifestKey(site.id, versionId))
  if (!manifest) throw notFound(`Manifest for deploy ${versionId} is gone; deploy again`)
  const checks = await mapLimit(manifest.files, HEAD_CONCURRENCY, async file => {
    const head = await storage.head(siteObjectKey(site.id, versionId, file.path))
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
  const findings = await scanStoredVersion(deps, site.id, versionId, manifest.files)
  if (findings.length > 0) {
    await storage.deletePrefix(siteVersionPrefix(site.id, versionId))
    await storage.deletePrefix(manifestKey(site.id, versionId))
    throw secretDetected(findings)
  }
  return goLive(deps, user, site, version, manifest.files)
}

/**
 * Remote MCP: publish files the server holds. Paths must already be site-relative (see
 * mcp/publish.ts normalizePath); content types come from the extension.
 */
export async function publishBytes(
  deps: Deps,
  user: User,
  name: string,
  input: readonly { path: string; bytes: Uint8Array }[],
  opts: { spa?: boolean; visibility?: Visibility }
): Promise<Published> {
  const bytesByPath = new Map(input.map(f => [f.path, f.bytes]))
  const files: ManifestFile[] = input.map(({ path, bytes }) => ({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    contentType: contentTypeFor(path),
  }))
  const req = admit({ manifest: { files }, spa: opts.spa, visibility: opts.visibility })
  // Scan exactly the bytes we are about to write, before anything is stored.
  const findings = input.flatMap(f => scanBytesForSecrets(f.bytes, f.path))
  if (findings.length > 0) throw secretDetected(findings)

  const prepared = await prepare(deps, user, name, req)
  if (prepared.kind === 'done') return prepared.result
  const { site, version } = prepared
  await mapLimit(prepared.files, PUT_CONCURRENCY, async f => {
    await deps.storage.put(
      siteObjectKey(site.id, version.id, f.path),
      bytesByPath.get(f.path) as Uint8Array,
      { contentType: f.contentType, cacheControl: cacheControlFor(f.path) }
    )
  })
  return goLive(deps, user, site, version, prepared.files)
}
