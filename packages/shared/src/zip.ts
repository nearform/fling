/**
 * A zip of a site, read into its files: the one set of rules for every zip Fling takes, the CLI's
 * (`fling deploy site.zip`) and the core's (a sandbox upload, mcp/publish.ts).
 *
 * - Zip-slip safe: an absolute name, a drive letter, `..` or a NUL refuses the whole zip.
 * - Within the shared limits (`MAX_FILE_BYTES` per file, `MAX_DEPLOY_BYTES` and `MAX_FILES` in
 *   all), checked against the sizes the zip declares before anything is inflated and again on the
 *   bytes it inflates to, so a zip bomb stops early.
 * - Skips folders, `__MACOSX/`, OS junk (`Thumbs.db`, `desktop.ini`) and dotfiles. Dot entries
 *   worth telling the user about come back in `skippedDotfiles`; `.DS_Store`, `._*` and `.git/`
 *   are skipped silently.
 * - Unwraps a single top-level folder (`site/index.html` → `index.html`), repeatedly.
 *
 * Imported as `@fling/shared/zip`, not from the package index, so only what reads zips bundles
 * fflate.
 */
import { unzipSync } from 'fflate'
import { MAX_DEPLOY_BYTES, MAX_FILE_BYTES, MAX_FILES } from './limits.ts'

/** Why a zip can't be read as a site; the message is said to the user as is. */
export class ZipError extends Error {
  override name = 'ZipError'
}

export interface ZipSite {
  /** the site's files, by site path, sorted */
  files: { path: string; bytes: Uint8Array }[]
  /** dot entries left out (once per file / dot-folder) */
  skippedDotfiles: string[]
}

const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini'])

const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`

/**
 * The site path for a zip entry name, `null` to skip it (folders, `__MACOSX/`, dotfiles, OS junk),
 * or `'unsafe'` for names that would escape the folder (absolute, drive letters, `..`).
 */
export function zipEntryPath(name: string): string | null | 'unsafe' {
  const normalised = name.replace(/\\/g, '/')
  if (normalised.includes('\0')) return 'unsafe'
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return 'unsafe'
  const segments = normalised.split('/').filter(s => s !== '' && s !== '.')
  if (segments.includes('..')) return 'unsafe'
  if (normalised.endsWith('/') || segments.length === 0) return null
  if (segments[0] === '__MACOSX') return null
  if (segments.some(s => s.startsWith('.'))) return null
  if (JUNK_FILES.has((segments.at(-1) ?? '').toLowerCase())) return null
  return segments.join('/')
}

/** Drop a single top-level folder shared by every path (repeatedly: `a/b/index.html` → `index.html`). */
export function unwrapSingleFolder(paths: string[]): string[] {
  let current = paths
  for (;;) {
    const first = current[0]?.split('/')[0]
    if (!first || !current.every(p => p.includes('/') && p.split('/')[0] === first)) return current
    current = current.map(p => p.slice(first.length + 1))
  }
}

/**
 * A dot entry in a zip worth telling the user about (`.env`, `site/.npmrc`, `.vscode/`), or null.
 * `.git/` and macOS junk (`.DS_Store`, `._*`, anything under `__MACOSX/`) are skipped silently.
 */
export function zipDotEntry(name: string): string | null {
  const segments = name
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s !== '' && s !== '.')
  if (segments[0] === '__MACOSX') return null
  const i = segments.findIndex(s => s.startsWith('.'))
  if (i === -1) return null
  const seg = segments[i] as string
  if (seg === '.DS_Store' || seg === '.git' || seg.startsWith('._')) return null
  return i < segments.length - 1 ? `${segments.slice(0, i + 1).join('/')}/` : segments.join('/')
}

/** Read a zip into the site's files (see the module comment). Throws `ZipError`. */
export function readZipSite(data: Uint8Array): ZipSite {
  const unsafe: string[] = []
  const skippedDotfiles: string[] = []
  let declared = 0
  let count = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(data, {
      filter: file => {
        const path = zipEntryPath(file.name)
        if (path === 'unsafe') {
          unsafe.push(file.name)
          return false
        }
        if (path === null) {
          const dot = zipDotEntry(file.name)
          if (dot && !skippedDotfiles.includes(dot)) skippedDotfiles.push(dot)
          return false
        }
        count++
        declared += file.originalSize
        if (file.originalSize > MAX_FILE_BYTES)
          throw new ZipError(
            `${path} in the zip is ${formatBytes(file.originalSize)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file`
          )
        if (declared > MAX_DEPLOY_BYTES)
          throw new ZipError(
            `The zip expands to more than ${formatBytes(MAX_DEPLOY_BYTES)}, the limit per deploy`
          )
        if (count > MAX_FILES) throw new ZipError(`The zip has more than ${MAX_FILES} files`)
        return true
      },
    })
  } catch (error) {
    if (error instanceof ZipError) throw error
    throw new ZipError(`Could not read the zip: ${(error as Error).message}`)
  }
  if (unsafe.length)
    throw new ZipError(
      `Refusing to extract the zip: it has paths that escape its folder (${unsafe.slice(0, 3).join(', ')})`
    )

  const names = Object.keys(entries)
  if (names.length === 0) throw new ZipError('The zip has no files to fling')
  const unwrapped = unwrapSingleFolder(names.map(n => zipEntryPath(n) as string))
  let total = 0
  const files = names.map((name, i) => {
    const bytes = entries[name] as Uint8Array
    total += bytes.length
    // The declared sizes can lie: hold the inflated bytes to the same limits.
    if (bytes.length > MAX_FILE_BYTES || total > MAX_DEPLOY_BYTES)
      throw new ZipError('The zip expands to more than the limits allow')
    return { path: unwrapped[i] as string, bytes }
  })
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, skippedDotfiles }
}
