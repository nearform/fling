import { z } from 'zod'
import { MAX_DEPLOY_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_PATH_LENGTH } from './limits.ts'
import { isSecretPath } from './secrets.ts'

/**
 * A site-relative POSIX path: no leading slash, no backslashes, no empty segments, and no segment
 * starting with `.` — so no `.`/`..`, and never a dotfile or dot-directory (`.env`, `.dev.vars`,
 * `.git/…`, `.well-known/…`). Fling never publishes dotfiles; there is no override.
 */
export function isValidSitePath(path: string): boolean {
  if (!path || path.length > MAX_PATH_LENGTH) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every(seg => seg !== '' && !seg.startsWith('.'))
}

export const ManifestFileSchema = z.object({
  path: z
    .string()
    .refine(isValidSitePath, 'invalid path (dotfiles are never published)')
    .refine(p => !isSecretPath(p), 'secret file (keys, certificates, credentials) never published'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  contentType: z.string().min(1).max(255),
})
export type ManifestFile = z.infer<typeof ManifestFileSchema>

export const ManifestSchema = z
  .object({ files: z.array(ManifestFileSchema).min(1).max(MAX_FILES) })
  .refine(m => new Set(m.files.map(f => f.path)).size === m.files.length, 'duplicate paths')
  .refine(m => m.files.reduce((n, f) => n + f.size, 0) <= MAX_DEPLOY_BYTES, 'deploy too large')
export type Manifest = z.infer<typeof ManifestSchema>

/**
 * The canonical string a version id is hashed from: one `path\0sha256\n` line per
 * file, sorted by path. Content type is deliberately excluded so the same bytes
 * always map to the same version.
 */
export function canonicalManifest(files: readonly Pick<ManifestFile, 'path' | 'sha256'>[]): string {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(f => `${f.path}\0${f.sha256}\n`)
    .join('')
}

export const VERSION_ID_LENGTH = 16
