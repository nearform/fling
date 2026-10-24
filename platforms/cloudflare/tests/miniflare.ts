/**
 * Local D1, R2 and KV for the tests: a Miniflare instance (workerd, the Workers runtime, with its
 * D1/R2/KV simulators, in memory) driven from Node. The adapters get the real bindings through
 * Miniflare's proxies, so SQL, batches and R2 checksums run in workerd while the conformance suites
 * stay plain vitest. (@cloudflare/vitest-pool-workers, which would run the tests themselves in
 * workerd, needs vitest 4.) Signed uploads go to tests/worker.ts running in workerd, because a body
 * streamed from Node through a proxy has no known length and R2 only streams known-length bodies.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations')

export const COMPATIBILITY = {
  compatibilityDate: '2026-07-30',
  compatibilityFlags: ['nodejs_compat'],
}

/** Bundle a Worker entry for workerd (`node:*` stays external: nodejs_compat provides it). */
export async function bundle(entry: string): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    external: ['node:*', 'cloudflare:*'],
    logLevel: 'silent',
  })
  return out.outputFiles[0]?.text ?? ''
}

/**
 * The statements of a D1 migration file, as `wrangler d1 migrations apply` runs them: comment
 * lines dropped, one statement per `;` at a line end, a trigger body kept whole up to `END;`.
 */
export function statements(sql: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let trigger = false
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!line.trim() && !current.length)) continue
    current.push(line)
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) trigger = true
    if (trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      out.push(current.join('\n').trim().replace(/;$/, ''))
      current = []
      trigger = false
    }
  }
  if (current.join('').trim()) throw new Error('migration ends mid-statement')
  return out
}

/** Apply every migrations/*.sql, in order, to a database. */
export async function applySchema(db: D1Database) {
  for (const file of readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const statement of statements(sql)) await db.prepare(statement).run()
  }
}

export interface Local {
  mf: Miniflare
  db: D1Database
  bucket: R2Bucket
  kv: KVNamespace
  /** a fresh, empty, migrated database (each call wipes the one before) */
  freshDb(): Promise<D1Database>
  /** HMAC secret of the upload route in tests/worker.ts */
  uploadSecret: string
}

export async function local(): Promise<Local> {
  const uploadSecret = 'u'.repeat(40)
  const mf = new Miniflare({
    modules: true,
    script: await bundle(join(import.meta.dirname, 'worker.ts')),
    ...COMPATIBILITY,
    bindings: { UPLOAD_SECRET: uploadSecret },
    d1Databases: ['DB', 'SCRATCH'],
    r2Buckets: ['BUCKET'],
    kvNamespaces: ['KV'],
  })
  // Miniflare's binding types come from its own copy of workers-types.
  const db = (await mf.getD1Database('DB')) as unknown as D1Database
  const scratch = (await mf.getD1Database('SCRATCH')) as unknown as D1Database
  await applySchema(db)
  await applySchema(scratch)
  return {
    mf,
    db,
    uploadSecret,
    bucket: (await mf.getR2Bucket('BUCKET')) as unknown as R2Bucket,
    kv: (await mf.getKVNamespace('KV')) as unknown as KVNamespace,
    async freshDb() {
      await scratch.prepare('DELETE FROM items').run()
      return scratch
    },
  }
}
