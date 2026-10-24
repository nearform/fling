/**
 * Rehearse the pending data migrations on a DynamoDB table, normally a point-in-time-restored copy
 * of production (platforms/aws/DEPLOY.md, "Rehearsing a data migration"), and verify the result:
 *
 *   pnpm --filter @fling/platform-aws migrate:rehearse --table <copy> --live-table <production>
 *     --region <region> [--dry-run] [--page-size 100] [--lease-seconds 120]
 *     [--endpoint http://localhost:8000] [--any-table]
 *
 * 1. Refuses to run on the live table. `--live-table` (or FLING_LIVE_TABLE) names it, the
 *    module's `table_name` output, and is required: `--table` must be another table, and must not
 *    resolve to the same ARN. DescribeTable's RestoreSummary is shown when AWS reports it, but it
 *    is not relied on: AWS has left it null on a table restored to a point in time. --endpoint
 *    (DynamoDB Local) and --any-table skip these checks.
 * 2. Counts items per kind, notes anomalies already in the data, and records what the API serves
 *    for every user and site (through Records).
 * 3. Runs the runner until it reports done (waiting out another run's lease if one holds the lock;
 *    so a killed rehearsal resumes when started again). --dry-run runs it writing nothing and
 *    stops after reporting what it would do.
 * 4. Verifies: counts per kind before/after (nothing of the old layout lost or changed; one site
 *    record per old site, one copy per old version), verifySiteCentric (every user's sites resolve
 *    through the new layout, every site's versions and current version are in its partition, name
 *    claims point at matching site records), and that the API serves exactly what it did before.
 *
 * Exit status 0 when everything verifies; 1 on any failure.
 */
import { parseArgs } from 'node:util'
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  MIGRATIONS,
  type RunReport,
  runMigrations,
  scanAll,
  verifySiteCentric,
} from '@fling/api/migrations'
import { Records } from '@fling/api/store/records'
import type { TableItem } from '@fling/api/table'
import { DynamoTable } from '../src/table/dynamo.ts'

const { values: args } = parseArgs({
  options: {
    table: { type: 'string' },
    region: { type: 'string' },
    'live-table': { type: 'string' },
    endpoint: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'page-size': { type: 'string', default: '100' },
    'lease-seconds': { type: 'string', default: '120' },
    'any-table': { type: 'boolean', default: false },
  },
})

const say = (line = '') => console.log(line)
const MAX_LISTED = 20

function die(message: string): never {
  console.error(`migrate:rehearse: ${message}`)
  process.exit(1)
}

/** The kind of an item, from its key (what the counts are per). */
function kindOf(item: TableItem): string {
  const prefix = item.pk.slice(0, item.pk.indexOf('#') + 1)
  const sk = item.sk
  switch (prefix) {
    case 'USER#':
      if (sk === 'PROFILE') return 'user'
      if (sk.startsWith('KEY#')) return 'apikey'
      if (sk.startsWith('SITE#')) return 'site (old key = index item)'
      if (sk.startsWith('VERSION#')) return 'version (old key)'
      if (sk.startsWith('GRANT#')) return 'grant*'
      return `USER# ${sk.split('#')[0]}`
    case 'SITE#':
      if (sk === 'SITE') return 'site record (new)'
      if (sk.startsWith('VERSION#')) return 'version (new)'
      return `SITE# ${sk.split('#')[0]}`
    case 'UPLOAD#':
      return sk === 'UPLOAD' ? 'upload*' : 'uploadfile*'
    case 'NAME#':
      return 'name claim'
    case 'SLUG#':
      return 'slug'
    case 'APIKEY#':
      return 'apikey lookup'
    case 'OAUTHCLIENT#':
      return 'oauth client*'
    case 'OAUTHREQ#':
      return 'oauth request*'
    case 'OAUTHCODE#':
      return 'oauth code*'
    case 'REFRESH#':
      return 'refresh token*'
    case 'MIGRATION#':
      return 'migration'
    default:
      return `other (${item.pk.split('#')[0]})`
  }
}

function countKinds(items: TableItem[]) {
  const counts: Record<string, number> = {}
  for (const item of items) counts[kindOf(item)] = (counts[kindOf(item)] ?? 0) + 1
  return counts
}

/** What the API serves, per user and per claimed name, through Records (the code that serves it). */
async function served(table: DynamoTable, items: TableItem[]) {
  const records = new Records(table)
  const users = [
    ...new Set(
      items
        .filter(i => i.pk.startsWith('USER#') && i.sk.startsWith('SITE#'))
        .map(i => i.pk.slice(5))
    ),
  ].sort()
  const names = items
    .filter(i => i.pk.startsWith('NAME#'))
    .map(i => i.pk.slice(5))
    .sort()
  const view = new Map<string, string>()
  for (const email of users) {
    const sites = await records.listSites(email)
    view.set(`sites of ${email}`, JSON.stringify(sites))
  }
  for (const name of names) {
    const site = await records.findSite(name)
    const versions = site ? await records.listVersions(site) : null
    view.set(`site ${name}`, JSON.stringify({ site, versions }))
  }
  return view
}

const list = (lines: string[]) => {
  for (const line of lines.slice(0, MAX_LISTED)) say(`    - ${line}`)
  if (lines.length > MAX_LISTED) say(`    … and ${lines.length - MAX_LISTED} more`)
}

const table = args.table ?? die('--table <name> (the restored copy) is required')
const liveTable = args['live-table'] ?? process.env.FLING_LIVE_TABLE
const guarded = !args.endpoint && !args['any-table']
if (guarded && !liveTable) {
  die(
    '--live-table <name> (or FLING_LIVE_TABLE) is required: the production table, so the ' +
      'rehearsal can refuse to touch it (platforms/aws/DEPLOY.md)'
  )
}
if (guarded && table === liveTable) {
  die(`--table ${table} is the live table. Rehearse on a point-in-time restore (DEPLOY.md).`)
}
const region = args.region ?? process.env.AWS_REGION ?? die('--region (or AWS_REGION) is required')
const client = new DynamoDBClient({
  region,
  ...(args.endpoint
    ? {
        endpoint: args.endpoint,
        credentials: { accessKeyId: 'fling', secretAccessKey: 'fling' },
      }
    : {}),
})

const described = (await client.send(new DescribeTableCommand({ TableName: table }))).Table
if (!described) die(`no table ${table}`)
say(`Table ${table} (${region}${args.endpoint ? `, ${args.endpoint}` : ''})`)
say(`  status ${described.TableStatus}, ~${described.ItemCount ?? '?'} items (DynamoDB's estimate)`)
if (described.RestoreSummary) {
  const r = described.RestoreSummary
  say(
    `  restored from ${r.SourceTableArn ?? r.SourceBackupArn} at ${r.RestoreDateTime?.toISOString()}`
  )
} else {
  say('  no RestoreSummary (AWS does not always report one for a restored table)')
}
if (guarded) {
  const live = (await client.send(new DescribeTableCommand({ TableName: liveTable }))).Table
  if (!live?.TableArn) die(`no live table ${liveTable}: check --live-table`)
  if (live.TableArn === described.TableArn) die(`${table} is the live table ${liveTable}`)
  const source = described.RestoreSummary?.SourceTableArn
  if (source && source !== live.TableArn) {
    say(`  note: restored from ${source}, not from the live table ${live.TableArn}`)
  }
  say(`  live table ${liveTable} is not touched`)
}

const dynamo = new DynamoTable(table, client)
const dryRun = args['dry-run']
const pageSize = Number(args['page-size'])
const leaseMs = Number(args['lease-seconds']) * 1000

say('\nBefore')
const before = await scanAll(dynamo)
const countsBefore = countKinds(before)
for (const [kind, n] of Object.entries(countsBefore).sort()) say(`  ${kind}: ${n}`)
const viewBefore = await served(dynamo, before)
const anomalies = await verifySiteCentric(dynamo, { migrated: false })
say(`  anomalies already in the data: ${anomalies.warnings.length}`)
list(anomalies.warnings)

say(dryRun ? '\nDry run (nothing is written)' : '\nMigrating')
let report: RunReport
for (;;) {
  report = await runMigrations(dynamo, {
    migrations: MIGRATIONS,
    dryRun,
    pageSize,
    leaseMs,
    log: line => say(`  ${line}`),
  })
  const busy = report.migrations.find(m => m.status === 'busy')
  if (report.done || !busy) break
  const wait = Math.max(Date.parse(busy.lockedUntil ?? '') - Date.now(), 0) + 1000
  say(
    `  ${busy.id} is locked by ${busy.lockedBy} until ${busy.lockedUntil}; waiting ${Math.ceil(wait / 1000)} s`
  )
  await new Promise(r => setTimeout(r, wait))
}
for (const m of report.migrations) {
  say(`  ${m.id} ${m.title}: ${m.status}, ${m.scanned} items scanned, ${JSON.stringify(m.counts)}`)
}
if (!report.done) die('the migrations did not finish')
if (dryRun) {
  say('\nDry run: nothing written. Run without --dry-run to migrate and verify.')
  process.exit(0)
}

say('\nAfter')
const after = await scanAll(dynamo)
const countsAfter = countKinds(after)
const failures: string[] = []
/**
 * Kinds the migration must leave exactly as they were: not the new layout or the runner's items
 * (which it writes), nor expiring ones (*), which may lose items to the clock while this runs.
 */
const fixed = (kind: string) =>
  !kind.endsWith('*') && !kind.endsWith('(new)') && kind !== 'migration'
for (const kind of [
  ...new Set([...Object.keys(countsBefore), ...Object.keys(countsAfter)]),
].sort()) {
  const was = countsBefore[kind] ?? 0
  const now = countsAfter[kind] ?? 0
  say(`  ${kind}: ${was} → ${now}`)
  if (fixed(kind) && was !== now) failures.push(`${kind}: ${was} before, ${now} after`)
}
const oldSiteIds = new Set(
  before.filter(i => kindOf(i) === 'site (old key = index item)').map(i => String(i.id))
)
const expect = (kind: string, n: number) => {
  if ((countsAfter[kind] ?? 0) !== n)
    failures.push(`${kind}: ${countsAfter[kind] ?? 0}, expected ${n}`)
}
expect('site record (new)', oldSiteIds.size)
expect('version (new)', countsBefore['version (old key)'] ?? 0)
const unchanged = new Map(before.map(i => [`${i.pk}\u0000${i.sk}`, JSON.stringify(i)]))
let changed = 0
for (const item of after) {
  const was = unchanged.get(`${item.pk}\u0000${item.sk}`)
  if (was !== undefined && was !== JSON.stringify(item) && fixed(kindOf(item))) changed++
}
if (changed > 0) failures.push(`${changed} item(s) of the old layout changed`)

const verification = await verifySiteCentric(dynamo)
failures.push(...verification.failures)
say(`  ${JSON.stringify(verification.stats)}`)

const viewAfter = await served(dynamo, after)
for (const [key, was] of viewBefore) {
  if (viewAfter.get(key) !== was) failures.push(`the API serves ${key} differently`)
}

say(`\nVerification: ${failures.length === 0 ? 'PASSED' : 'FAILED'}`)
const lists = [...viewBefore.keys()].filter(k => k.startsWith('sites of ')).length
say(`  served as before: ${lists} users' site lists, ${viewBefore.size - lists} sites by name`)
say(
  `  warnings (anomalies already in the data, copied as they are): ${verification.warnings.length}`
)
list(verification.warnings)
if (failures.length > 0) {
  say(`  failures: ${failures.length}`)
  list(failures)
  process.exit(1)
}
