/**
 * The route table a Node host's sites host reads: the source (the Table, TableRouteTable) behind a
 * short cache in this process, so a site request costs no database read while its route is warm.
 *
 * Only values are cached, never a miss, so a new key (a site's first publish, a share link) is seen
 * at once. A changed or deleted key is seen at once by the process that wrote it, and by the others
 * within `ttlMs` (default 5 s): the most a rollback or a revoked share link takes to reach every
 * process, like KV in front of D1 on Cloudflare, only shorter.
 */
import type { RouteTable } from '@fling/api/route-table'

export class CachedRouteTable implements RouteTable {
  private cache = new Map<string, { value: string; until: number }>()

  constructor(
    readonly source: RouteTable,
    private opts: { ttlMs?: number; max?: number; now?: () => number } = {}
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.cache.get(key)
    if (hit && hit.until > this.now()) return hit.value
    const value = await this.source.get(key)
    if (value === undefined) this.cache.delete(key)
    else this.remember(key, value)
    return value
  }

  async put(key: string, value: string): Promise<void> {
    await this.source.put(key, value)
    this.remember(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.source.delete(key)
    this.cache.delete(key)
  }

  private remember(key: string, value: string) {
    const max = this.opts.max ?? 10_000
    if (this.cache.size >= max) this.cache.delete(this.cache.keys().next().value as string)
    this.cache.set(key, { value, until: this.now() + (this.opts.ttlMs ?? 5_000) })
  }
}
