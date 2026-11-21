import { z } from 'zod'
import { MAX_DEPLOY_BYTES, MAX_FILE_BYTES, MAX_FILES, MAX_PATH_BYTES } from './limits.ts'
import { isSecretPath } from './secrets.ts'
import { isStorableText, utf8Length } from './text.ts'

/**
 * The shape of a site's file path, whatever its length: site-relative POSIX, with no leading
 * slash, no backslashes, no empty segments, and no segment starting with `.` — so no `.`/`..`,
 * and never a dotfile or dot-directory (`.env`, `.dev.vars`, `.git/…`, `.well-known/…`). Fling
 * never publishes dotfiles; there is no override. A path is part of stored keys, so it is storable
 * text too (no NUL, no lone surrogate: text.ts). For a file a client receives (a pull): it says
 * the file is inside the site.
 */
export function isSitePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || !isStorableText(path)) return false
  return path.split('/').every(seg => seg !== '' && !seg.startsWith('.'))
}

/**
 * A path a deploy may upload a file at: a site path (isSitePath) of at most MAX_PATH_BYTES bytes
 * of UTF-8. Stored files may have longer paths (MAX_STORED_PATH_LENGTH): they keep serving and
 * can be pulled and removed, but not uploaded again.
 */
export function isValidSitePath(path: string): boolean {
  if (path.length > MAX_PATH_BYTES || utf8Length(path) > MAX_PATH_BYTES) return false
  return isSitePath(path)
}

export const ManifestFileSchema = z.object({
  path: z
    .string()
    .refine(isValidSitePath, 'invalid path (dotfiles are never published)')
    .refine(p => !isSecretPath(p), 'secret file (keys, certificates, credentials) never published'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * The file's MD5, base64 (as `Content-MD5` carries it), for stores that check an upload's MD5
   * rather than its SHA-256 (GCS, Azure Blob, S3-compatible stores). Optional: a client that
   * sends none still deploys, through the host where the store needs it (`Blobs.presignPut`).
   * The version id is the SHA-256s' alone.
   */
  md5: z
    .string()
    .regex(/^[A-Za-z0-9+/]{22}==$/)
    .optional(),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  contentType: z.string().min(1).max(255),
})
export type ManifestFile = z.infer<typeof ManifestFileSchema>

const manifestOf = (files: z.ZodArray<typeof ManifestFileSchema>) =>
  z
    .object({ files })
    .refine(m => new Set(m.files.map(f => f.path)).size === m.files.length, 'duplicate paths')
    .refine(m => m.files.reduce((n, f) => n + f.size, 0) <= MAX_DEPLOY_BYTES, 'deploy too large')

export const ManifestSchema = manifestOf(z.array(ManifestFileSchema).min(1).max(MAX_FILES))
export type Manifest = z.infer<typeof ManifestSchema>

/**
 * A deploy's manifest (`DeployRequest.manifest`): a manifest, except that a partial publish on a
 * base (only the files that changed) may send none, when all it does is remove files.
 */
export const DeployManifestSchema = manifestOf(z.array(ManifestFileSchema).max(MAX_FILES))

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
