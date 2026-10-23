/**
 * What can be flung, turned into a folder to deploy:
 *
 * - a folder: as is;
 * - a single .html/.htm file: copied to a temp folder as `index.html`;
 * - a .zip: extracted to a temp folder (zip-slip safe, within the shared size limits), skipping
 *   `__MACOSX/`, OS junk and dotfiles (reported in `skippedDotfiles`, except `.DS_Store` / `._*`),
 *   and unwrapping a single top-level folder;
 * - any other single file (.svg, .pdf, .png, .md…): copied to a temp folder next to a generated
 *   minimal `index.html` that shows or links it.
 *
 * A single file whose name starts with `.` (`.env`) or is a secret file (`server.key`) is refused:
 * Fling never publishes those.
 *
 * Default site names: a folder uses the folder naming algorithm (naming.ts); a file uses its own
 * name without the extension or a browser's " (1)" duplicate suffix ("Pitch Deck (1).html" →
 * `pitch-deck`).
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
  isSecretPath,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  NEVER_PUBLISHED_NOTE,
} from '@fling/shared'
import { unzipSync } from 'fflate'
import { CliError } from './errors.ts'
import { SecretFilesError } from './manifest.ts'
import { defaultSiteName, fitName } from './naming.ts'
import { formatBytes } from './utils/output.ts'

export type InputKind = 'folder' | 'html' | 'zip' | 'file'

export interface PreparedInput {
  kind: InputKind
  /** What the user pointed at. */
  source: string
  /** The folder to deploy (a temp folder unless `kind` is `folder`). */
  dir: string
  defaultName: string
  /** Dotfiles left out of a zip (reported to the user; never flung). */
  skippedDotfiles: string[]
  /** Remove the temp folder (no-op for folders). */
  cleanup(): Promise<void>
}

export function inputKind(path: string, isDirectory: boolean): InputKind {
  if (isDirectory) return 'folder'
  const ext = extname(path).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.zip') return 'zip'
  return 'file'
}

/** Default site name for a single file: its name without extension or " (1)", slugified. */
export function fileSiteName(path: string): string {
  const file = basename(path.replace(/\\/g, '/'))
  const stem = file.slice(0, file.length - extname(file).length) || file
  return fitName([stem.replace(/\s*\(\d+\)$/, '')])
}

export function defaultNameFor(path: string, isDirectory: boolean): string {
  return isDirectory ? defaultSiteName(path) : fileSiteName(path)
}

async function tempFolder(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fling-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export async function prepareInput(path: string): Promise<PreparedInput> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    throw new CliError(`Not found: ${path}`)
  }
  const kind = inputKind(path, info.isDirectory())
  const defaultName = defaultNameFor(path, info.isDirectory())
  if (kind === 'folder')
    return {
      kind,
      source: path,
      dir: path,
      defaultName,
      skippedDotfiles: [],
      cleanup: async () => {},
    }
  const file = basename(path)
  if (file.startsWith('.'))
    throw new CliError(`Not flung: ${file} is a dotfile. ${NEVER_PUBLISHED_NOTE}`)
  if (kind === 'file' && isSecretPath(file)) throw new SecretFilesError([file])

  if (info.size > MAX_DEPLOY_BYTES)
    throw new CliError(
      `${basename(path)} is ${formatBytes(info.size)}; the limit is ${formatBytes(MAX_DEPLOY_BYTES)}`
    )
  const tmp = await tempFolder()
  const skippedDotfiles: string[] = []
  try {
    if (kind === 'html') {
      if (info.size > MAX_FILE_BYTES)
        throw new CliError(
          `${basename(path)} is ${formatBytes(info.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file`
        )
      await copyFile(path, join(tmp.dir, 'index.html'))
    } else if (kind === 'zip') {
      await extractZip(await readFile(path), tmp.dir, skippedDotfiles)
    } else {
      const name = basename(path)
      await copyFile(path, join(tmp.dir, name))
      await writeFile(join(tmp.dir, 'index.html'), wrapperPage(name))
    }
  } catch (error) {
    await tmp.cleanup()
    throw error
  }
  return { kind, source: path, dir: tmp.dir, defaultName, skippedDotfiles, cleanup: tmp.cleanup }
}

// ---- zip -----------------------------------------------------------------------------------

const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini'])

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

/**
 * Extract a zip into `dest` (see the module comment). Throws on unsafe names or over-limit sizes.
 * Dot entries that were left out are added to `skippedDotfiles` (once per file / dot-directory).
 */
export async function extractZip(
  data: Uint8Array,
  dest: string,
  skippedDotfiles: string[] = []
): Promise<string[]> {
  const unsafe: string[] = []
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
          throw new CliError(
            `${path} in the zip is ${formatBytes(file.originalSize)}; the limit is ${formatBytes(MAX_FILE_BYTES)} per file`
          )
        if (declared > MAX_DEPLOY_BYTES)
          throw new CliError(
            `The zip expands to more than ${formatBytes(MAX_DEPLOY_BYTES)}, the limit per deploy`
          )
        if (count > MAX_FILES) throw new CliError(`The zip has more than ${MAX_FILES} files`)
        return true
      },
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(`Could not read the zip: ${(error as Error).message}`)
  }
  if (unsafe.length)
    throw new CliError(
      `Refusing to extract the zip: it has paths that escape its folder (${unsafe.slice(0, 3).join(', ')})`
    )

  const names = Object.keys(entries)
  const paths = new Map<string, string>()
  const kept = names.map(n => zipEntryPath(n) as string)
  const unwrapped = unwrapSingleFolder(kept)
  names.forEach((n, i) => {
    paths.set(n, unwrapped[i] as string)
  })
  if (names.length === 0) throw new CliError('The zip has no files to fling')

  const root = resolve(dest)
  let total = 0
  const written: string[] = []
  for (const name of names) {
    const content = entries[name] as Uint8Array
    total += content.length
    if (content.length > MAX_FILE_BYTES || total > MAX_DEPLOY_BYTES)
      throw new CliError(`The zip expands to more than the limits allow`)
    const rel = paths.get(name) as string
    const target = resolve(root, ...rel.split('/'))
    if (!target.startsWith(root + sep)) throw new CliError(`Unsafe path in the zip: ${name}`)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
    written.push(rel)
  }
  return written.sort()
}

// ---- wrapper page for other single files -------------------------------------------------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** A minimal index.html that shows (images, PDF, video, audio) or links the file. */
export function wrapperPage(file: string): string {
  const href = escapeHtml(encodeURIComponent(file))
  const title = escapeHtml(file)
  const ext = extname(file).toLowerCase()
  let body: string
  if (/^\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/.test(ext))
    body = `<img src="${href}" alt="${title}">`
  else if (ext === '.pdf') body = `<iframe src="${href}" title="${title}"></iframe>`
  else if (/^\.(mp4|webm|mov|m4v)$/.test(ext)) body = `<video src="${href}" controls></video>`
  else if (/^\.(mp3|wav|ogg|m4a|flac)$/.test(ext)) body = `<audio src="${href}" controls></audio>`
  else body = ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; display: flex; flex-direction: column; min-height: 100vh; }
  header { padding: 12px 20px; border-bottom: 1px solid #ddd; display: flex; gap: 16px; align-items: baseline; }
  main { flex: 1; display: flex; justify-content: center; align-items: center; padding: 20px; }
  img, video { max-width: 100%; max-height: 85vh; }
  iframe { width: 100%; height: 85vh; border: 0; }
</style>
</head>
<body>
<header><strong>${title}</strong> <a href="${href}" download>Download</a> <a href="${href}">Open</a></header>
<main>${body}</main>
</body>
</html>
`
}
