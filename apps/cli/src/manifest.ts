/**
 * Build a deploy manifest from a folder: walk it, hash every file (sha256, streamed), guess content
 * types, and enforce the shared limits before anything is sent to the server.
 *
 * Never flung (no flag or option changes this): dotfiles and dot-directories, gitignored files
 * (see gitignore.ts), and `node_modules`; anything matched by a root `.flingignore` (gitignore
 * syntax) is skipped too. Skipped dotfiles and gitignored files are reported in `skipped`.
 *
 * Refused outright (a CliError, nothing is uploaded): secret files by name (`server.key`,
 * `id_rsa`, `credentials.json`… — isSecretPath) and files whose contents contain secrets
 * (scanForSecrets: private keys, cloud / API tokens…). The API checks the same again — this is the
 * early, friendly half; the server is the guarantee.
 *
 * Symlinks are followed only when their real target is inside the folder; a link pointing outside
 * is skipped with a warning (and directory cycles are never re-entered).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  describeSecretFindings,
  extractHtmlTitle,
  isHtmlPath,
  isScannablePath,
  isSecretPath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PATH_LENGTH,
  type Manifest,
  NEVER_PUBLISHED_NOTE,
  renderHtmlListing,
  SECRET_SCAN_MAX_FILE_BYTES,
  type SecretFinding,
  scanBytesForSecrets,
} from '@fling/shared'
import ignore, { type Ignore } from 'ignore'
import mime from 'mime'
import { CliError } from './errors.ts'
import { loadGitIgnore } from './gitignore.ts'
import { formatBytes } from './utils/output.ts'

export const IGNORE_FILE = '.flingignore'
export const NO_INDEX_WARNING = 'No index.html at the top of the folder — the site root will 404.'
const ALWAYS_SKIP = new Set(['node_modules'])
/** Dot entries skipped without being reported (nobody expects them on a site). */
const QUIET_DOT_ENTRIES = new Set(['.git', '.DS_Store'])
/** How many skipped names to show in messages. */
export const SKIPPED_SHOWN = 5
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

export interface Skipped {
  /** dotfiles and dot-directories (directories end with `/`) */
  dotfiles: string[]
  /** gitignored files and directories (directories end with `/`) */
  gitignored: string[]
}

export interface LocalManifest {
  root: string
  files: LocalFile[]
  totalBytes: number
  warnings: string[]
  skipped: Skipped
}

/** Secret files (by name) in the folder: never flung. */
export class SecretFilesError extends CliError {
  readonly code = 'secret_file'
  constructor(readonly paths: string[]) {
    const shown = paths.slice(0, 20)
    super(
      `Not flung: ${paths.length === 1 ? 'this is a secret file' : `these are ${paths.length} secret files`} (keys, certificates, credentials): ` +
        `${shown.join(', ')}${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''}. ${NEVER_PUBLISHED_NOTE}`,
      {
        hint: `Move ${paths.length === 1 ? 'it' : 'them'} out of the folder, or add ${paths.length === 1 ? 'it' : 'them'} to ${IGNORE_FILE} if the site does not need ${paths.length === 1 ? 'it' : 'them'}.`,
      }
    )
    this.name = 'SecretFilesError'
  }
}

/** Files that contain secrets: never flung. The message names file, line and kind — never the value. */
export class SecretsFoundError extends CliError {
  readonly code = 'secret_detected'
  constructor(readonly findings: SecretFinding[]) {
    const files = new Set(findings.map(f => f.path)).size
    super(
      `Not flung: found secrets in ${files} file${files === 1 ? '' : 's'}:\n  ${describeSecretFindings(findings).join('\n  ')}\n${NEVER_PUBLISHED_NOTE}`,
      {
        hint: `Remove the secret (and rotate it if it was ever shared), or add the file to ${IGNORE_FILE} if the site does not need it.`,
      }
    )
    this.name = 'SecretsFoundError'
  }
}

/** "Skipped 3 dotfiles (.env, .npmrc, .vscode/)" lines for what the walker left out; [] if none. */
export function describeSkipped(skipped: Skipped): string[] {
  const line = (n: number, what: string, names: string[]) =>
    `Skipped ${n} ${what}${n === 1 ? '' : 's'} (${names.slice(0, SKIPPED_SHOWN).join(', ')}${n > SKIPPED_SHOWN ? ', …' : ''}) — ${what}s are never flung`
  const lines: string[] = []
  if (skipped.dotfiles.length)
    lines.push(line(skipped.dotfiles.length, 'dotfile', skipped.dotfiles))
  if (skipped.gitignored.length)
    lines.push(line(skipped.gitignored.length, 'gitignored file', skipped.gitignored))
  return lines
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
  const gitIgnore = await loadGitIgnore(root)
  const warnings: string[] = []
  const skipped: Skipped = { dotfiles: [], gitignored: [] }
  const secretFiles: string[] = []
  const found: { path: string; absPath: string; size: number }[] = []
  const visitedDirs = new Set<string>([root])

  const inside = (real: string) => real === root || real.startsWith(root + sep)

  async function walk(realDir: string, relDir: string): Promise<void> {
    await gitIgnore.enterDir(realDir, relDir)
    const entries = await readdir(realDir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.name.startsWith('.')) {
        if (!QUIET_DOT_ENTRIES.has(entry.name))
          skipped.dotfiles.push(entry.isDirectory() ? `${rel}/` : rel)
        continue
      }
      if (ALWAYS_SKIP.has(entry.name)) continue
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
        // A link must not smuggle in what is never flung under another name.
        const targetRel = relative(root, target).split(sep).join('/')
        if (targetRel.split('/').some(seg => seg.startsWith('.'))) {
          skipped.dotfiles.push(rel)
          continue
        }
        if (targetRel && gitIgnore.ignores(targetRel, info.isDirectory())) {
          skipped.gitignored.push(rel)
          continue
        }
        abs = target
        isDir = info.isDirectory()
        isFile = info.isFile()
      }
      if (isDir) {
        if (gitIgnore.ignores(rel, true)) {
          skipped.gitignored.push(`${rel}/`)
          continue
        }
        if (ig.ignores(`${rel}/`)) continue
        if (visitedDirs.has(abs)) continue
        visitedDirs.add(abs)
        await walk(abs, rel)
      } else if (isFile) {
        if (gitIgnore.ignores(rel, false)) {
          skipped.gitignored.push(rel)
          continue
        }
        if (ig.ignores(rel)) continue
        if (isSecretPath(rel)) {
          secretFiles.push(rel)
          continue
        }
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

  if (secretFiles.length > 0) throw new SecretFilesError(secretFiles)
  if (found.length === 0) {
    throw new CliError(
      `Nothing to deploy: ${dir} has no files (dotfiles, gitignored files and node_modules are skipped)`
    )
  }
  checkLimits(found, dir)
  if (!found.some(f => f.path === 'index.html')) {
    warnings.push(NO_INDEX_WARNING)
  }

  const findings: SecretFinding[] = []
  const files = await mapLimit(found, 16, async f => {
    let sha256: string
    if (f.size <= SECRET_SCAN_MAX_FILE_BYTES && isScannablePath(f.path)) {
      // Small enough to read whole: hash and scan for secrets in one read.
      const bytes = await readFile(f.absPath)
      sha256 = createHash('sha256').update(bytes).digest('hex')
      findings.push(...scanBytesForSecrets(bytes, f.path))
    } else sha256 = await sha256File(f.absPath)
    return { ...f, sha256, contentType: contentTypeFor(f.path) }
  })
  if (findings.length > 0) {
    throw new SecretsFoundError(
      findings.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.rule.localeCompare(b.rule)
      )
    )
  }
  return { root, files, totalBytes: files.reduce((n, f) => n + f.size, 0), warnings, skipped }
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
