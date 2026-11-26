/**
 * Soft delete and restore: what the API, the CLI, the MCP servers and the web UI share about a
 * deleted site. Browser-safe (zod only).
 *
 * A delete is soft unless the instance sets `SITE_DELETE=hard`, advertised as the
 * `recoverableDeletes` capability. A soft delete frees the name and takes the site down, but its
 * files stay in the blob store with a recovery file (`deleted.json`) beside them, and a deleted-site
 * record lets an admin find it. They stay until an admin restores them or deletes them for good
 * (purges them), both from their browser session (Admin → Deleted): a leaked key or token must not
 * be able to put back what someone took down, nor destroy what could still be put back.
 * Listing them is any admin credential's (`fling admin deleted`, `fling_admin_deleted`).
 *
 * The wording people see about a delete lives here, so every client says the same thing.
 */
import { z } from 'zod'
import type { InstanceMetadata } from './instance.ts'

/** Whether the instance's deletes can be recovered by an admin (the `recoverableDeletes` capability). */
export const recoverableDeletesOf = (
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean => instance?.capabilities?.recoverableDeletes === true

/** One deleted site, or one Path deleted on its own (`kind: 'path'`), as `GET /api/admin/deleted` lists it. */
export const DeletedSiteSchema = z.object({
  kind: z.enum(['site', 'path']),
  /** the site's id: its prefix `sites/<siteId>/` and its `deleted.json` */
  siteId: z.string(),
  /** the site's name when it was deleted (a Path's: its site's name then) */
  name: z.string(),
  /** a Path's folder and storage id (`sites/<pathId>/`) */
  folder: z.string().optional(),
  pathId: z.string().optional(),
  /** the site's (or Path's) first owner's address when it was deleted */
  owner: z.string(),
  deletedBy: z.string(),
  deletedAt: z.string(),
  /** the bytes kept: every kept version's files, from their manifests (a guide, not a ledger) */
  bytes: z.number().int().nonnegative(),
  /** a site's Paths, deleted with it and restored with it */
  paths: z.array(z.object({ folder: z.string(), pathId: z.string() })).optional(),
})
export type DeletedSite = z.infer<typeof DeletedSiteSchema>

/** The order `GET /api/admin/deleted` lists in: by when each was deleted. */
export const DeletedOrderSchema = z.enum(['newest', 'oldest'])
export type DeletedOrder = z.infer<typeof DeletedOrderSchema>

/** Deleted sites a page of `GET /api/admin/deleted` holds unless `limit` says, and at most. */
export const DELETED_PAGE = 50
export const DELETED_PAGE_MAX = 500

/**
 * `GET /api/admin/deleted?name=&order=&limit=&cursor=`: one page, newest first unless `order` is
 * `oldest`; `name` lists one site name's deletes and its Paths'.
 */
export const DeletedSitesSchema = z.object({
  deleted: z.array(DeletedSiteSchema),
  /** pass back as `cursor` (with the same `name` and `order`) for the next page; null or absent: no more */
  cursor: z.string().nullable().optional(),
})
export type DeletedSites = z.infer<typeof DeletedSitesSchema>

/** `POST /api/admin/deleted/:siteId/restore`: the name to restore it under, when not its own. */
export const RestoreSiteRequestSchema = z.object({ name: z.string().optional() })
export type RestoreSiteRequest = z.infer<typeof RestoreSiteRequestSchema>

/**
 * What a restore did (a site's, or a Path's: `POST /api/admin/deleted/:siteId/paths/:pathId/restore`).
 * The static site is live whatever `server` says.
 */
export const RestoreResultSchema = z.object({
  name: z.string(),
  /** a Path's folder */
  folder: z.string().optional(),
  /** the site's (or the Path's site's) address */
  url: z.string(),
  /** who could not be restored: groups that no longer exist, people no longer on the instance */
  dropped: z.object({ emails: z.array(z.string()), groups: z.array(z.string()) }),
  /** no owner was left, so the restoring admin became the owner */
  adminBecameOwner: z.boolean(),
  /**
   * its site server: back and running; waiting for these secrets to be set, after which it starts
   * the usual way; or, with every secret it declares set (or none declared), it could not start
   * (`message`: why), and is tried again the next time a secret is set or removed
   */
  server: z
    .union([
      z.object({ state: z.literal('running') }),
      z.object({ state: z.literal('needs_secrets'), secrets: z.array(z.string()) }),
      z.object({ state: z.literal('failed'), message: z.string() }),
    ])
    .optional(),
  /** its Paths deleted with it, restored too (a site's restore) */
  paths: z.array(z.string()).optional(),
})
export type RestoreResult = z.infer<typeof RestoreResultSchema>

/** Admin → Usage's line about deleted sites (`InstanceUsage.deleted`). */
export const DeletedUsageSchema = z.object({
  /** deleted sites still kept, and Paths deleted on their own */
  sites: z.number().int().nonnegative(),
  paths: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
export type DeletedUsage = z.infer<typeof DeletedUsageSchema>

/** The app's page where an admin restores deleted sites. */
export const ADMIN_DELETED_PATH = '/admin/deleted'

/** What to ask before deleting `name` (a Path: `folder` of `name`). */
export function deleteConfirmText(recoverable: boolean, name: string, folder?: string): string {
  const what = folder ? `${folder}/ of ${name}` : name
  const gone = folder
    ? 'Its pages stop being served.'
    : 'Its link stops working and the name is freed.'
  const after = recoverable ? 'An admin can recover it.' : "This can't be undone."
  return `Delete ${what}? ${gone} ${after}`
}

/** What to say once `name` (or `folder` of it) is deleted. */
export function deletedText(recoverable: boolean, name: string, folder?: string): string {
  const what = folder ? `${folder}/ of ${name}` : name
  return recoverable ? `Deleted ${what}. An admin can recover it.` : `Deleted ${what} for good.`
}

/** What to ask before deleting a kept site (a Path: `folder` of `name`) for good on Admin → Deleted. */
export function purgeConfirmText(name: string, folder?: string): string {
  const what = folder ? `${folder}/ of ${name}` : name
  return `Delete ${what} for good? Its files are removed from storage and it can't be restored.`
}
