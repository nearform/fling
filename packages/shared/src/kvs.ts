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
})
export type KvsSiteValue = z.infer<typeof KvsSiteValueSchema>

export const siteObjectKey = (siteId: string, versionId: string, path: string) =>
  `sites/${siteId}/${versionId}/${path}`
export const siteVersionPrefix = (siteId: string, versionId: string) =>
  `sites/${siteId}/${versionId}/`
export const sitePrefix = (siteId: string) => `sites/${siteId}/`
