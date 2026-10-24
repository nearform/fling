/**
 * Route table port: the key/value map the edge reads to route site hosts (`site:<label>`,
 * `share:<token>`, `cfg:site-hmac`). Implementations: `memory.ts` (dev/tests) here, CloudFront
 * KeyValueStore in platforms/aws.
 */
export interface RouteTable {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
  /** no-op when the key doesn't exist */
  delete(key: string): Promise<void>
}
