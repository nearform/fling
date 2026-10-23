/**
 * Server-side publishing for the remote MCP connector: the content arrives inline (fling_publish)
 * or staged in the bucket (fling_upload_*), so instead of presigning PUTs we hash it, run the
 * normal deploy (idempotent: unchanged / repointed), write the objects ourselves and finalize.
 *
 * Chunked uploads: fling_upload_begin stores an UploadRecord (1 h); every fling_upload_file call
 * writes its content, as sent (still encoded), to `uploads/<id>/<sha(path)>/<part>` and bumps the
 * file's part count in the store; fling_upload_finish concatenates and decodes each file, then
 * publishes like fling_publish and deletes the staging area.
 */
import { createHash } from 'node:crypto'
import {
  extractHtmlTitle,
  isHtmlPath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  type ManifestFile,
  MCP_UPLOAD_MAX_FILES,
  MCP_UPLOAD_TTL_SECONDS,
  renderHtmlListing,
  type Site,
  siteObjectKey,
  type Visibility,
} from '@fling/shared'
import { mapLimit } from '../lib/concurrency.ts'
import { ApiError, badRequest, notFound } from '../lib/errors.ts'
import { newId } from '../lib/ids.ts'
import { contentTypeFor } from '../lib/mime.ts'
import * as sites from '../sites.ts'
import { uploadPrefix } from '../storage/types.ts'
import type { UploadRecord, User } from '../store/types.ts'
import type { Deps } from '../types.ts'

export type Encoding = 'utf8' | 'base64'

export interface InlineFile {
  path: string
  bytes: Uint8Array
}

export interface PublishOptions {
  spa?: boolean
  visibility?: Visibility
  /** no root index.html: true → generate a listing page; false → publish anyway; undefined → ask */
  listHtml?: boolean
}

export type PublishOutcome =
  | { kind: 'needs_decision'; htmlPages: string[]; fileCount: number }
  | {
      kind: 'published'
      status: 'live' | 'unchanged' | 'repointed'
      versionId: string
      site: Site
      fileCount: number
      totalBytes: number
      generatedIndex: boolean
      warnings: string[]
      /** every path in the published version (picks the URL the readiness wait polls) */
      paths: string[]
    }

const tooLarge = (message: string) => new ApiError(413, 'too_large', message)

/** `./a/b.html` or `/a/b.html` → `a/b.html`; anything else invalid → 400. */
export function normalizePath(raw: string): string {
  const path = raw
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
  if (!isValidSitePath(path)) {
    throw badRequest(
      `Invalid file path "${raw}": use a site-relative path with forward slashes, like "index.html" or "img/logo.png"`,
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

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function publishFiles(
  deps: Deps,
  user: User,
  name: string,
  input: InlineFile[],
  opts: PublishOptions
): Promise<PublishOutcome> {
  if (input.length === 0) throw badRequest('No files to publish', 'no_files')
  const files = new Map<string, Uint8Array>()
  for (const f of input) {
    const path = normalizePath(f.path)
    if (files.has(path)) throw badRequest(`"${path}" is listed twice`, 'duplicate_path')
    if (f.bytes.byteLength > MAX_FILE_BYTES) {
      throw tooLarge(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`)
    }
    files.set(path, f.bytes)
  }

  const warnings: string[] = []
  let generatedIndex = false
  if (!files.has('index.html')) {
    const htmlPages = [...files.keys()].filter(isHtmlPath).sort()
    if (htmlPages.length === 0) {
      warnings.push(
        'No index.html at the root and no HTML pages: the site URL will 404; link to the files by path.'
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
      warnings.push(
        'No index.html at the root: the site URL will 404; the pages work at their own paths.'
      )
    }
  }
  if (opts.spa && !files.has('index.html')) {
    warnings.push('spa is on but there is no index.html to fall back to.')
  }

  if (files.size > MAX_FILES) throw tooLarge(`Too many files (max ${MAX_FILES})`)
  const manifest: ManifestFile[] = [...files].map(([path, bytes]) => ({
    path,
    sha256: sha256(bytes),
    size: bytes.byteLength,
    contentType: contentTypeFor(path),
  }))
  const totalBytes = manifest.reduce((n, f) => n + f.size, 0)
  if (totalBytes > MAX_DEPLOY_BYTES) {
    throw tooLarge(`The site is larger than ${MAX_DEPLOY_BYTES / 1024 / 1024} MB`)
  }

  const res = await sites.deploy(
    deps,
    user,
    name,
    { manifest: { files: manifest }, spa: opts.spa, visibility: opts.visibility },
    { presign: false }
  )
  const common = {
    fileCount: files.size,
    totalBytes,
    generatedIndex,
    warnings,
    paths: [...files.keys()],
  }
  if (res.status !== 'upload') {
    return {
      kind: 'published',
      status: res.status,
      versionId: res.versionId,
      site: res.site,
      ...common,
    }
  }
  const site = await sites.requireSite(deps, user, name)
  await mapLimit(manifest, 16, async f => {
    await deps.storage.put(
      siteObjectKey(site.id, res.versionId, f.path),
      files.get(f.path) as Uint8Array,
      { contentType: f.contentType, cacheControl: sites.cacheControlFor(f.path) }
    )
  })
  const fin = await sites.finalize(deps, user, name, res.versionId)
  return { kind: 'published', status: 'live', versionId: fin.versionId, site: fin.site, ...common }
}

// --- chunked uploads ----------------------------------------------------------------------------

const pathHash = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 24)
const partKey = (uploadId: string, path: string, part: number) =>
  `${uploadPrefix(uploadId)}${pathHash(path)}/${part}`

export async function beginUpload(
  deps: Deps,
  user: User,
  name: string,
  opts: { spa?: boolean; visibility?: Visibility }
): Promise<UploadRecord> {
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
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MCP_UPLOAD_TTL_SECONDS * 1000).toISOString(),
  }
  await deps.store.putUpload(upload)
  return upload
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
  await deps.storage.put(
    partKey(upload.id, path, part),
    new Uint8Array(Buffer.from(input.content, 'utf8'))
  )
  return { uploadId: upload.id, path, part }
}

export async function finishUpload(
  deps: Deps,
  user: User,
  uploadId: string,
  opts: { listHtml?: boolean }
): Promise<PublishOutcome> {
  const upload = await requireUpload(deps, user, uploadId)
  const records = await deps.store.listUploadFiles(upload.id)
  if (records.length === 0) {
    throw badRequest('Nothing uploaded yet: send files with fling_upload_file first', 'no_files')
  }
  let total = 0
  const files = await mapLimit(records, 8, async rec => {
    const chunks: string[] = []
    for (let part = 0; part < rec.parts; part++) {
      const bytes = await deps.storage.get(partKey(upload.id, rec.path, part))
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
  })
  const outcome = await publishFiles(deps, user, upload.name, files, {
    spa: upload.spa,
    visibility: upload.visibility,
    listHtml: opts.listHtml,
  })
  // Keep the staged upload when the user still has to decide about the index page.
  if (outcome.kind === 'published') {
    await deps.storage.deletePrefix(uploadPrefix(upload.id))
    await deps.store.deleteUpload(upload.id)
  }
  return outcome
}
