/**
 * Workers KV in front of the Table. KV is the fast read on every site request, but it is
 * eventually consistent, and a location that recently read a key (a miss included: negative
 * lookups are cached for about a minute) sees a change last. So the routes are also kept in the
 * Table (TableRouteTable over D1, strongly consistent) and a KV miss is answered from there: a new
 * site or share link works everywhere as soon as the API has written it, so the CLI and MCP never
 * wait on KV. What KV can still serve stale, for up to its propagation time, is a key that changed
 * or went away (a rollback, a visibility change, an archived site, a rotated share link).
 *
 * Writes go to the Table first, so KV never holds a route the Table doesn't.
 */
import type { RouteTable } from '@fling/api/route-table'

export class CachedRouteTable implements RouteTable {
  constructor(
    private cache: RouteTable,
    private source: RouteTable
  ) {}

  async get(key: string) {
    return (await this.cache.get(key)) ?? (await this.source.get(key))
  }

  async put(key: string, value: string) {
    await this.source.put(key, value)
    await this.cache.put(key, value)
  }

  async delete(key: string) {
    await this.source.delete(key)
    await this.cache.delete(key)
  }
}
