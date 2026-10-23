/**
 * Build a deploy manifest from a folder: walk it, hash every file (sha256, streamed), guess content
 * types, and enforce the shared limits before anything is sent to the server.
 *
 * Skipped: dotfiles and dot-directories, `node_modules`, anything matched by a root `.flingignore`
 * (gitignore syntax). Symlinks are followed only when their real target is inside the folder; a
 * link pointing outside is skipped with a warning (and directory cycles are never re-entered).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  extractHtmlTitle,
  isHtmlPath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PATH_LENGTH,
  type Manifest,
  renderHtmlListing,
} from '@fling/shared'
import ignore, { type Ignore } from 'ignore'
import mime from 'mime'
import { CliError } from './errors.ts'
import { formatBytes } from './utils/output.ts'

export const IGNORE_FILE = '.flingignore'
export const NO_INDEX_WARNING = 'No index.html at the top of the folder — the site root will 404.'
const ALWAYS_SKIP = new Set(['node_modules'])
const CHARSET_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'application/xml',
  'image/svg+xml',
])

export interface LocalFile {
  /** site-relative POSIX path */
  path: string
  /** absolute path on disk ('' for generated files, which carry `content`) */
  absPath: string
  /** Generated in memory (e.g. the HTML listing): uploaded from here, never written to disk. */
  content?: Buffer
  sha256: string
  size: number
  contentType: string
}

export interface LocalManifest {
  root: string
  files: LocalFile[]
  totalBytes: number
  warnings: string[]
}

export function contentTypeFor(path: string): string {
  const type = mime.getType(path) ?? 'application/octet-stream'
  return type.startsWith('text/') || CHARSET_TYPES.has(type) ? `${type}; charset=utf-8` : type
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The manifest body the API expects (no local paths). */
export function toManifest(local: LocalManifest): Manifest {
  return {
    files: local.files.map(({ path, sha256, size, contentType }) => ({
      path,
      sha256,
      size,
      contentType,
    })),
  }
}

export async function buildManifest(dir: string): Promise<LocalManifest> {
  let root: string
  try {
    root = await realpath(dir)
  } catch {
    throw new CliError(`Folder not found: ${dir}`)
  }
  if (!(await stat(root)).isDirectory()) throw new CliError(`Not a folder: ${dir}`)

  const ig = await loadIgnore(root)
  const warnings: string[] = []
  const found: { path: string; absPath: string; size: number }[] = []
  const visitedDirs = new Set<string>([root])

  const inside = (real: string) => real === root || real.startsWith(root + sep)

  async function walk(realDir: string, relDir: string): Promise<void> {
    const entries = await readdir(realDir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ALWAYS_SKIP.has(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      let abs = join(realDir, entry.name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        let target: string
        try {
          target = await realpath(abs)
        } catch {
          warnings.push(`Skipped broken symlink: ${rel}`)
          continue
        }
        if (!inside(target)) {
          warnings.push(`Skipped symlink pointing outside the folder: ${rel}`)
          continue
        }
        const info = await stat(target)
        abs = target
        isDir = info.isDirectory()
        isFile = info.isFile()
      }
      if (isDir) {
        if (ig.ignores(`${rel}/`)) continue
        if (visitedDirs.has(abs)) continue
        visitedDirs.add(abs)
        await walk(abs, rel)
      } else if (isFile) {
        if (ig.ignores(rel)) continue
        const { size } = await stat(abs)
        found.push({ path: rel, absPath: abs, size })
        if (found.length > MAX_FILES) {
          throw new CliError(`Too many files: more than ${MAX_FILES} in ${dir}`, {
            hint: `Add a ${IGNORE_FILE} to skip what the site does not need.`,
          })
        }
      }
    }
  }
  await walk(root, '')

  if (found.length === 0) {
    throw new CliError(
      `Nothing to deploy: ${dir} has no files (dotfiles and node_modules are skipped)`
    )
  }
  checkLimits(found, dir)
  if (!found.some(f => f.path === 'index.html')) {
    warnings.push(NO_INDEX_WARNING)
  }

  const files = await mapLimit(found, 16, async f => ({
    ...f,
    sha256: await sha256File(f.absPath),
    contentType: contentTypeFor(f.path),
  }))
  return { root, files, totalBytes: files.reduce((n, f) => n + f.size, 0), warnings }
}

function checkLimits(files: { path: string; size: number }[], dir: string): void {
  for (const f of files) {
    if (f.path.length > MAX_PATH_LENGTH) {
      throw new CliError(
        `Path too long (max ${MAX_PATH_LENGTH} characters): ${f.path.slice(0, 80)}…`
      )
    }
    if (!isValidSitePath(f.path)) throw new CliError(`Unsupported file path: ${f.path}`)
    if (f.size > MAX_FILE_BYTES) {
      throw new CliError(
        `${f.path} is ${formatBytes(f.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file`,
        { hint: `Add it to ${IGNORE_FILE} if the site does not need it.` }
      )
    }
  }
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > MAX_DEPLOY_BYTES) {
    throw new CliError(
      `${dir} is ${formatBytes(total)}; the limit is ${formatBytes(MAX_DEPLOY_BYTES)} per deploy`,
      { hint: `Add a ${IGNORE_FILE} to skip what the site does not need.` }
    )
  }
}

export const hasRootIndex = (local: Pick<LocalManifest, 'files'>) =>
  local.files.some(f => f.path === 'index.html')

export const htmlPages = (local: Pick<LocalManifest, 'files'>) =>
  local.files.filter(f => isHtmlPath(f.path) && f.path !== 'index.html')

const TITLE_BYTES = 65536

async function readHead(file: LocalFile): Promise<string> {
  if (file.content) return file.content.subarray(0, TITLE_BYTES).toString('utf8')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of createReadStream(file.absPath, { end: TITLE_BYTES - 1 })) {
    chunks.push(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Add a generated `index.html` listing every HTML page (titles from their `<title>`), built in
 * memory: the user's folder is never written to. Same pages and titles → same bytes, so a
 * re-deploy stays `unchanged`.
 */
export async function withHtmlListing(
  local: LocalManifest,
  siteName: string
): Promise<LocalManifest> {
  const pages = htmlPages(local)
  const entries = await mapLimit(pages, 16, async f => ({
    path: f.path,
    title: extractHtmlTitle(await readHead(f)),
  }))
  const content = Buffer.from(renderHtmlListing(siteName, entries), 'utf8')
  const index: LocalFile = {
    path: 'index.html',
    absPath: '',
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length,
    contentType: contentTypeFor('index.html'),
  }
  const files = [...local.files.filter(f => f.path !== 'index.html'), index].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return {
    ...local,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    warnings: local.warnings.filter(w => w !== NO_INDEX_WARNING),
  }
}

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore()
  try {
    ig.add(await readFile(join(root, IGNORE_FILE), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return ig
}

/** `Promise.all(items.map(fn))` with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
