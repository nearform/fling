import type { Kvs } from './types.ts'

export class MemoryKvs implements Kvs {
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
