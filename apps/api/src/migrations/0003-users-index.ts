/**
 * 0003 — the users index, EXPAND only: one `USERS/USER#<email>` item per user, so the admin's
 * users list is one query, never a scan. Records writes it with the user record on every sign-in
 * from this release on; this backfills it for users who haven't signed in since.
 *
 *   read                                   written (if absent)
 *   USER#<email>  PROFILE           user   USERS  USER#<email>   userindex { email, name, picture,
 *                                                                userSlug, createdAt, lastSignInAt }
 *
 * `lastSignInAt` is the record's own, else its `updatedAt`: before this release every sign-in
 * set `updatedAt` and nothing else did, so it is the last sign-in.
 *
 * Each put is conditional on the index item being absent: one that exists was written by the API
 * at a sign-in, after the record this page read, so it is at least as fresh. Safe while the API
 * serves traffic, idempotent (a second run finds every item present), and deletes nothing, so a
 * rollback to the release before simply ignores the index items. Runs on deploy (`auto`).
 */
import { mapLimit } from '../lib/concurrency.ts'
import { ConditionFailed, ifAbsent, type TableItem } from '../table/types.ts'
import type { Migration, MigrationContext } from './runner.ts'

const CONCURRENCY = 8

const isUser = (i: TableItem) => i.pk.startsWith('USER#') && i.sk === 'PROFILE'

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)

/** The index item for a user record, in this migration's own terms (userindex v1). */
export function userIndexItem(user: TableItem): TableItem | null {
  const email = str(user.email) ?? user.pk.slice('USER#'.length)
  if (!email.includes('@')) return null
  return {
    pk: 'USERS',
    sk: `USER#${email}`,
    type: 'userindex',
    email,
    name: str(user.name) ?? email.slice(0, email.lastIndexOf('@')),
    picture: str(user.picture),
    userSlug: str(user.userSlug) ?? '',
    createdAt: str(user.createdAt),
    lastSignInAt: str(user.lastSignInAt) ?? str(user.updatedAt),
    v: 1,
  }
}

async function apply(items: TableItem[], ctx: MigrationContext) {
  await mapLimit(items.filter(isUser), CONCURRENCY, async user => {
    const item = userIndexItem(user)
    if (!item) {
      ctx.count('user skipped (malformed)')
      return
    }
    try {
      await ctx.table.put(item, ifAbsent)
      ctx.count('user indexed')
    } catch (err) {
      if (!(err instanceof ConditionFailed)) throw err
      ctx.count('user present')
    }
  })
}

export const m0003: Migration = {
  id: '0003',
  title: 'users index (expand)',
  auto: true,
  apply,
}
