/**
 * Run Fling's pending data migrations (apps/api/src/migrations) on the Worker's D1 database, from
 * Node, through a binding wrangler provides: the same D1Table code the Worker runs, with no admin
 * endpoint on the Worker and no extra secret. The D1 schema (migrations/*.sql) must be applied
 * first (`wrangler d1 migrations apply`).
 *
 *   tsx scripts/migrate.ts --local [--persist-to .wrangler/state]   the `wrangler dev` database
 *   tsx scripts/migrate.ts --remote --config dist/wrangler.jsonc    the deployed one (the deploy)
 *     [--dry-run] [--only 0002]
 *
 * --remote makes the D1 binding a remote binding (wrangler proxies it to the real database, with
 * CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID): it needs the same token as the deploy, nothing
 * reachable from the internet. Prints the runner's report; exits 1 unless every migration is done.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { D1Database } from '@cloudflare/workers-types'
import { MIGRATIONS, type RunReport, runMigrations } from '@fling/api/migrations'
import { getPlatformProxy } from 'wrangler'
import { D1Table } from '../src/table/d1.ts'
import { ROOT, readJsonc, TEMPLATE } from './config.mjs'

const { values: args } = parseArgs({
  options: {
    local: { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
    config: { type: 'string' },
    'persist-to': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    only: { type: 'string', multiple: true },
  },
})

if (args.local === args.remote) {
  console.error('migrate: pass exactly one of --local or --remote')
  process.exit(1)
}

const configPath = resolve(args.config ?? TEMPLATE)
const config = readJsonc(configPath) as {
  name: string
  account_id?: string
  compatibility_date: string
  compatibility_flags?: string[]
  d1_databases: { binding: string; database_name: string; database_id: string }[]
}
const db = config.d1_databases.find(d => d.binding === 'DB')
if (!db) throw new Error(`${configPath} has no D1 binding DB`)

// Only the database: no assets, routes or vars, so nothing else is touched or needs to exist.
const dir = mkdtempSync(join(tmpdir(), 'fling-migrate-'))
const migrateConfig = join(dir, 'wrangler.json')
writeFileSync(
  migrateConfig,
  JSON.stringify({
    name: `${config.name}-migrate`,
    account_id: config.account_id,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    d1_databases: [{ ...db, remote: args.remote }],
  })
)

const persistTo = resolve(ROOT, args['persist-to'] ?? '.wrangler/state')
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: migrateConfig,
  persist: args.local ? { path: join(persistTo, 'v3') } : false,
  remoteBindings: args.remote,
  envFiles: [],
})

const where = args.remote ? `remote D1 ${db.database_name}` : `local D1 (${persistTo})`
console.log(`Data migrations on ${where}${args['dry-run'] ? ' (dry run)' : ''}`)
let report: RunReport
try {
  const table = new D1Table(proxy.env.DB)
  for (;;) {
    report = await runMigrations(table, {
      migrations: MIGRATIONS,
      only: args.only,
      dryRun: args['dry-run'],
      log: line => console.log(`  ${line}`),
    })
    // Another run holds a migration's lock (a crashed one's lease runs out within 2 minutes).
    const busy = report.migrations.find(m => m.status === 'busy')
    if (report.done || !busy) break
    const wait = Math.max(Date.parse(busy.lockedUntil ?? '') - Date.now(), 0) + 1000
    console.log(
      `  ${busy.id} is locked until ${busy.lockedUntil}; waiting ${Math.ceil(wait / 1000)} s`
    )
    await new Promise(r => setTimeout(r, wait))
  }
} finally {
  await proxy.dispose()
}
for (const m of report.migrations) {
  console.log(`  ${m.id} ${m.title}: ${m.status}, ${m.scanned} items, ${JSON.stringify(m.counts)}`)
}
if (!report.done) {
  console.error('migrate: the migrations did not finish')
  process.exit(1)
}
