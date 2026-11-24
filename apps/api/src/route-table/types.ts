/**
 * Route table port: the key/value map the edge reads to route site hosts (`site:<label>`,
 * `share:<token>`, `cfg:site-hmac`). Implementations: `memory.ts` (dev/tests) and `table.ts` (over
 * the Table) here, CloudFront KeyValueStore in platforms/aws, Workers KV with a Table fallback in
 * platforms/cloudflare.
 */
export interface RouteTable {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
  /** no-op when the key doesn't exist */
  delete(key: string): Promise<void>
  /**
   * How full the store is, where it has a size limit (CloudFront KeyValueStore's 5 MB); absent
   * where it has none. Maintenance logs it and Admin → Routes shows it.
   */
  usage?(): Promise<RouteTableUsage>
}

export interface RouteTableUsage {
  bytes: number
  limitBytes: number
  /** the routes in it, where the store counts them: what one takes, on average, is bytes / items */
  items?: number
}
