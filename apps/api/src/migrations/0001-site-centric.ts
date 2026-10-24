/**
 * 0001 — site-centric keys, the EXPAND step (Decision 8). Copies every site and version into
 * the site's own partition; deletes nothing.
 *
 *   before (still written, still read)              after (added by this migration)
 *   USER#<email>  SITE#<name>                 site   SITE#<siteId>  SITE                  site
 *   USER#<email>  VERSION#<siteId>#<vId>   version   SITE#<siteId>  VERSION#<vId>      version
 *   NAME#<name>   NAME                       claim   (unchanged)
 *
 * USER#<email>/SITE#<name> stays for good as the user's index item (a copy of the site record:
 * listing a user's sites is one query); USER#<email>/VERSION#… are dropped by the contract step,
 * 0002, which is opt-in.
 *
 * Copies are conditional, never blind: a site record is written if absent, or over an older copy
 * (`updatedAt`, compared and then made the write's condition); a version if absent, or over a
 * pending copy when the old one is complete. So it is safe while the API serves traffic, and
 * idempotent (a second run, or a page applied twice after a crash, finds everything present).
 * Items are copied as they are (`v` included): this re-keys, it does not reshape.
 *
 * DEPLOY ORDER. The release with this migration (Records in its expand phase, see records.ts)
 * writes both layouts and reads both, so it serves correctly before this migration has run:
 *   1. the Lambda code is updated (deploy.yml waits until it is live);
 *   2. deploy.yml invokes the function with {"fling":"migrate"} until it reports done; each
 *      invoke runs pages until close to its timeout and checkpoints;
 *   3. the UI and the rest. If step 2 fails the deploy stops there; the API is fine meanwhile and
 *      the next deploy (or a hand-run invoke) carries on from the checkpoint.
 *
 * ROLLBACK. Redeploying a commit from before this release is survivable: the old code reads only
 * the old keys, and they stay complete, because this release writes versions to both places and
 * the index item is the old site item (same key, same fields; the old code ignores SITE#… and
 * MIGRATION#… items). While rolled back the old code writes only the old keys. Rolling forward
 * again needs nothing either: reads take the newer copy of a site (`updatedAt`) and the union of
 * both places' versions, so whatever the old code did shows, and the next write puts the site
 * partition back in step. This migration is done and doesn't run again; it doesn't need to.
 *
 * CONTRACT. Once nobody will roll back to code from before this release, 0002 deletes the old
 * version keys (copying any version first that only exists there). Ship it enabled in the same
 * release that removes the expand-phase reads and writes (LEGACY in records.ts), so nothing
 * writes old keys after it runs. After 0002 a rollback to pre-0001 code would show sites with no
 * versions: that's the point of no return.
 *
 * `verifySiteCentric` checks the result (the rehearsal script runs it on a restored copy of
 * production): see below.
 */
import { mapLimit } from '../lib/concurrency.ts'
import {
  ConditionFailed,
  fieldEquals,
  ifAbsent,
  type Table,
  type TableItem,
} from '../table/types.ts'
import type { Migration, MigrationContext } from './runner.ts'

/** Parallel copies within a page. */
const CONCURRENCY = 8

const isOldSite = (i: TableItem) => i.pk.startsWith('USER#') && i.sk.startsWith('SITE#')
const isOldVersion = (i: TableItem) => i.pk.startsWith('USER#') && i.sk.startsWith('VERSION#')

/** The item at another key: same attributes (type, v and all). */
const rekey = (item: TableItem, pk: string, sk: string): TableItem => ({ ...item, pk, sk })

/**
 * Put `item` unless what is there already is at least as fresh. `fresher(existing)` decides; the
 * write is conditional on `field` still holding what was read, so a racing write is re-read.
 */
async function copy(
  table: Table,
  item: TableItem,
  field: string,
  fresher: (existing: TableItem) => boolean
): Promise<'copied' | 'replaced' | 'present'> {
  for (;;) {
    const existing = await table.get(item.pk, item.sk)
    try {
      if (!existing) {
        await table.put(item, ifAbsent)
        return 'copied'
      }
      if (fresher(existing)) return 'present'
      const was = existing[field]
      if (typeof was !== 'string') throw new Error(`${item.pk} ${item.sk}: no ${field}`)
      await table.put(item, fieldEquals(field, was))
      return 'replaced'
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
    }
  }
}

async function apply(items: TableItem[], ctx: MigrationContext) {
  await mapLimit(items, CONCURRENCY, async item => {
    if (isOldSite(item) && typeof item.id === 'string') {
      const target = rekey(item, `SITE#${item.id}`, 'SITE')
      const done = await copy(
        ctx.table,
        target,
        'updatedAt',
        e => String(e.updatedAt) >= String(item.updatedAt)
      )
      ctx.count(`site ${done}`)
    } else if (isOldVersion(item) && typeof item.siteId === 'string') {
      const target = rekey(item, `SITE#${item.siteId}`, `VERSION#${item.id}`)
      const done = await copy(
        ctx.table,
        target,
        'status',
        e => e.status === 'complete' || item.status !== 'complete'
      )
      ctx.count(`version ${done}`)
    }
  })
}

export const m0001: Migration = {
  id: '0001',
  title: 'site-centric keys (expand)',
  auto: true,
  apply,
}

// --- verification -------------------------------------------------------------------------------

export interface Verification {
  /** no failures */
  ok: boolean
  /** what the migration should have done and didn't */
  failures: string[]
  /** anomalies already in the old layout (the migration copies them as they are) */
  warnings: string[]
  stats: Record<string, number>
}

/** Every live item, following scan cursors. */
export async function scanAll(table: Table, pageSize = 500): Promise<TableItem[]> {
  const out: TableItem[] = []
  let cursor: string | undefined
  do {
    const page = await table.scan({ limit: pageSize, cursor })
    out.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  return out
}

/** Comparable content of a site or version copy: everything but its key. */
const content = (i: TableItem) => {
  const { pk: _pk, sk: _sk, ...rest } = i
  return JSON.stringify(
    Object.keys(rest)
      .sort()
      .map(k => [k, rest[k]])
  )
}

/**
 * Check the site-centric layout against the old one, from a full scan:
 * - every old site has its record at SITE#<id>/SITE, the same or newer;
 * - every old version has its copy at SITE#<siteId>/VERSION#<id>, the same or completed;
 * - every user's sites resolve by name: claim → SITE#<claim.siteId> with that name and owner;
 * - every site's current version is in its partition, complete;
 * - every name claim points at a site record with its name and owner.
 * Anything already wrong in the old layout (a site no claim points at, a claim with no site, a
 * current version that was already missing, versions of a deleted site) is a warning, not a
 * failure. With `migrated: false` (a dry run) only the warnings and stats are computed.
 */
export async function verifySiteCentric(
  table: Table,
  opts: { migrated: boolean } = { migrated: true }
): Promise<Verification> {
  const items = await scanAll(table)
  const at = new Map(items.map(i => [`${i.pk}\u0000${i.sk}`, i]))
  const get = (pk: string, sk: string) => at.get(`${pk}\u0000${sk}`)
  const failures: string[] = []
  const warnings: string[] = []
  const fail = (m: string) => opts.migrated && failures.push(m)

  const oldSites = items.filter(isOldSite)
  const oldVersions = items.filter(isOldVersion)
  const claims = items.filter(i => i.pk.startsWith('NAME#') && i.sk === 'NAME')
  const records = items.filter(i => i.pk.startsWith('SITE#') && i.sk === 'SITE')
  const versions = items.filter(i => i.pk.startsWith('SITE#') && i.sk.startsWith('VERSION#'))
  const users = new Set(oldSites.map(s => String(s.email)))

  for (const s of oldSites) {
    const where = `site ${s.name} (${s.email}, ${s.id})`
    const record = get(`SITE#${s.id}`, 'SITE')
    if (!record) fail(`${where}: no SITE#${s.id}/SITE`)
    else if (content(record) !== content(s) && !(String(record.updatedAt) > String(s.updatedAt))) {
      fail(`${where}: SITE#${s.id}/SITE differs from its old item`)
    }
    const claim = get(`NAME#${s.name}`, 'NAME')
    if (!claim) warnings.push(`${where}: no name claim, so not reachable by name`)
    else if (claim.siteId !== s.id || claim.email !== s.email) {
      warnings.push(`${where}: stale; the name is claimed by ${claim.email} for ${claim.siteId}`)
    }
  }

  const oldSiteIds = new Set(oldSites.map(s => String(s.id)))
  for (const v of oldVersions) {
    const where = `version ${v.id} of site ${v.siteId} (${v.pk.slice(5)})`
    const copy = get(`SITE#${v.siteId}`, `VERSION#${v.id}`)
    if (!copy) fail(`${where}: no SITE#${v.siteId}/VERSION#${v.id}`)
    else if (
      content(copy) !== content(v) &&
      !(copy.status === 'complete' && v.status !== 'complete')
    ) {
      fail(`${where}: the copy differs`)
    }
    if (!oldSiteIds.has(String(v.siteId))) warnings.push(`${where}: its site is gone`)
  }

  for (const s of oldSites) {
    if (typeof s.currentVersionId !== 'string') continue
    const where = `site ${s.name} (${s.email}, ${s.id}): current version ${s.currentVersionId}`
    const old = get(String(s.pk), `VERSION#${s.id}#${s.currentVersionId}`)
    if (old?.status !== 'complete') {
      warnings.push(`${where} was already ${old ? old.status : 'missing'}`)
      continue
    }
    const copy = get(`SITE#${s.id}`, `VERSION#${s.currentVersionId}`)
    if (copy?.status !== 'complete') fail(`${where}: not complete in the site partition`)
  }

  for (const c of claims) {
    const where = `claim ${c.name} (${c.email} → ${c.siteId})`
    const record = get(`SITE#${c.siteId}`, 'SITE')
    const old = get(`USER#${c.email}`, `SITE#${c.name}`)
    if (!old || old.id !== c.siteId) {
      warnings.push(`${where}: no site holds it`)
      continue
    }
    if (!record) fail(`${where}: no SITE#${c.siteId}/SITE`)
    else if (record.name !== c.name || record.email !== c.email) {
      fail(`${where}: SITE#${c.siteId}/SITE is ${record.name} (${record.email})`)
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    stats: {
      users: users.size,
      'old sites': oldSites.length,
      'old versions': oldVersions.length,
      claims: claims.length,
      'site records': records.length,
      'site versions': versions.length,
    },
  }
}
