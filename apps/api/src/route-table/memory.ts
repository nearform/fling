import type { RouteTable } from './types.ts'

export class MemoryRouteTable implements RouteTable {
  readonly data = new Map<string, string>()

  async get(key: string) {
    return this.data.get(key)
  }

  async put(key: string, value: string) {
    this.data.set(key, value)
  }

  async delete(key: string) {
    this.data.delete(key)
  }
}
