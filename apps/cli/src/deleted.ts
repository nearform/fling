/**
 * Deleted sites from the CLI and the local MCP (deletion.ts in `@fling/shared`): `fling admin
 * deleted [name]` and `fling_admin_deleted`. Listing reads `GET /api/admin/deleted`, a page at a time, which
 * answers any admin credential and refuses everyone else (403, or 404 as for a missing route).
 * Restoring and deleting for good are an admin's, from their browser session at Admin → Deleted
 * (`ADMIN_DELETED_PATH`): neither the CLI nor the MCP does either, they print the link.
 */
import {
  ADMIN_DELETED_PATH,
  DELETED_PAGE_MAX,
  type DeletedOrder,
  type DeletedSite,
  DeletedSitesSchema,
  type InstanceMetadata,
} from '@fling/shared'
import { type ApiClient, CliApiError } from './api.ts'
import { formatBytes, formatDate } from './utils/output.ts'

/** Admin → Deleted in the app: where an admin restores a deleted site or Path, or deletes it for good. */
export const adminDeletedUrl = (appOrigin: string) =>
  `${appOrigin.replace(/\/+$/, '')}${ADMIN_DELETED_PATH}`

/** The line a listing of deleted sites ends with. */
export const restoreLine = (appOrigin: string) =>
  `Restore or delete for good from Admin → Deleted: ${adminDeletedUrl(appOrigin)}`

/** How to list: one site name's, oldest first, a page of `limit` from `cursor`, or every page (`all`). */
export interface DeletedListOptions {
  name?: string
  order?: DeletedOrder
  limit?: number
  cursor?: string
  all?: boolean
  instanceName?: string
}

/**
 * The deleted sites and Paths, newest first unless `order` is `oldest`: one page (the server's
 * page size unless `limit` says), or with `all` every page; `name` lists one site name's and its
 * Paths'. `cursor`: where the next page starts, null when there are no more.
 */
export async function listDeleted(
  client: ApiClient,
  opts: DeletedListOptions = {}
): Promise<{ deleted: DeletedSite[]; cursor: string | null }> {
  const deleted: DeletedSite[] = []
  let cursor: string | undefined = opts.cursor || undefined
  try {
    do {
      const page = await client.request('GET', '/api/admin/deleted', {
        schema: DeletedSitesSchema,
        query: {
          name: opts.name,
          order: opts.order,
          limit: opts.all ? DELETED_PAGE_MAX : opts.limit,
          cursor,
        },
      })
      deleted.push(...page.deleted)
      cursor = page.cursor ?? undefined
    } while (opts.all && cursor)
  } catch (error) {
    if (error instanceof CliApiError && (error.status === 403 || error.status === 404)) {
      throw new CliApiError({
        status: 403,
        code: 'forbidden',
        message: `Only an admin of ${opts.instanceName ?? 'this Fling'} can list its deleted sites`,
        hint: 'Sign in as an admin (`fling whoami` says who you are), or ask one to recover the site.',
        cause: error,
      })
    }
    throw error
  }
  return { deleted, cursor: cursor ?? null }
}

/** What was deleted: `pitch-deck`, or a Path's `PAY-412/ of team`. */
export const deletedWhat = (d: DeletedSite) =>
  d.kind === 'path' ? `${d.folder}/ of ${d.name}` : d.name

/** One deleted site or Path on a line, for the MCP and a plain listing. */
export function describeDeletedSite(d: DeletedSite): string {
  const paths = d.paths?.length
    ? `, with its Paths ${d.paths.map(p => `${p.folder}/`).join(', ')}`
    : ''
  return `- ${deletedWhat(d)} (${d.kind === 'path' ? 'a Path' : 'site'} ${d.siteId}): owner ${d.owner}, deleted by ${d.deletedBy} ${formatDate(d.deletedAt)}, ${formatBytes(d.bytes)} kept${paths}`
}

/** `3 deleted sites and Paths on Fling` and the lines, or that there are none. */
export function describeDeleted(
  deleted: readonly DeletedSite[],
  instance: Pick<InstanceMetadata, 'name'> | null,
  opts: { name?: string; order?: DeletedOrder } = {}
): string {
  const fling = instance?.name ?? 'this Fling'
  if (deleted.length === 0) {
    return opts.name
      ? `Nothing named ${opts.name} was deleted on ${fling}.`
      : `No deleted sites on ${fling}.`
  }
  const order = opts.order === 'oldest' ? 'oldest first' : 'newest first'
  return `${deleted.length} deleted site(s) and Path(s) on ${fling}, ${order}:\n${deleted.map(describeDeletedSite).join('\n')}`
}
