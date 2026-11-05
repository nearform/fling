/**
 * The memory Table kept in a JSON file, for local dev: every write rewrites the file (to a temp
 * file, then renamed over it, so a crash never leaves half a file), and a new process loads it. So
 * the dev API keeps its users, sites and routes across restarts. Same semantics as MemoryTable,
 * which it is; one process per file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MemoryTable } from './memory.ts'
import type { Condition, Patch, TableItem, TransactOp } from './types.ts'

export class FileTable extends MemoryTable {
  constructor(
    private file: string,
    now?: () => number
  ) {
    super(now)
    let saved: TableItem[] = []
    try {
      saved = JSON.parse(readFileSync(file, 'utf8')) as TableItem[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const item of saved) {
      const part = this.items.get(item.pk) ?? new Map<string, TableItem>()
      this.items.set(item.pk, part)
      part.set(item.sk, item)
    }
  }

  private save() {
    const all: TableItem[] = []
    for (const part of this.items.values()) all.push(...part.values())
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(all))
    renameSync(tmp, this.file)
  }

  override async put(item: TableItem, cond?: Condition) {
    await super.put(item, cond)
    this.save()
  }

  override async update(pk: string, sk: string, patch: Patch, cond?: Condition) {
    const updated = await super.update(pk, sk, patch, cond)
    this.save()
    return updated
  }

  override async delete(pk: string, sk: string, cond?: Condition) {
    const deleted = await super.delete(pk, sk, cond)
    this.save()
    return deleted
  }

  override async transact(ops: TransactOp[]) {
    await super.transact(ops)
    this.save()
  }
}
