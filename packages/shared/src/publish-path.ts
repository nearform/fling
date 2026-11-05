/**
 * Path publish: a deploy to one top-level folder of a site (`path`), which publishes that folder's
 * Path (apps/api/src/paths.ts): its own versions, served at `/<folder>/`, the rest of the site
 * untouched. This is the folder's spelling, shared by the API and every client: `/PAY-412/`,
 * `PAY-412/` and `PAY-412` are the same path, stored as `PAY-412`. A Path is one folder: nested
 * folders (`reports/2026`) are not Paths, and a deploy can't name one.
 */
import { z } from 'zod'
import { MAX_PATH_FOLDER_LENGTH } from './limits.ts'
import { isValidSitePath } from './manifest.ts'

/** The path without its leading and trailing slashes; null unless it is a valid site path. */
export function normalizePublishPath(raw: string): string | null {
  const path = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return isValidSitePath(path) ? path : null
}

/**
 * A Path's folder: the path normalised (normalizePublishPath), one segment of at most
 * MAX_PATH_FOLDER_LENGTH characters; null otherwise.
 */
export function normalizePathFolder(raw: string): string | null {
  const path = normalizePublishPath(raw)
  if (path === null || path.includes('/') || path.length > MAX_PATH_FOLDER_LENGTH) return null
  return path
}

/** Is a site-relative file path inside the folder `path` (normalised)? */
export const isUnderPath = (file: string, path: string) => file.startsWith(`${path}/`)

/** How clients show a path: `/PAY-412/`. */
export const displayPublishPath = (path: string) => `/${path}/`

export const PublishPathSchema = z.string().transform((raw, ctx) => {
  const path = normalizePathFolder(raw)
  if (path === null) {
    ctx.addIssue({
      code: 'custom',
      message: `path must be one top-level folder of the site, like PAY-412 (at most ${MAX_PATH_FOLDER_LENGTH} characters, no dotfiles): publish nested folders as part of it`,
    })
    return z.NEVER
  }
  return path
})
