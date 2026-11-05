import { z } from 'zod'

// The route table contract between the API (writer) and the edge (reader: the shared routing
// function in site-routing.ts, run by the CloudFront Function and the Worker). Values must stay
// under 1 KB (CloudFront KeyValueStore). The keys live in route-keys.ts, which has no
// dependencies, so the CloudFront Function bundle stays small.

export * from './route-keys.ts'

export const KvsSiteValueSchema = z.object({
  /** siteId — S3 prefix is `sites/<id>/<v>/` */
  id: z.string(),
  /** current versionId */
  v: z.string(),
  vis: z.enum(['private', 'public']),
  /** serve /index.html for unknown extensionless paths */
  spa: z.boolean(),
  /** present when the site is restricted (private with an audience): the edge wants a site pass */
  r: z.literal(1).optional(),
  /** present when the site has live Paths: a request's first folder may be one (`path:` keys) */
  p: z.literal(1).optional(),
  /**
   * the rendered home page and Paths listing (`sites/<id>/_rendered/<i>.html|json`), served for
   * `/`, `/index.html` and PATHS_JSON_PATH instead of the version's own index.html
   */
  i: z.string().optional(),
  /** present when the current version's Markdown files have rendered pages (markdown.ts) */
  m: z.literal(1).optional(),
})
export type KvsSiteValue = z.infer<typeof KvsSiteValueSchema>

/** `path:<siteId>/<folder>`: the Path's storage id (its blobs' prefix) and current version. */
export const KvsPathValueSchema = z.object({
  id: z.string(),
  v: z.string(),
  /** as on a site's value: its current version's Markdown has rendered pages */
  m: z.literal(1).optional(),
})
export type KvsPathValue = z.infer<typeof KvsPathValueSchema>

export const siteObjectKey = (siteId: string, versionId: string, path: string) =>
  `sites/${siteId}/${versionId}/${path}`
export const siteVersionPrefix = (siteId: string, versionId: string) =>
  `sites/${siteId}/${versionId}/`
export const sitePrefix = (siteId: string) => `sites/${siteId}/`
