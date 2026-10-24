/**
 * Workers KV RouteTable. KV is eventually consistent: a write is usually visible at once where it
 * was made, but other locations can take 60 s or more, and a location that recently read the key
 * (including a miss: negative lookups are cached too) sees the change last. The edge reads these
 * keys on every site request, so a new site can 404 in some places for about a minute.
 */
import type { KVNamespace } from '@cloudflare/workers-types'
import type { RouteTable } from '@fling/api/route-table'

export class WorkersKvRouteTable implements RouteTable {
  constructor(private kv: KVNamespace) {}

  async get(key: string) {
    return (await this.kv.get(key)) ?? undefined
  }

  async put(key: string, value: string) {
    await this.kv.put(key, value)
  }

  async delete(key: string) {
    await this.kv.delete(key)
  }
}
