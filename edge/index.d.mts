export type CfValue = { value: string; multiValue?: { value: string }[] }

export type CloudFrontRequest = {
  method: string
  uri: string
  querystring: Record<string, CfValue>
  headers: Record<string, CfValue>
  cookies: Record<string, CfValue>
}

export type CloudFrontResponse = {
  statusCode: number
  statusDescription?: string
  headers?: Record<string, CfValue>
}

export type CloudFrontEvent = {
  version: string
  context: { eventType: string }
  viewer: { ip: string }
  request: CloudFrontRequest
}

export type SiteRouterKvs = { get(key: string): Promise<string | undefined> }

export type SiteRouterOptions = {
  kvs: SiteRouterKvs
  /** e.g. `https://fling.example.test` (no trailing slash) */
  appOrigin: string
  siteScheme?: 'http' | 'https'
  /** Current time in milliseconds (like Date.now). */
  now?: () => number
}

export type SiteRouter = (event: CloudFrontEvent) => Promise<CloudFrontRequest | CloudFrontResponse>

/** The deployable CloudFront Function (build.mjs), placeholders still in. */
export declare const SITE_ROUTER_SOURCE: string

export declare function renderSiteRouter(
  opts: { appOrigin: string; siteScheme?: 'http' | 'https' },
  source?: string
): string

export declare function createSiteRouter(opts: SiteRouterOptions): SiteRouter

export declare function toCloudFrontEvent(opts: {
  method?: string
  host: string
  path?: string
  /** Raw query string without `?`, e.g. `a=1&b=2` */
  query?: string
  cookieHeader?: string
}): CloudFrontEvent

export declare function isResponse(
  result: CloudFrontRequest | CloudFrontResponse
): result is CloudFrontResponse
