/**
 * `fling_read_files` (both MCP servers): a pulled version's files inline, for an agent that can't
 * download them (a sandboxed one, on claude.ai). Each call returns files up to MCP_READ_MAX_BYTES
 * and a cursor for the rest, in path order. Text comes back as utf8, anything else base64. A file
 * bigger than the budget comes back without its content (`tooLarge`): only a download
 * (`fling pull`) gets it. Browser-safe.
 */
import { isScannablePath, looksBinary } from './secrets.ts'

/**
 * fling_read_files: file bytes per call. The contents go out twice (the text the model reads and
 * the structured result), base64 adds a third, and a Lambda response stops at 6 MB.
 */
export const MCP_READ_MAX_BYTES = 1.5 * 1024 * 1024

export interface ReadableFile {
  path: string
  size: number
}

export interface FilesPage<T extends ReadableFile> {
  /** the files whose content this call returns */
  page: T[]
  /** files in this stretch bigger than the whole budget: listed without content */
  tooLarge: T[]
  /** `paths` asked for that the version doesn't have */
  missing: string[]
  /** pass back as `cursor` for the next files; absent once there are none */
  nextCursor?: string
}

/**
 * The next page of `files` (sorted by path): those named in `paths` (all when absent), from
 * `cursor` on, as many as fit in `budget` bytes (always at least one, unless it is too large).
 */
export function pageOfFiles<T extends ReadableFile>(
  files: readonly T[],
  opts: { paths?: readonly string[]; cursor?: string; budget: number }
): FilesPage<T> {
  const wanted = opts.paths ? new Set(opts.paths) : null
  const selected = wanted ? files.filter(f => wanted.has(f.path)) : [...files]
  const found = new Set(selected.map(f => f.path))
  const missing = opts.paths ? opts.paths.filter(p => !found.has(p)) : []
  const start = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0)
  const page: T[] = []
  const tooLarge: T[] = []
  let used = 0
  for (let i = start; i < selected.length; i++) {
    const file = selected[i] as T
    if (file.size > opts.budget) {
      tooLarge.push(file)
      continue
    }
    if (used + file.size > opts.budget) return { page, tooLarge, missing, nextCursor: String(i) }
    page.push(file)
    used += file.size
  }
  return { page, tooLarge, missing }
}

/** utf8 for text that decodes as UTF-8, base64 for anything else. */
export function encodeForAgent(
  path: string,
  bytes: Uint8Array
): { encoding: 'utf8' | 'base64'; content: string } {
  if (isScannablePath(path) && !looksBinary(bytes)) {
    try {
      return { encoding: 'utf8', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      // not UTF-8: base64 below
    }
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { encoding: 'base64', content: btoa(binary) }
}

/** One file of a fling_read_files result. */
export interface ReadFile {
  path: string
  size: number
  contentType: string
  sha256: string
  encoding?: 'utf8' | 'base64'
  content?: string
  /** bigger than one call returns: no content */
  tooLarge?: true
}

/** The text of a fling_read_files result (both servers); the structured data has the contents. */
export function describeReadFiles(
  name: string,
  result: {
    versionId: string
    path?: string
    files: readonly ReadFile[]
    missing: string[]
    nextCursor?: string
  }
): string {
  const read = result.files.filter(f => !f.tooLarge)
  const big = result.files.filter(f => f.tooLarge)
  const of = result.path === undefined ? name : `the Path /${result.path}/ of ${name}`
  const lines = [
    `${read.length} file(s) of ${of}, version ${result.versionId}${result.path === undefined ? '' : ' (paths within the Path)'}: ${read.map(f => f.path).join(', ') || '(none)'}.`,
  ]
  if (big.length) {
    lines.push(
      `Too large to return here (left out; they stay as they are when you publish on this base): ${big.map(f => f.path).join(', ')}.`
    )
  }
  if (result.missing.length) lines.push(`Not in this version: ${result.missing.join(', ')}.`)
  if (result.nextCursor) {
    lines.push(
      `More files: call fling_read_files again with cursor "${result.nextCursor}" (or name the files you need in \`paths\`).`
    )
  }
  lines.push(
    result.path === undefined
      ? `To change the site, call fling_publish with base "${result.versionId}" and only the files you changed or added (and \`remove\` for files to delete): every other file is kept.`
      : `To change the Path, call fling_publish with path "${result.path}", base "${result.versionId}" and only the files you changed or added (and \`remove\` for files to delete), named within the Path: every other file of it is kept.`
  )
  return lines.join('\n')
}
