/**
 * A RouteTable kept in the Table: one item per key, `ROUTE#<key>` / `ROUTE`, `{ value }`. Strongly
 * consistent wherever the Table is, so a platform whose fast edge store is eventually consistent
 * keeps its routes here too and reads them when that store misses (platforms/cloudflare: Workers
 * KV in front of D1). Migrations ignore these items (they only touch the keys they know).
 */
import type { Table } from '../table/types.ts'
import type { RouteTable } from './types.ts'

const SK = 'ROUTE'
export const routeItemPk = (key: string) => `ROUTE#${key}`

export class TableRouteTable implements RouteTable {
  constructor(private table: Table) {}

  async get(key: string) {
    const item = await this.table.get(routeItemPk(key), SK)
    return typeof item?.value === 'string' ? item.value : undefined
  }

  async put(key: string, value: string) {
    await this.table.put({ pk: routeItemPk(key), sk: SK, value })
  }

  async delete(key: string) {
    await this.table.delete(routeItemPk(key), SK)
  }
}
