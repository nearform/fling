/**
 * What can be flung, turned into a folder to deploy:
 *
 * - a folder: as is;
 * - a single .html/.htm file: copied to a temp folder as `index.html`;
 * - a .zip: extracted to a temp folder (zip-slip safe, within the shared size limits), skipping
 *   `__MACOSX/`, OS junk and dotfiles (reported in `skippedDotfiles`, except `.DS_Store` / `._*`),
 *   and unwrapping a single top-level folder;
 * - a single Markdown file (.md, .markdown) on a Fling that renders Markdown (`markdown`
 *   capability): copied to a temp folder alone, so its rendered page becomes the home page;
 * - any other single file (.svg, .pdf, .png, .md without that capability…): copied to a temp folder
 *   next to a generated minimal `index.html` that shows or links it.
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
  isMarkdownPath,
  isSecretPath,
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  NEVER_PUBLISHED_NOTE,
} from '@fling/shared'
import { readZipSite, ZipError, type ZipSite } from '@fling/shared/zip'
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

/**
 * `markdown`: the Fling renders Markdown, so a single Markdown file needs no generated page (the
 * server makes its rendered page the home page).
 */
export async function prepareInput(
  path: string,
  opts: { markdown?: boolean } = {}
): Promise<PreparedInput> {
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
      if (!(opts.markdown && isMarkdownPath(name))) {
        await writeFile(join(tmp.dir, 'index.html'), wrapperPage(name))
      }
    }
  } catch (error) {
    await tmp.cleanup()
    throw error
  }
  return { kind, source: path, dir: tmp.dir, defaultName, skippedDotfiles, cleanup: tmp.cleanup }
}

// ---- zip -----------------------------------------------------------------------------------

export { unwrapSingleFolder, zipDotEntry, zipEntryPath } from '@fling/shared/zip'

/**
 * Extract a zip into `dest` (the rules are `readZipSite`'s, @fling/shared/zip). Throws on unsafe
 * names or over-limit sizes. Dot entries that were left out are added to `skippedDotfiles`.
 */
export async function extractZip(
  data: Uint8Array,
  dest: string,
  skippedDotfiles: string[] = []
): Promise<string[]> {
  let site: ZipSite
  try {
    site = readZipSite(data)
  } catch (error) {
    if (error instanceof ZipError) throw new CliError(error.message)
    throw error
  }
  for (const dot of site.skippedDotfiles)
    if (!skippedDotfiles.includes(dot)) skippedDotfiles.push(dot)
  const root = resolve(dest)
  for (const { path, bytes } of site.files) {
    const target = resolve(root, ...path.split('/'))
    if (!target.startsWith(root + sep)) throw new CliError(`Unsafe path in the zip: ${path}`)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, bytes)
  }
  return site.files.map(f => f.path)
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
