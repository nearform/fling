/**
 * 0002 — site-centric keys, the CONTRACT step: brings every site record up to date with its index
 * item and deletes the old version items (USER#<email>/VERSION#<siteId>#<versionId>) once their
 * copy is in the site partition. NOT run by deploys (`auto: false`); a human runs it once; read
 * 0001's header first.
 *
 * It is the point of no return for rolling back to code from before 0001, which finds a site's
 * versions only at these keys (it would show every site with no versions). The order:
 *   1. decide nobody will redeploy code from before 0001;
 *   2. with the expand-phase release (0001's) live, run it by hand:
 *      `{"fling":"migrate","only":["0002"]}` (docs/DEPLOY.md). That release reads both places,
 *      so it serves the same before and after; it keeps writing old version keys too, but those
 *      are only duplicates of versions it also wrote to the site partition;
 *   3. the next release removes the expand-phase reads and writes (LEGACY in records.ts) and adds
 *      a migration that sweeps those duplicates the same way (auto: nothing it deletes is the
 *      only copy).
 *
 * Sites: an index item newer than the record (written by a Lambda rolled back to the old code
 * after 0001) is copied over the record, as 0001 does; so after this, records alone are current.
 * Versions: one whose copy is missing, or pending while the old item is complete, is copied first
 * and deleted after; the delete is conditional on the old item still having the status that was
 * copied. Idempotent: a second run finds nothing to do.
 */
import { mapLimit } from '../lib/concurrency.ts'
import { ConditionFailed, fieldEquals, ifAbsent, type TableItem } from '../table/types.ts'
import type { Migration, MigrationContext } from './runner.ts'

const CONCURRENCY = 8

const isOldSite = (i: TableItem) => i.pk.startsWith('USER#') && i.sk.startsWith('SITE#')
const isOldVersion = (i: TableItem) => i.pk.startsWith('USER#') && i.sk.startsWith('VERSION#')

/** Copy the index item over its site record if the record is missing or older. */
async function syncSite(index: TableItem, ctx: MigrationContext) {
  if (typeof index.id !== 'string' || typeof index.updatedAt !== 'string') return
  const target = { ...index, pk: `SITE#${index.id}`, sk: 'SITE' }
  for (;;) {
    const record = await ctx.table.get(target.pk, target.sk)
    try {
      if (!record) {
        await ctx.table.put(target, ifAbsent)
        ctx.count('site copied')
      } else if (String(record.updatedAt) < index.updatedAt) {
        await ctx.table.put(target, fieldEquals('updatedAt', String(record.updatedAt)))
        ctx.count('site refreshed')
      }
      return
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
    }
  }
}

async function apply(items: TableItem[], ctx: MigrationContext) {
  const { table } = ctx
  await mapLimit(items.filter(isOldSite), CONCURRENCY, index => syncSite(index, ctx))
  await mapLimit(items.filter(isOldVersion), CONCURRENCY, async old => {
    if (typeof old.siteId !== 'string' || typeof old.status !== 'string') {
      ctx.count('version skipped (malformed)')
      return
    }
    const target = { ...old, pk: `SITE#${old.siteId}`, sk: `VERSION#${old.id}` }
    for (;;) {
      const copy = await table.get(target.pk, target.sk)
      try {
        if (!copy) {
          await table.put(target, ifAbsent)
          ctx.count('version copied')
        } else if (copy.status !== 'complete' && old.status === 'complete') {
          await table.put(target, fieldEquals('status', String(copy.status)))
          ctx.count('version completed')
        }
        break
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
    }
    try {
      await table.delete(old.pk, old.sk, fieldEquals('status', old.status))
      ctx.count('version dropped')
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      // Completed meanwhile: leave it for the next run, which copies it first.
      ctx.count('version changed meanwhile (kept)')
    }
  })
}

export const m0002: Migration = {
  id: '0002',
  title: 'sync site records, drop old version keys (contract)',
  auto: false,
  apply,
}
