/**
 * 0004 — the site directory, EXPAND only: one `SITES/SITE#<name>` item per site, so the admins'
 * list of every site is one query, never a scan. Records writes it with the site on creation and
 * whenever a save changes its listing or access level, from this release on; this backfills it
 * for sites nobody has saved since.
 *
 *   read                                        written (if absent)
 *   USER#<email>  SITE#<name>    site (index)   SITES  SITE#<name>   sitedirectory { siteId, name,
 *   SITE#<siteId> SITE           site                                owner, createdAt, updatedAt,
 *   NAME#<name>   NAME           claim                               archived, live, restricted,
 *                                                                    access }
 *
 * The scan finds sites by their index item (`USER#<email>/SITE#<name>`), which every layout has
 * written (0001's header: before it, a site lived only there). For each it reads the name claim and
 * the site record, and skips a stale copy (the claim names another site, or none). The newer of the
 * record and the index item (`updatedAt`) is the site, as Records reads it.
 *
 * Shapes, in this migration's own terms: a v1 site has no `audience` (every member sees it); a
 * site from before access levels has no `restricted`, and is restricted exactly when its audience
 * names someone. `restricted` in the listing means private and restricted; `access` is the level
 * (`only_me`, `members`, `groups`, `people`, `public`).
 *
 * Each put is conditional on the item being absent: one that exists was written by the API with a
 * save of the site, after the copy this page read, so it is at least as fresh. A site deleted
 * between the read and the put would leave an item naming it, so after writing, the claim is read
 * again and the item taken back (conditionally, by site id) if the site has gone. Safe while the
 * API serves traffic, idempotent (a second run finds every item present), and deletes nothing it
 * did not write, so a rollback to the release before simply ignores the directory items. Runs on
 * deploy (`auto`).
 */
import { mapLimit } from '../lib/concurrency.ts'
import { ConditionFailed, fieldEquals, ifAbsent, type TableItem } from '../table/types.ts'
import type { Migration, MigrationContext } from './runner.ts'

const CONCURRENCY = 8

const isSiteIndex = (i: TableItem) =>
  i.pk.startsWith('USER#') && i.sk.startsWith('SITE#') && i.type === 'site'

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
const strs = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** The directory item for a site, in this migration's own terms (sitedirectory v1). */
export function siteDirectoryItem(site: TableItem): TableItem | null {
  const id = str(site.id)
  const name = str(site.name)
  const owner = str(site.email)
  const createdAt = str(site.createdAt)
  const updatedAt = str(site.updatedAt)
  if (!id || !name || !owner || !createdAt || !updatedAt) return null
  const audience = (site.audience ?? {}) as { emails?: unknown; groups?: unknown }
  const emails = strs(audience.emails).length
  const groups = strs(audience.groups).length
  const limited = typeof site.restricted === 'boolean' ? site.restricted : emails + groups > 0
  const visibility = site.visibility === 'public' ? 'public' : 'private'
  const access =
    visibility === 'public'
      ? 'public'
      : !limited
        ? 'members'
        : emails > 0
          ? 'people'
          : groups > 0
            ? 'groups'
            : 'only_me'
  return {
    pk: 'SITES',
    sk: `SITE#${name}`,
    type: 'sitedirectory',
    siteId: id,
    name,
    owner,
    createdAt,
    updatedAt,
    archived: site.archived === true,
    live: str(site.currentVersionId) !== null,
    restricted: visibility === 'private' && limited,
    access,
    v: 1,
  }
}

/** The site's id if its name claim is held by it, else null. */
async function claimedId(ctx: MigrationContext, name: string) {
  const claim = await ctx.table.get(`NAME#${name}`, 'NAME')
  return claim ? str(claim.siteId) : null
}

async function apply(items: TableItem[], ctx: MigrationContext) {
  await mapLimit(items.filter(isSiteIndex), CONCURRENCY, async index => {
    const id = str(index.id)
    const name = str(index.name)
    if (!id || !name || (await claimedId(ctx, name)) !== id) {
      ctx.count('site skipped (stale)')
      return
    }
    const record = await ctx.table.get(`SITE#${id}`, 'SITE')
    const site =
      record && record.id === id && String(record.updatedAt ?? '') >= String(index.updatedAt ?? '')
        ? record
        : index
    const item = siteDirectoryItem(site)
    if (!item) {
      ctx.count('site skipped (malformed)')
      return
    }
    try {
      await ctx.table.put(item, ifAbsent)
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      ctx.count('site present')
      return
    }
    // Deleted meanwhile: take back the item this run wrote (unless a new site has written its own).
    if ((await claimedId(ctx, name)) !== id) {
      try {
        await ctx.table.delete(item.pk, item.sk, fieldEquals('siteId', id))
      } catch (err) {
        if (!(err instanceof ConditionFailed)) throw err
      }
      ctx.count('site gone')
      return
    }
    ctx.count('site indexed')
  })
}

export const m0004: Migration = {
  id: '0004',
  title: 'site directory (expand)',
  auto: true,
  apply,
}
