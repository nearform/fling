/**
 * 0002 — site-centric keys, the CONTRACT step: deletes the old version items
 * (USER#<email>/VERSION#<siteId>#<versionId>) once their copy is in the site partition. NOT run
 * by deploys (`auto: false`) until a human decides; read 0001's header first.
 *
 * Run it only when nobody will roll back to code from before 0001: that code finds a site's
 * versions only at these keys, so afterwards it would show every site with no versions. The plan:
 * set `auto: true` here in the same release that removes the expand-phase reads and writes from
 * Records (marked LEGACY), so it runs once that code is live and nothing writes these keys again.
 * Before then it can be run by hand (`{"fling":"migrate","only":["0002"]}`); the expand-phase code
 * tolerates it (it reads both places) but keeps writing old keys for new versions.
 *
 * A version whose copy is missing, or pending while the old item is complete, is copied first
 * (as 0001 does) and deleted after; the delete is conditional on the old item still having the
 * status that was copied. Idempotent: a second run finds nothing to delete.
 */
import { mapLimit } from '../lib/concurrency.ts'
import { ConditionFailed, fieldEquals, ifAbsent, type TableItem } from '../table/types.ts'
import type { Migration, MigrationContext } from './runner.ts'

const CONCURRENCY = 8

const isOldVersion = (i: TableItem) => i.pk.startsWith('USER#') && i.sk.startsWith('VERSION#')

async function apply(items: TableItem[], ctx: MigrationContext) {
  const { table } = ctx
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
  title: 'drop old version keys (contract)',
  auto: false,
  apply,
}
