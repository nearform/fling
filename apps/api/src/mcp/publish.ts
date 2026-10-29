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
 */
import { createHash } from 'node:crypto'
import {
  type AccessLevel,
  extractHtmlTitle,
  isHtmlPath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  MCP_UPLOAD_MAX_FILES,
  MCP_UPLOAD_TTL_SECONDS,
  renderHtmlListing,
  type Site,
  type Visibility,
} from '@fling/shared'
import { uploadPrefix } from '../blobs/types.ts'
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
      /** this publish made the site live for the first time */
      first?: boolean
      fileCount: number
      totalBytes: number
      generatedIndex: boolean
      warnings: string[]
      /** every path in the published version (picks the URL the readiness wait polls) */
      paths: string[]
    }

const tooLarge = (message: string) => new ApiError(413, 'too_large', message)

/**
 * `./a/b.html` or `/a/b.html` → `a/b.html`; dotfiles / secret files → 400 `dotfile` /
 * `secret_file`; anything else invalid → 400.
 */
export function normalizePath(raw: string): string {
  const path = raw
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
  if (path && !path.includes('\\') && !path.split('/').some(s => s === '..' || s === '.'))
    assertPublishablePaths([path])
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

  const published = await publishBytes(
    deps,
    user,
    name,
    [...files].map(([path, bytes]) => ({ path, bytes })),
    {
      principal: opts.principal,
      spa: opts.spa,
      visibility: opts.visibility,
      access: opts.access,
      audience: opts.audience,
    }
  )
  return {
    kind: 'published',
    ...published,
    fileCount: files.size,
    totalBytes: [...files.values()].reduce((n, b) => n + b.byteLength, 0),
    generatedIndex,
    warnings,
    paths: [...files.keys()],
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
  opts: { spa?: boolean; visibility?: Visibility } & AccessOptions
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
    ...(opts.access ? { access: opts.access } : {}),
    ...(opts.audience ? { audience: opts.audience } : {}),
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
  opts: { principal: Principal; listHtml?: boolean }
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
  })
  const outcome = await publishFiles(deps, user, upload.name, files, {
    principal: opts.principal,
    spa: upload.spa,
    visibility: upload.visibility,
    access: upload.access,
    audience: upload.audience,
    listHtml: opts.listHtml,
  })
  // Keep the staged upload when the user still has to decide about the index page.
  if (outcome.kind === 'published') {
    await deps.blobs.deletePrefix(uploadPrefix(upload.id))
    await deps.store.deleteUpload(upload.id)
  }
  return outcome
}
