/**
 * Server-side publishing for the remote MCP connector: the content arrives inline (fling_publish)
 * or staged in the bucket (fling_upload_*). This module handles what is MCP-specific (paths as
 * agents write them, encodings, the generated listing page, `needs_decision`) and hands the bytes
 * to publication.publishBytes, which admits, scans, writes and makes them live.
 *
 * Chunked uploads: fling_upload_begin stores an UploadRecord (1 h); every fling_upload_file call
 * writes its content, as sent (still encoded), to `uploads/<id>/<sha(path)>/<part>` and bumps the
 * file's part count in the store; fling_upload_finish concatenates and decodes each file, then
 * publishes like fling_publish and deletes the staging area.
 *
 * With `path` (a path publish, publication.ts) the files are the Path's, given relative to its
 * folder: the listing page, if asked for, is the Path's own index.html, and every path is prefixed
 * with the folder before publishBytes, which publishes them as the Path's new version.
 *
 * With `base` (a version fling_read_files returned, of the site or with `path` of that Path) the
 * files are only those changed or added, `remove` names the ones to delete, and publishBytes
 * keeps the rest of that version (the partial form of a publish on a base). The site already has its pages, so there is no listing decision.
 *
 * Forms (forms.ts): `forms` is the new version's forms config (null: none; omitted, as
 * DeployRequest.forms). A `fling.forms.json` among the files, at the top of the folder published,
 * is taken as `forms` and never published as a file. Either is checked first
 * (`checkFormsConfig`), so a bad config fails with every error, each saying where.
 *
 * Site servers (servers/index.ts): a server is `_fling/server.mjs` among the files, already one
 * dependency-free module (a remote client can't bundle; `checkBundle` refuses any other import
 * with `server_not_bundled`). Its `fling.json` is `server` (fling_publish's `siteServer`) or a
 * `fling.json` among the files, at the top of the folder published, which is never published as a
 * file either; only its `secrets` and `health` are read (its `server`, the entry the CLI bundles,
 * means nothing here).
 * `confirmPublicServer` is the publisher's yes to a server on a public site.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  type AccessLevel,
  checkFormsConfig,
  extractHtmlTitle,
  FORMS_FILE,
  type FormsConfig,
  isHtmlPath,
  isSitePath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  MAX_PATH_FOLDER_LENGTH,
  MAX_STORED_PATH_LENGTH,
  MCP_UPLOAD_MAX_FILES,
  MCP_UPLOAD_TTL_SECONDS,
  normalizePathFolder,
  type PublishHint,
  renderHtmlListing,
  SERVER_CONFIG_FILE,
  type ServerConfig,
  ServerConfigSchema,
  type Site,
  type Visibility,
} from '@fling/shared'
import {
  ARCHIVE_PART_BYTES,
  archiveUploadPath,
  sandboxAllowAdvice,
  sandboxUploadGuideUrl,
  sandboxUploadHost,
  sandboxUploadScript,
} from '@fling/shared/sandbox-upload'
import { readZipSite, ZipError } from '@fling/shared/zip'
import { uploadPrefix } from '../blobs/types.ts'
import { bodyUpTo } from '../lib/body.ts'
import { mapLimit } from '../lib/concurrency.ts'
import { ApiError, badRequest, notFound } from '../lib/errors.ts'
import { newId } from '../lib/ids.ts'
import type { Principal } from '../policy.ts'
import { assertPublishablePaths, publishBytes } from '../publication.ts'
import * as sites from '../sites.ts'
import type { UploadRecord, User } from '../store/types.ts'
import type { Deps } from '../types.ts'

export type Encoding = 'utf8' | 'base64'

export interface InlineFile {
  path: string
  bytes: Uint8Array
}

/** Who can open a site the publish creates (ignored for an existing one). */
export interface AccessOptions {
  access?: AccessLevel
  audience?: { emails: string[]; groups: string[] }
}

export interface PublishOptions extends AccessOptions {
  /** who is publishing: a new site needs `account.site.create` */
  principal: Principal
  /** a path publish: the folder (as the agent wrote it) the files go to */
  path?: string
  /** a partial publish on this version: the files are those changed or added */
  base?: string
  /** with `base`: the site's files to delete */
  remove?: readonly string[]
  spa?: boolean
  visibility?: Visibility
  /** no root index.html: true → generate a listing page; false → publish anyway; undefined → ask */
  listHtml?: boolean
  /** the version's forms config (null: none); omitted, as DeployRequest.forms */
  forms?: unknown
  /** the server's `fling.json` (DeployRequest.server); omitted, a `fling.json` among the files */
  server?: unknown
  /** a server on a public site: the publisher said yes (DeployRequest.confirmPublicServer) */
  confirmPublicServer?: boolean
}

/** A `fling.json` as an agent sent it, checked; 400 `invalid_server_config` naming the problem. */
export function checkedServerConfig(raw: unknown, where = '`siteServer`'): ServerConfig {
  const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  // `server`, the entry the CLI bundles, has no meaning for a server already in one file.
  const { server: _entry, ...rest } = object ? (raw as Record<string, unknown>) : {}
  const parsed = ServerConfigSchema.safeParse(object ? rest : raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const at = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new ApiError(
      400,
      'invalid_server_config',
      `${where} is not a ${SERVER_CONFIG_FILE} Fling can use${at}: ${issue?.message ?? 'invalid'}. It takes "secrets" (names) and "health" (a path under /api/)`
    )
  }
  return parsed.data
}

/** A forms config as an agent sent it, checked; 400 `invalid_forms` listing every error. */
export function checkedForms(raw: unknown, where = '`forms`'): FormsConfig | null {
  if (raw === null) return null
  const check = checkFormsConfig(raw)
  if (!check.ok) {
    throw new ApiError(
      400,
      'invalid_forms',
      `${where} is not a forms config Fling can use: ${check.errors.join('; ')}`,
      { errors: check.errors }
    )
  }
  return raw as FormsConfig
}

export type PublishOutcome =
  | { kind: 'needs_decision'; htmlPages: string[]; fileCount: number }
  | {
      kind: 'published'
      status: 'live' | 'unchanged' | 'repointed'
      versionId: string
      site: Site
      /** this publish made the site live for the first time */
      first?: boolean
      fileCount: number
      totalBytes: number
      generatedIndex: boolean
      warnings: string[]
      /** every path published (picks the URL the readiness wait polls) */
      paths: string[]
      /** a path publish: the Path's folder (normalised) */
      path?: string
      /** for the publisher to act on (PublishHintSchema) */
      hints?: PublishHint[]
      /** a publish on a base: the version it built on */
      base?: string
    }

const tooLarge = (message: string) => new ApiError(413, 'too_large', message)

/** A path a `remove` may name: any a stored file can have, longer than an upload's included. */
const isStoredPath = (path: string) => path.length <= MAX_STORED_PATH_LENGTH && isSitePath(path)

/**
 * `./a/b.html` or `/a/b.html` → `a/b.html`; dotfiles / secret files → 400 `dotfile` /
 * `secret_file`; anything else invalid (for an upload, `accepts` isValidSitePath) → 400.
 */
export function normalizePath(raw: string, accepts = isValidSitePath): string {
  const path = raw
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
  if (path && !path.includes('\\') && !path.split('/').some(s => s === '..' || s === '.'))
    assertPublishablePaths([path])
  if (!accepts(path)) {
    throw badRequest(
      `Invalid file path "${raw}": use a site-relative path with forward slashes, like "index.html" or "img/logo.png"`,
      'invalid_path'
    )
  }
  return path
}

/** A path publish's folder (a Path), normalised; 400 `invalid_path` unless it is one folder. */
export function normalizeFolder(raw: string): string {
  const path = normalizePathFolder(raw)
  if (path === null) {
    throw badRequest(
      `Invalid path "${raw}": use one top-level folder of the site, like "PAY-412" (no dotfiles, at most ${MAX_PATH_FOLDER_LENGTH} characters)`,
      'invalid_path'
    )
  }
  return path
}

const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/

export function decodeContent(content: string, encoding: Encoding, path: string): Uint8Array {
  if (encoding === 'utf8') return new Uint8Array(Buffer.from(content, 'utf8'))
  const clean = content.replace(/\s+/g, '')
  if (!BASE64_RE.test(clean)) {
    throw badRequest(`"${path}" is not valid base64`, 'invalid_content')
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

export async function publishFiles(
  deps: Deps,
  user: User,
  name: string,
  input: InlineFile[],
  opts: PublishOptions
): Promise<PublishOutcome> {
  const { base } = opts
  const remove =
    base === undefined
      ? []
      : [...new Set((opts.remove ?? []).map(p => normalizePath(p, isStoredPath)))]
  if (opts.remove?.length && base === undefined) {
    throw badRequest('`remove` needs `base`: the version you read the files of', 'bad_request')
  }
  if (input.length === 0 && remove.length === 0) {
    throw badRequest('No files to publish', 'no_files')
  }
  const folder = opts.path === undefined ? undefined : normalizeFolder(opts.path)
  const root = folder === undefined ? 'at the root' : `in /${folder}/`
  const url = folder === undefined ? 'the site URL' : `/${folder}/`
  const files = new Map<string, Uint8Array>()
  for (const f of input) {
    const path = normalizePath(f.path)
    if (files.has(path)) throw badRequest(`"${path}" is listed twice`, 'duplicate_path')
    files.set(path, f.bytes)
  }
  let forms = opts.forms === undefined ? undefined : checkedForms(opts.forms)
  const formsFile = files.get(FORMS_FILE)
  if (formsFile) {
    if (opts.forms !== undefined) {
      throw badRequest(`Pass \`forms\` or a ${FORMS_FILE} file, not both`, 'bad_request')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(formsFile).toString('utf8'))
    } catch {
      throw new ApiError(400, 'invalid_forms', `${FORMS_FILE} is not valid JSON`)
    }
    forms = checkedForms(parsed, FORMS_FILE)
    files.delete(FORMS_FILE)
    if (files.size === 0 && remove.length === 0) throw badRequest('No files to publish', 'no_files')
  }
  let server = opts.server === undefined ? undefined : checkedServerConfig(opts.server)
  const serverFile = files.get(SERVER_CONFIG_FILE)
  if (serverFile) {
    if (opts.server !== undefined) {
      throw badRequest(
        `Pass \`siteServer\` or a ${SERVER_CONFIG_FILE} file, not both`,
        'bad_request'
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(serverFile).toString('utf8'))
    } catch {
      throw new ApiError(400, 'invalid_server_config', `${SERVER_CONFIG_FILE} is not valid JSON`)
    }
    server = checkedServerConfig(parsed, SERVER_CONFIG_FILE)
    files.delete(SERVER_CONFIG_FILE)
    if (files.size === 0 && remove.length === 0) throw badRequest('No files to publish', 'no_files')
  }
  const warnings: string[] = []
  let generatedIndex = false
  // On a base the site keeps the pages it has: no listing to decide on.
  if (base === undefined && !files.has('index.html')) {
    const htmlPages = [...files.keys()].filter(isHtmlPath).sort()
    if (htmlPages.length === 0) {
      warnings.push(
        `No index.html ${root} and no HTML pages: ${url} will 404; link to the files by path.`
      )
    } else if (opts.listHtml === undefined) {
      return { kind: 'needs_decision', htmlPages, fileCount: files.size }
    } else if (opts.listHtml) {
      const entries = htmlPages.map(path => ({
        path,
        title: extractHtmlTitle(Buffer.from(files.get(path) as Uint8Array).toString('utf8')),
      }))
      files.set('index.html', new Uint8Array(Buffer.from(renderHtmlListing(name, entries), 'utf8')))
      generatedIndex = true
    } else {
      warnings.push(`No index.html ${root}: ${url} will 404; the pages work at their own paths.`)
    }
  }
  if (base === undefined && opts.spa && !files.has('index.html')) {
    warnings.push('spa is on but there is no index.html to fall back to.')
  }

  const sitePath = (path: string) => (folder === undefined ? path : `${folder}/${path}`)
  const published = await publishBytes(
    deps,
    user,
    name,
    [...files].map(([path, bytes]) => ({ path: sitePath(path), bytes })),
    {
      principal: opts.principal,
      path: folder,
      ...(base === undefined ? {} : { base, remove: remove.map(sitePath) }),
      spa: opts.spa,
      visibility: opts.visibility,
      access: opts.access,
      audience: opts.audience,
      ...(forms === undefined ? {} : { forms }),
      ...(server ? { server } : {}),
      ...(opts.confirmPublicServer ? { confirmPublicServer: true } : {}),
    }
  )
  return {
    kind: 'published',
    ...published,
    fileCount: files.size,
    totalBytes: [...files.values()].reduce((n, b) => n + b.byteLength, 0),
    generatedIndex,
    warnings,
    paths: [...files.keys()].map(sitePath),
    ...(folder === undefined ? {} : { path: folder }),
    ...(base === undefined ? {} : { base }),
  }
}

// --- chunked uploads ----------------------------------------------------------------------------

const pathHash = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24)
const partKey = (uploadId: string, path: string, part: number) =>
  `${uploadPrefix(uploadId)}${pathHash(path)}/${part}`

export async function beginUpload(
  deps: Deps,
  user: User,
  name: string,
  opts: {
    spa?: boolean
    visibility?: Visibility
    path?: string
    base?: string
    remove?: readonly string[]
  } & AccessOptions
): Promise<UploadRecord> {
  const path = opts.path === undefined ? undefined : normalizeFolder(opts.path)
  if (opts.remove?.length && opts.base === undefined) {
    throw badRequest('`remove` needs `base`: the version you read the files of', 'bad_request')
  }
  const remove = opts.remove?.length
    ? [...new Set(opts.remove.map(p => normalizePath(p, isStoredPath)))]
    : undefined
  // Fail early on a bad or taken name, before anything is uploaded.
  const check = await sites.checkName(deps, user, name)
  if (check.status === 'invalid') {
    throw badRequest(
      `"${name}" is not a valid site name.${check.suggestions.length ? ` Try ${check.suggestions.join(', ')}.` : ''}`,
      'invalid_name'
    )
  }
  if (check.status === 'taken') {
    throw new ApiError(409, 'name_taken', `"${name}" is already taken by someone else.`, {
      suggestions: check.suggestions,
    })
  }
  const now = deps.clock.now()
  const upload: UploadRecord = {
    id: `${newId()}${newId()}`,
    email: user.email,
    name,
    spa: opts.spa,
    visibility: opts.visibility,
    ...(path === undefined ? {} : { path }),
    ...(opts.base === undefined ? {} : { base: opts.base }),
    ...(remove ? { remove } : {}),
    ...(opts.access ? { access: opts.access } : {}),
    ...(opts.audience ? { audience: opts.audience } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MCP_UPLOAD_TTL_SECONDS * 1000).toISOString(),
  }
  await deps.store.putUpload(upload)
  return upload
}

// --- sandbox uploads (@fling/shared/sandbox-upload) ---------------------------------------------
//
// An upload's zip, PUT by the script Claude runs in its sandbox to a URL fling_upload_begin signed:
// parts at `uploads/<id>/archive/<n>` (never a file's part key: those are hex) and how many there
// are at `uploads/<id>/archive/count`. The URL is the whole authorisation to store parts, so it
// names the upload and its expiry only; publishing stays fling_upload_finish's, as the user.

/** Enough parts for the largest deploy, as a zip that didn't compress at all. */
export const MAX_ARCHIVE_PARTS = Math.ceil(MAX_DEPLOY_BYTES / ARCHIVE_PART_BYTES) + 1

const archivePartKey = (uploadId: string, part: number) =>
  `${uploadPrefix(uploadId)}archive/${part}`
const archiveCountKey = (uploadId: string) => `${uploadPrefix(uploadId)}archive/count`

// Keeps the MAC apart from anything else signed with the session secret.
const archiveMac = (secret: string, uploadId: string, exp: number) =>
  createHmac('sha256', secret)
    .update(`fling-archive-upload:${uploadId}\n${exp}`)
    .digest('base64url')

/** How an upload's files come from a sandbox: the signed URL, the script around it, the host. */
export interface ArchiveUpload {
  url: string
  script: string
  /** the host the sandbox must reach (the app origin's) */
  host: string
  /** where in Claude that host is allowed, said to the user when the sandbox can't reach it */
  allowAdvice: string
}

export function archiveUpload(deps: Deps, upload: UploadRecord): ArchiveUpload {
  const exp = Math.floor(Date.parse(upload.expiresAt) / 1000)
  const sig = archiveMac(deps.config.secrets.sessionSecret, upload.id, exp)
  const url = `${deps.config.appOrigin}/api${archiveUploadPath(upload.id)}?exp=${exp}&sig=${sig}`
  const host = sandboxUploadHost(url)
  const advice = sandboxAllowAdvice(host, sandboxUploadGuideUrl(deps.config.appOrigin))
  return { url, script: sandboxUploadScript(url), host, allowAdvice: advice }
}

/** What an archive PUT carries in its URL. */
export interface ArchivePart {
  uploadId: string
  exp: string | undefined
  sig: string | undefined
  part: string | undefined
  of: string | undefined
}

/**
 * Store one part of an upload's zip. The signature is checked before any byte is read; then the
 * upload must still be open and the part within `of`, and `of` within MAX_ARCHIVE_PARTS.
 */
export async function putArchivePart(deps: Deps, input: ArchivePart, request: Request) {
  const exp = Number(input.exp)
  const now = deps.clock.now().getTime()
  const expected = Number.isFinite(exp)
    ? Buffer.from(archiveMac(deps.config.secrets.sessionSecret, input.uploadId, exp))
    : null
  const given = Buffer.from(input.sig ?? '')
  if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new ApiError(
      403,
      'forbidden',
      'Bad signature: use the script fling_upload_begin returned'
    )
  }
  if (exp * 1000 <= now) {
    throw new ApiError(
      403,
      'expired',
      'This upload has expired: start again with fling_upload_begin'
    )
  }
  const upload = await deps.store.getUpload(input.uploadId)
  if (!upload || Date.parse(upload.expiresAt) <= now) {
    throw notFound('No open upload: start again with fling_upload_begin')
  }
  const part = Number(input.part)
  const of = Number(input.of)
  if (!Number.isInteger(of) || of < 1 || of > MAX_ARCHIVE_PARTS) {
    throw badRequest(`\`of\` must be 1 to ${MAX_ARCHIVE_PARTS}`, 'bad_part')
  }
  if (!Number.isInteger(part) || part < 0 || part >= of) {
    throw badRequest(`\`part\` must be 0 to ${of - 1}`, 'bad_part')
  }
  const body = await bodyUpTo(request, ARCHIVE_PART_BYTES)
  if (!body) throw tooLarge(`A part is at most ${ARCHIVE_PART_BYTES / 1024 / 1024} MB`)
  await deps.blobs.put(archivePartKey(upload.id, part), body, {
    contentType: 'application/octet-stream',
  })
  await deps.blobs.putJson(archiveCountKey(upload.id), { of })
  return { uploadId: upload.id, part, of }
}

/** The upload's zip read into its files, or null when no part was sent. */
async function archiveFiles(
  deps: Deps,
  uploadId: string
): Promise<{ files: InlineFile[]; skippedDotfiles: string[] } | null> {
  const count = await deps.blobs.getJson<{ of: number }>(archiveCountKey(uploadId))
  if (!count) return null
  const parts: Uint8Array[] = []
  let total = 0
  for (let part = 0; part < count.of; part++) {
    const bytes = await deps.blobs.get(archivePartKey(uploadId, part))
    if (!bytes) {
      throw new ApiError(
        409,
        'missing_part',
        `Part ${part + 1} of ${count.of} of the upload is missing: run the upload script again`
      )
    }
    total += bytes.byteLength
    parts.push(bytes)
  }
  const zip = new Uint8Array(total)
  let at = 0
  for (const bytes of parts) {
    zip.set(bytes, at)
    at += bytes.byteLength
  }
  try {
    return readZipSite(zip)
  } catch (error) {
    if (error instanceof ZipError) throw badRequest(error.message, 'invalid_zip')
    throw error
  }
}

async function requireUpload(deps: Deps, user: User, uploadId: string) {
  const upload = /^[a-z2-7]{1,64}$/.test(uploadId) ? await deps.store.getUpload(uploadId) : null
  if (
    !upload ||
    upload.email !== user.email ||
    Date.parse(upload.expiresAt) <= deps.clock.now().getTime()
  ) {
    throw notFound(
      `No open upload "${uploadId}" (uploads expire ${MCP_UPLOAD_TTL_SECONDS / 60} minutes after fling_upload_begin). Start again with fling_upload_begin.`
    )
  }
  return upload
}

export async function uploadFile(
  deps: Deps,
  user: User,
  input: { uploadId: string; path: string; content: string; encoding: Encoding; append?: boolean }
) {
  const upload = await requireUpload(deps, user, input.uploadId)
  const path = normalizePath(input.path)
  // Validate base64 per chunk (cheap) so mistakes surface on the call that made them.
  if (input.encoding === 'base64') decodeContent(input.content, 'base64', path)
  const file = { uploadId: upload.id, path, encoding: input.encoding, expiresAt: upload.expiresAt }
  let part: number
  if (input.append) {
    const parts = await deps.store.appendUploadPart(file)
    if (parts === null) {
      throw badRequest(
        `"${path}" was started with a different encoding; append with the same encoding`,
        'encoding_mismatch'
      )
    }
    part = parts - 1
  } else {
    const existing = await deps.store.listUploadFiles(upload.id)
    if (existing.length >= MCP_UPLOAD_MAX_FILES && !existing.some(f => f.path === path)) {
      throw tooLarge(`Too many files in one upload (max ${MCP_UPLOAD_MAX_FILES})`)
    }
    await deps.store.putUploadFile({ ...file, parts: 1 })
    part = 0
  }
  await deps.blobs.put(
    partKey(upload.id, path, part),
    new Uint8Array(Buffer.from(input.content, 'utf8'))
  )
  return { uploadId: upload.id, path, part }
}

export async function finishUpload(
  deps: Deps,
  user: User,
  uploadId: string,
  opts: { principal: Principal; listHtml?: boolean; confirmPublicServer?: boolean }
): Promise<PublishOutcome> {
  const upload = await requireUpload(deps, user, uploadId)
  const records = await deps.store.listUploadFiles(upload.id)
  const archive = await archiveFiles(deps, upload.id)
  if (archive && records.length) {
    throw badRequest(
      'This upload has both a zip from the sandbox script and files sent with fling_upload_file: start again with one of them',
      'mixed_upload'
    )
  }
  if (!archive && records.length === 0 && !upload.remove?.length) {
    throw badRequest(
      'Nothing uploaded yet: run the script fling_upload_begin returned, or send files with fling_upload_file',
      'no_files'
    )
  }
  let total = 0
  const files =
    archive?.files ??
    (await mapLimit(records, 8, async rec => {
      const chunks: string[] = []
      for (let part = 0; part < rec.parts; part++) {
        const bytes = await deps.blobs.get(partKey(upload.id, rec.path, part))
        if (!bytes) {
          throw new ApiError(
            409,
            'missing_part',
            `Part ${part + 1} of "${rec.path}" is missing; send the file again`
          )
        }
        chunks.push(Buffer.from(bytes).toString('utf8'))
      }
      const decoded = decodeContent(chunks.join(''), rec.encoding, rec.path)
      total += decoded.byteLength
      if (total > MAX_DEPLOY_BYTES) {
        throw tooLarge(`The site is larger than ${MAX_DEPLOY_BYTES / 1024 / 1024} MB`)
      }
      return { path: rec.path, bytes: decoded }
    }))
  const outcome = await publishFiles(deps, user, upload.name, files, {
    principal: opts.principal,
    path: upload.path,
    ...(upload.base === undefined ? {} : { base: upload.base, remove: upload.remove }),
    spa: upload.spa,
    visibility: upload.visibility,
    access: upload.access,
    audience: upload.audience,
    listHtml: opts.listHtml,
    ...(opts.confirmPublicServer ? { confirmPublicServer: true } : {}),
  })
  if (outcome.kind === 'published' && archive?.skippedDotfiles.length) {
    outcome.warnings.push(
      `Left out of the zip (Fling never publishes dotfiles): ${archive.skippedDotfiles.join(', ')}`
    )
  }
  // Keep the staged upload when the user still has to decide about the index page.
  if (outcome.kind === 'published') {
    await deps.blobs.deletePrefix(uploadPrefix(upload.id))
    await deps.store.deleteUpload(upload.id)
  }
  return outcome
}
