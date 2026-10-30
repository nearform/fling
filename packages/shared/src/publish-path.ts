/**
 * Path publish: a deploy that replaces only the files under one folder of a site (`path`) and
 * carries every other file of the current version forward (apps/api/src/publication.ts). This is
 * the folder's spelling, shared by the API and every client: `/30-10-26/`, `30-10-26/` and
 * `30-10-26` are the same path, stored as `30-10-26`.
 */
import { z } from 'zod'
import { isValidSitePath } from './manifest.ts'

/** The path without its leading and trailing slashes; null unless it is a valid site path. */
export function normalizePublishPath(raw: string): string | null {
  const path = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return isValidSitePath(path) ? path : null
}

/** Is a site-relative file path inside the folder `path` (normalised)? */
export const isUnderPath = (file: string, path: string) => file.startsWith(`${path}/`)

/** How clients show a path: `/30-10-26/`. */
export const displayPublishPath = (path: string) => `/${path}/`

export const PublishPathSchema = z.string().transform((raw, ctx) => {
  const path = normalizePublishPath(raw)
  if (path === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'path must be a folder of the site, like 30-10-26 or reports/2026 (no dotfiles)',
    })
    return z.NEVER
  }
  return path
})
