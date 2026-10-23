/** CloudFront KeyValueStore port. Implementations: `cloudfront.ts`, `memory.ts` (dev/tests). */
export interface Kvs {
  get(key: string): Promise<string | undefined>
  put(key: string, value: string): Promise<void>
  /** no-op when the key doesn't exist */
  delete(key: string): Promise<void>
}
