import { z } from 'zod'

// CloudFront KeyValueStore contract between the API (writer) and
// edge/site-router.js (reader). Values must stay under 1 KB.

/** `site:<name>` → routing for a live (non-archived) site. */
export const siteKvsKey = (label: string) => `site:${label}`
/** `share:<token>` → routing for a share link; served without auth. */
export const shareKvsKey = (token: string) => `share:${token}`
/** HMAC key the edge uses to verify the `fling_site` cookie. */
export const SITE_HMAC_KVS_KEY = 'cfg:site-hmac'

export const KvsSiteValueSchema = z.object({
  /** siteId — S3 prefix is `sites/<id>/<v>/` */
  id: z.string(),
  /** current versionId */
  v: z.string(),
  vis: z.enum(['private', 'public']),
  /** serve /index.html for unknown extensionless paths */
  spa: z.boolean(),
})
export type KvsSiteValue = z.infer<typeof KvsSiteValueSchema>

export const siteObjectKey = (siteId: string, versionId: string, path: string) =>
  `sites/${siteId}/${versionId}/${path}`
export const siteVersionPrefix = (siteId: string, versionId: string) =>
  `sites/${siteId}/${versionId}/`
export const sitePrefix = (siteId: string) => `sites/${siteId}/`

/** Object key that never exists; the edge rewrites unknown hosts here so S3 404s into the error page. */
export const MISSING_KEY = '/_fling/missing'
export const NOT_FOUND_PAGE = '/_fling/404.html'
