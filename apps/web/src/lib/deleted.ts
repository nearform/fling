/**
 * Admin → Deleted, worked out apart from React: what each deleted site's row says, the name a
 * restore asks for, what a restore did (`RestoreResult`), what deleting one for good asks and
 * says, and Admin → Usage's line about the
 * deleted sites still kept (`InstanceUsage.deleted`). The contract is @fling/shared's deletion.ts.
 */
import {
  ADMIN_DELETED_PATH,
  type DeletedSite,
  type DeletedUsage,
  purgeConfirmText,
  type RestoreResult,
} from '@fling/shared'
import { formatBytes } from './format'
import { shownFolder } from './paths'

export { ADMIN_DELETED_PATH }

/** A row's name: the site's, or a Path's folder on its site. */
export const deletedLabel = (d: Pick<DeletedSite, 'kind' | 'name' | 'folder'>): string =>
  d.kind === 'path' && d.folder ? `${shownFolder(d.folder)} of ${d.name}` : d.name

/** What to ask before deleting a row for good: a site's or a Path's (its folder on its site). */
export const purgeConfirmOf = (d: Pick<DeletedSite, 'kind' | 'name' | 'folder'>): string =>
  purgeConfirmText(d.name, d.kind === 'path' ? d.folder : undefined)

/** What to say once a row is deleted for good. */
export const purgedText = (d: Pick<DeletedSite, 'kind' | 'name' | 'folder'>): string =>
  `Deleted ${deletedLabel(d)} for good.`

/** The name to send with a site's restore: none when it is the site's own (or left empty). */
export function restoreNameOf(original: string, typed: string): string | undefined {
  const name = typed.trim()
  return name && name !== original ? name : undefined
}

const list = (items: readonly string[]) => items.join(', ')

/** What a restore did, as sentences under the restored site's address. */
export function restoreNotes(result: RestoreResult): string[] {
  const notes: string[] = []
  if (result.paths?.length) {
    notes.push(`Its Paths are back too: ${list(result.paths.map(shownFolder))}.`)
  }
  if (result.adminBecameOwner) notes.push('No owner was left, so you are its owner now.')
  const { emails, groups } = result.dropped
  if (emails.length) {
    notes.push(`Left out, as they are no longer on this Fling: ${list(emails)}.`)
  }
  if (groups.length) notes.push(`Left out, as these groups no longer exist: ${list(groups)}.`)
  if (result.server?.state === 'needs_secrets') {
    notes.push(
      `Its site server is off until its secrets are set: ${list(result.server.secrets)}. Its owner sets them on the site's Server tab, and the server then starts. The static site is live already.`
    )
  } else if (result.server?.state === 'running') {
    notes.push('Its site server is running again.')
  }
  if (!result.folder) notes.push('Its share link is not restored: the owner can share it again.')
  return notes
}

/** The first line of a restore's result: what is back, and where. */
export const restoredHeadline = (result: RestoreResult): string =>
  result.folder
    ? `Restored ${shownFolder(result.folder)} of ${result.name}`
    : `Restored ${result.name}`

/** Admin → Usage's line: how many deleted sites (and Paths) are kept, and about how much. */
export function deletedUsageText(deleted: DeletedUsage): string {
  if (deleted.sites === 0 && deleted.paths === 0) return 'Deleted sites: none kept.'
  const paths = deleted.paths ? `, Paths: ${deleted.paths.toLocaleString()}` : ''
  return `Deleted sites: ${deleted.sites.toLocaleString()}${paths}, about ${formatBytes(deleted.bytes)} kept.`
}
