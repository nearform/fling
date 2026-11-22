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
  /** present when the current version has a server (SERVER_BUNDLE), run for SERVER_PREFIX */
  f: z.literal(1).optional(),
  /** where the server is reached, when the platform needs it (AWS: the Web Function's endpoint; Cloudflare: the run, which names its isolate and options) */
  t: z.string().optional(),
  /** present when an admin stopped the site's server: SERVER_PREFIX answers 503 */
  x: z.literal(1).optional(),
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

/**
 * How the API writes route values. `json` is what every release's edge reads; `compact` is about
 * a third of the size (CloudFront KeyValueStore holds 5 MB in all) and stores a share link as a
 * pointer to its site's value (`>` and the site's label). The edge reads both
 * (site-routing.ts `parseRoute`); an admin chooses which the API writes (route-format.ts).
 */
export const ROUTE_FORMATS = ['json', 'compact'] as const
export type RouteFormat = (typeof ROUTE_FORMATS)[number]

const COMPACT_FLAGS = ['r', 'p', 'm', 'f', 'x'] as const

/** A site's route value in `format` (parseRoute reads it back). */
export function encodeSiteValue(value: KvsSiteValue, format: RouteFormat): string {
  if (format === 'json') return JSON.stringify(value)
  let flags = (value.vis === 'public' ? 'u' : '') + (value.spa ? 's' : '')
  for (const f of COMPACT_FLAGS) if (value[f]) flags += f
  return compact([value.id, value.v, flags, value.i ?? '', value.t ?? ''])
}

/** A Path's route value in `format`. */
export function encodePathValue(value: KvsPathValue, format: RouteFormat): string {
  if (format === 'json') return JSON.stringify(value)
  return compact([value.id, value.v, value.m ? 'm' : ''])
}

/** A share link's value: its site's, or in `compact` a pointer to the site's key. */
export function encodeShareValue(label: string, siteValue: string, format: RouteFormat): string {
  return format === 'json' ? siteValue : `>${label}`
}

/** `~` and the fields joined by `|`, the empty trailing ones left out. */
function compact(fields: string[]): string {
  let end = fields.length
  while (end > 2 && !fields[end - 1]) end--
  return `~${fields.slice(0, end).join('|')}`
}
