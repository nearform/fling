/**
 * Deleting a site or a Path, and restoring one (deletion.ts in @fling/shared has what clients
 * share). A delete is soft unless the instance sets `SITE_DELETE=hard` (`config.siteDelete`,
 * advertised as `recoverableDeletes`): it takes the site down and frees its name at once, but keeps
 * its files where they are, with a recovery file beside them, and a deleted-site record lets an
 * admin find it and put it back. What it kept stays until an admin restores it or deletes it for
 * good (purges it) on Admin → Deleted.
 *
 * Soft delete (`removeSite`, and `removeOwnPath` for a Path deleted on its own), in this order:
 *   1. The recovery file, `sites/<siteId>/deleted.json` (`deletedKey`), and one for each of the
 *      site's Paths at `sites/<pathId>/deleted.json` (a Path's files have their own prefix):
 *      `format: 1`, the domain records (never Table items): the site record, its versions,
 *      comments and form responses, its Paths' ids, the names of its secrets (never a value,
 *      sealed or not), who deleted it, when, and the bytes its versions hold. A Path's holds its
 *      Path record and versions. One already there is kept when a deleted-site record names it:
 *      a retried delete keeps the first, complete snapshot. One no record names is left from an
 *      earlier restore and is written afresh.
 *   2. The deleted-site record (`Store.putDeletedSite`), only if none is there: no expiry.
 *   3. The audit entry (`site.delete`, `path.delete`), for every delete, an owner's own included.
 *   4. The teardown, as a hard delete does it but for the files: the site's route and share link,
 *      its Paths (each one's route and records), its server retired on its platform, then its
 *      records (secrets included) and the name claim, last.
 * If 1 or 2 fails the site is untouched and the delete fails; if a later step fails, deleting it
 * again finds the record and the snapshot and finishes. Blobs are keyed by the site's id, so a new
 * site of the same name never touches the files kept. A hard delete is the teardown with the
 * files deleted, and writes no recovery file or record (but is audited).
 *
 * Restore (`restoreSite`, `restorePath`): an admin's, from their browser session only
 * (`admin.deleted.restore`); listing what is kept is any admin credential's (`admin.deleted.read`).
 * It uses only the ports, so it is the same on every platform. Refusals: no record, 404; the
 * recovery file gone (removed from storage by hand), 410 `files_gone`; a purge under way, 409
 * `purge_in_progress`; one this code can't read, 422
 * `recovery_unreadable`; the name held by a live site, 409 `name_taken` with suggestions (it never
 * takes one over: the claim goes through `createSite`'s transaction); records of the site still
 * there (a delete that didn't finish), 409 `delete_incomplete`. A Path's: its site gone, 409
 * `site_gone`; its folder taken, 409 `path_taken`; no room for another live Path, 413 `too_large`
 * (`ensureRoomForLivePath`).
 *
 * Who comes back (`keptPeople`): the owners, publishers and audience as recorded, less the groups
 * that no longer exist and the people no longer on the instance, which the result lists. An owner
 * or publisher must still be a member (admitted by the email policy or ADMIN_EMAILS, or holding a
 * live member invitation while INVITES is on: what naming them needs, `checkMembers`); an audience
 * address must still be able to sign in (the email policy, or a live invitation of either kind).
 * Nobody is invited by a restore. A site restricted before is restricted after, so dropping
 * someone never widens who can open it. When no person owner is left, the restoring admin becomes
 * the owner. The share link isn't restored. The current version goes live again on the site and
 * on its Paths by rewriting their routes from the records (the files passed the secret scan when
 * they were published); an archived site comes back archived. Its site server comes back waiting
 * (`server.awaiting` naming the live version, the route's `x`): with secrets to set it reports
 * `needs_secrets`, and setting the last starts it the usual way (servers/api.ts `startAwaiting`);
 * with none to set it is started now. The static site is live whatever the server does.
 *
 * Restoring is safe to retry when it fails midway: before writing anything it marks the record
 * `restoring` with the name it claims, so a retry knows the records it finds are its own (not an
 * unfinished delete) and carries on under that name once it holds it. It writes the versions,
 * comments and Path records first (idempotent writes into the site's own partitions, which nothing
 * reads without the site), then claims the name and creates the site, then makes it live and
 * writes its routes, then starts its server, queues maintenance (retention applies again) and
 * audits. Only then does it forget the deleted-site record and, after it, the recovery files: a
 * crash between the two leaves a file no record names, which the next delete of the site writes
 * afresh.
 *
 * Purge (`purgeSite`, `purgePath`): an admin's, from their browser session only
 * (`admin.deleted.purge`), as a restore is. It deletes the files kept, `sites/<id>/` for the site
 * and for each Path the record names (a site's: every Path deleted with it), and then the record.
 * The ids come from the record, never the recovery file, so it finishes whether or not that file is
 * still there. It never deletes the files of a live site or Path:
 *   - a record marked `restoring` is refused, 409 `restore_in_progress` (a restore under way, or
 *     one that finished but didn't forget its record);
 *   - then, whatever the record says, any record of the site or of one of those Paths still in the
 *     store (`hasSiteRecords`: a live site, a live Path, or a delete that didn't finish) is refused,
 *     409 `site_live` (`path_live` for a Path deleted on its own, whose folder is checked too);
 *   - then it marks the record `purging` (`Store.markPurging`), only while it isn't `restoring`,
 *     and a restore marks `restoring` only while it isn't `purging`: both conditions are on the
 *     one record item, so exactly one of a purge and a restore racing each other goes ahead. A
 *     restore marks before it writes anything and keeps the mark until it forgets the record, so
 *     a purge that marked first meets no record of the site, and once a restore has marked no
 *     purge can. Ids are random and never reused, so nothing else can bring that id back to life.
 * Then, in this order: the audit entry (`site.purge`, `path.purge`), the files (`deletePrefix`, for
 * each prefix), and the record with its copies, which takes it off the totals. A purge that stops
 * part way is retried by asking again: the record is still there, marked `purging`, and the files
 * already gone are nothing to delete (the retry audits again). A record marked `purging` is never
 * restored: a restore refuses it, 409 `purge_in_progress`.
 */
import {
  type DeletedSite,
  type DeletedSites,
  displayPublishPath,
  isValidSiteName,
  type RestoreResult,
  type RestoreSiteRequest,
  shareKvsKey,
  siteKvsKey,
  siteLabel,
  sitePrefix,
  siteUrl,
} from '@fling/shared'
import { z } from 'zod'
import { ensure } from './admin.ts'
import { audit } from './audit.ts'
import { admittedByConfig } from './auth/standing.ts'
import { deletedKey } from './blobs/types.ts'
import { ApiError, badRequest, conflict, notFound } from './lib/errors.ts'
import { queueMaintenance } from './maintenance.ts'
import {
  ensureRoomForLivePath,
  isLivePath,
  pathRef,
  refreshHome,
  removePath,
  syncPathRoute,
} from './paths.ts'
import { type Actor, type Principal, restrictsToAudience } from './policy.ts'
import { startAwaiting } from './servers/api.ts'
import { SERVER_PATH_FOLDER, serverSite } from './servers/index.ts'
import { nameTaken, writeSite } from './sites.ts'
import {
  type CommentRecord,
  type DeletedSiteRecord,
  firstOwner,
  isLiveInvitation,
  type PathRecord,
  type ServerMark,
  type SiteAudience,
  type SiteRecord,
  type SiteRoleList,
  type User,
  type VersionRecord,
} from './store/types.ts'
import type { Deps } from './types.ts'

/** The recovery file's format: the one this code writes and reads. */
export const RECOVERY_FORMAT = 1

/** Deleted sites `GET /api/admin/deleted` lists at most, newest first. */
export const DELETED_LIST_MAX = 500

/** Whether a delete on this instance keeps the files (`SITE_DELETE=soft`, the default). */
export const softDeletes = (deps: Pick<Deps, 'config'>) => deps.config.siteDelete === 'soft'

// --- the recovery file ---------------------------------------------------------------------------

const RoleListSchema = z.object({ emails: z.array(z.string()), groups: z.array(z.string()) })

/** The fields a restore relies on; the rest of each record passes through as it was written. */
const SiteSnapshotSchema = z.looseObject({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  visibility: z.enum(['public', 'private']),
  spa: z.boolean(),
  archived: z.boolean(),
  currentVersionId: z.string().nullable(),
  audience: RoleListSchema,
  restricted: z.boolean().optional(),
  owners: RoleListSchema,
  publishers: RoleListSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

const VersionSnapshotSchema = z.looseObject({
  siteId: z.string(),
  id: z.string(),
  status: z.enum(['pending', 'complete', 'pruning', 'sweeping']),
  fileCount: z.number(),
  totalBytes: z.number(),
  createdAt: z.string(),
})

const CommentSnapshotSchema = z.looseObject({
  siteId: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  path: z.string(),
  body: z.string(),
  createdAt: z.string(),
})

const PathSnapshotSchema = z.looseObject({
  siteId: z.string(),
  folder: z.string(),
  id: z.string(),
  currentVersionId: z.string().nullable(),
  owners: RoleListSchema,
  publishers: RoleListSchema,
  archived: z.boolean(),
  title: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const Deletion = {
  format: z.literal(RECOVERY_FORMAT),
  deletedBy: z.string(),
  deletedAt: z.string(),
  /** the bytes its versions hold, from their records (a Path's: its own) */
  bytes: z.number(),
}

/** `sites/<siteId>/deleted.json`. */
export const SiteRecoverySchema = z.object({
  ...Deletion,
  kind: z.literal('site'),
  site: SiteSnapshotSchema,
  versions: z.array(VersionSnapshotSchema),
  comments: z.array(CommentSnapshotSchema),
  paths: z.array(z.object({ folder: z.string(), pathId: z.string() })),
  /** the names of its secrets; never a value */
  secrets: z.array(z.string()),
})
export type SiteRecovery = z.infer<typeof SiteRecoverySchema>

/** `sites/<pathId>/deleted.json`: a Path's, deleted with its site or on its own. */
export const PathRecoverySchema = z.object({
  ...Deletion,
  kind: z.literal('path'),
  siteId: z.string(),
  siteName: z.string(),
  path: PathSnapshotSchema,
  versions: z.array(VersionSnapshotSchema),
})
export type PathRecovery = z.infer<typeof PathRecoverySchema>

/** What a delete writes: the same files, with the records as the store has them. */
type SiteRecoveryFile = Omit<SiteRecovery, 'site' | 'versions' | 'comments'> & {
  site: SiteRecord
  versions: VersionRecord[]
  comments: CommentRecord[]
}
type PathRecoveryFile = Omit<PathRecovery, 'path' | 'versions'> & {
  path: PathRecord
  versions: VersionRecord[]
}

const bytesOf = (versions: readonly Pick<VersionRecord, 'totalBytes'>[]) =>
  versions.reduce((n, v) => n + (v.totalBytes || 0), 0)

/**
 * Write a recovery file unless it is the first snapshot of a delete under way: one is there and
 * a deleted-site record names it (`recorded`). `build` is asked only when it is written.
 */
async function writeRecovery(
  deps: Deps,
  storageId: string,
  recorded: boolean,
  build: () => Promise<SiteRecoveryFile | PathRecoveryFile>
) {
  const key = deletedKey(storageId)
  if (recorded && (await deps.blobs.head(key))) return
  await deps.blobs.putJson(key, await build())
}

async function pathRecovery(
  deps: Deps,
  site: SiteRecord,
  path: PathRecord,
  by: string,
  at: string
): Promise<PathRecoveryFile> {
  const versions = await deps.store.listVersions(pathRef(site, path))
  return {
    format: RECOVERY_FORMAT,
    kind: 'path',
    deletedBy: by,
    deletedAt: at,
    bytes: bytesOf(versions),
    siteId: site.id,
    siteName: site.name,
    path,
    versions,
  }
}

/** The recovery file of `storageId`, checked: 410 `files_gone` when it isn't there. */
async function readRecovery<S extends z.ZodType>(
  deps: Deps,
  storageId: string,
  schema: S,
  what: string
): Promise<z.infer<S>> {
  const raw = await deps.blobs.getJson<unknown>(deletedKey(storageId))
  if (raw === null) {
    throw new ApiError(
      410,
      'files_gone',
      `The files of ${what} are gone from storage: it can't be restored`,
      { storageId }
    )
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError(
      422,
      'recovery_unreadable',
      `The recovery file of ${what} (${deletedKey(storageId)}) isn't one this Fling reads (format ${RECOVERY_FORMAT}): its files are still in storage, to recover by hand`,
      { storageId }
    )
  }
  return parsed.data
}

// --- deleting ------------------------------------------------------------------------------------

/**
 * Delete a site `actor` (resolved against it) may delete, soft or hard as the instance deletes
 * (see the header).
 */
export async function removeSite(deps: Deps, user: User, actor: Actor, site: SiteRecord) {
  const soft = softDeletes(deps)
  const paths = await deps.store.listPaths(site.id)
  if (soft) {
    const at = deps.clock.now().toISOString()
    const recorded = (await deps.store.getDeletedSite('site', site.id)) !== null
    const pathBytes: number[] = []
    for (const path of paths) {
      await writeRecovery(deps, path.id, recorded, async () => {
        const file = await pathRecovery(deps, site, path, user.email, at)
        pathBytes.push(file.bytes)
        return file
      })
    }
    let bytes = 0
    await writeRecovery(deps, site.id, recorded, async () => {
      const [versions, comments, secrets] = await Promise.all([
        deps.store.listVersions(site),
        deps.store.listComments(site.id),
        deps.store.listSiteSecrets(site.id),
      ])
      bytes = bytesOf(versions) + pathBytes.reduce((n, b) => n + b, 0)
      return {
        format: RECOVERY_FORMAT,
        kind: 'site',
        deletedBy: user.email,
        deletedAt: at,
        bytes,
        site,
        versions,
        comments,
        paths: paths.map(p => ({ folder: p.folder, pathId: p.id })),
        secrets: secrets.map(s => s.name),
      }
    })
    if (!recorded) {
      await deps.store.putDeletedSite({
        kind: 'site',
        siteId: site.id,
        name: site.name,
        owner: firstOwner(site),
        deletedBy: user.email,
        deletedAt: at,
        bytes,
        paths: paths.map(p => ({ folder: p.folder, pathId: p.id })),
      })
    }
  }
  await audit(deps, {
    action: 'site.delete',
    actor: actor.kind === 'user' ? actor.email : user.email,
    target: site.name,
    owner: firstOwner(site),
    siteId: site.id,
    change: soft ? 'soft' : 'hard',
  })
  await deps.routeTable.delete(siteKvsKey(siteLabel(site.name)))
  if (site.shareToken) await deps.routeTable.delete(shareKvsKey(site.shareToken))
  for (const path of paths) await removePath(deps, site, path)
  if (site.server && deps.servers) await deps.servers.retire(serverSite(site))
  if (!soft) await deps.blobs.deletePrefix(sitePrefix(site.id))
  await deps.store.deleteSite(site)
}

/**
 * Delete one Path of a site (the caller refreshes the site's home page), soft or hard as the
 * instance deletes: a soft delete keeps its files with a recovery file and a record of its own,
 * under its site's name.
 */
export async function removeOwnPath(deps: Deps, user: User, site: SiteRecord, path: PathRecord) {
  const soft = softDeletes(deps)
  if (soft) {
    const at = deps.clock.now().toISOString()
    const recorded = (await deps.store.getDeletedSite('path', path.id)) !== null
    let bytes = 0
    await writeRecovery(deps, path.id, recorded, async () => {
      const file = await pathRecovery(deps, site, path, user.email, at)
      bytes = file.bytes
      return file
    })
    if (!recorded) {
      await deps.store.putDeletedSite({
        kind: 'path',
        siteId: site.id,
        name: site.name,
        folder: path.folder,
        pathId: path.id,
        owner: path.owners.emails[0] ?? firstOwner(site),
        deletedBy: user.email,
        deletedAt: at,
        bytes,
      })
    }
  }
  await audit(deps, {
    action: 'path.delete',
    actor: user.email,
    target: `${site.name}/${path.folder}`,
    owner: firstOwner(site),
    siteId: site.id,
    change: soft ? 'soft' : 'hard',
  })
  await removePath(deps, site, path)
}

// --- listing -------------------------------------------------------------------------------------

const toDeletedSite = (r: DeletedSiteRecord): DeletedSite => ({
  kind: r.kind,
  siteId: r.siteId,
  name: r.name,
  ...(r.folder !== undefined ? { folder: r.folder } : {}),
  ...(r.pathId !== undefined ? { pathId: r.pathId } : {}),
  owner: r.owner,
  deletedBy: r.deletedBy,
  deletedAt: r.deletedAt,
  bytes: r.bytes,
  ...(r.paths ? { paths: r.paths } : {}),
})

/**
 * GET /api/admin/deleted[?name=]: the deleted sites and Paths kept, newest first (at most
 * DELETED_LIST_MAX); `name`, only those deleted under exactly that site name.
 */
export async function listDeleted(deps: Deps, p: Principal, name?: string): Promise<DeletedSites> {
  ensure(p, 'admin.deleted.read')
  const named = name?.trim().toLowerCase() || undefined
  if (named !== undefined && !isValidSiteName(named)) return { deleted: [] }
  const records = await deps.store.listDeletedSites({ name: named, limit: DELETED_LIST_MAX })
  return { deleted: records.map(toDeletedSite) }
}

// --- restoring -----------------------------------------------------------------------------------

interface Dropped {
  emails: Set<string>
  groups: Set<string>
}

/** Whether each address may still be named (see the header): `role`, a member; else signs in. */
async function stillHere(
  deps: Deps,
  emails: readonly string[],
  as: 'role' | 'audience'
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const email of new Set(emails)) {
    if (admittedByConfig(deps.config, email)) out.add(email)
    else if (deps.config.invites) {
      const invitation = await deps.store.getInvitation(email)
      if (isLiveInvitation(invitation) && (as === 'audience' || invitation.role === 'member')) {
        out.add(email)
      }
    }
  }
  return out
}

/**
 * The owners, publishers and audience to restore: as recorded, less the groups that are gone and
 * the people no longer on the instance (added to `dropped`).
 */
async function keptPeople<
  T extends { owners: SiteRoleList; publishers: SiteRoleList; audience?: SiteAudience },
>(deps: Deps, record: T, dropped: Dropped): Promise<Pick<T, 'owners' | 'publishers' | 'audience'>> {
  const lists = [record.owners, record.publishers, ...(record.audience ? [record.audience] : [])]
  const groupIds = [...new Set(lists.flatMap(l => l.groups))]
  const groups = new Set((await deps.store.getGroups(groupIds)).map(g => g.id))
  const members = await stillHere(
    deps,
    [...record.owners.emails, ...record.publishers.emails],
    'role'
  )
  const viewers = record.audience
    ? await stillHere(deps, record.audience.emails, 'audience')
    : new Set<string>()
  const keep = (list: SiteRoleList, here: Set<string>): SiteRoleList => {
    for (const e of list.emails) if (!here.has(e)) dropped.emails.add(e)
    for (const g of list.groups) if (!groups.has(g)) dropped.groups.add(g)
    return {
      emails: list.emails.filter(e => here.has(e)),
      groups: list.groups.filter(g => groups.has(g)),
    }
  }
  return {
    owners: keep(record.owners, members),
    publishers: keep(record.publishers, members),
    ...(record.audience ? { audience: keep(record.audience, viewers) } : {}),
  } as Pick<T, 'owners' | 'publishers' | 'audience'>
}

/** Make `email` an owner (and no longer a publisher). */
function ownedBy(roles: { owners: SiteRoleList; publishers: SiteRoleList }, email: string) {
  roles.owners = { ...roles.owners, emails: [...roles.owners.emails, email] }
  roles.publishers = {
    ...roles.publishers,
    emails: roles.publishers.emails.filter(e => e !== email),
  }
}

const siteUrlOf = (deps: Deps, name: string) =>
  siteUrl(siteLabel(name), deps.config.sitesDomain, `${deps.config.siteScheme}:`)

const droppedOf = (d: Dropped) => ({ emails: [...d.emails], groups: [...d.groups] })

/** 409 `delete_incomplete`: the delete stopped part way, so its records are still there. */
const deleteIncomplete = (what: string) =>
  conflict(
    `${what} was not fully deleted (some of its records are still there): delete it again first, then restore it`,
    'delete_incomplete'
  )

/** Why a record couldn't be marked: a purge under way holds it (409), else it is gone (404). */
async function markRefused(deps: Deps, record: DeletedSiteRecord, missing: string) {
  const now = await deps.store.getDeletedSite(record.kind, deletedIdOf(record))
  return now?.purging ? purgeInProgress() : notFound(missing)
}

/** 409 `purge_in_progress`: an admin is deleting it for good. */
const purgeInProgress = () =>
  conflict(
    "It is being deleted for good (its files are being removed from storage): it can't be restored",
    'purge_in_progress'
  )

const deletedIdOf = (r: DeletedSiteRecord) => (r.kind === 'path' ? (r.pathId ?? '') : r.siteId)

/** Forget what a restore used: the record first, then the recovery files (see the header). */
async function forget(deps: Deps, record: DeletedSiteRecord, storageIds: readonly string[]) {
  await deps.store.deleteDeletedSite(record)
  for (const id of storageIds) await deps.blobs.delete(deletedKey(id))
}

/**
 * The server state a restored site comes back with: waiting, as `awaiting` names its live
 * version, so the route says `x` until it starts; the admin's stop and raised limits as they were.
 */
function waitingServer(
  site: Pick<SiteRecord, 'server'>,
  version: VersionRecord & { server: ServerMark }
): SiteRecord['server'] {
  const { stopped, limits } = site.server ?? {}
  return {
    ...(stopped ? { stopped } : {}),
    ...(limits ? { limits } : {}),
    awaiting: { versionId: version.id, secrets: [...version.server.secrets] },
  }
}

/** POST /api/admin/deleted/:siteId/restore (see the header). */
export async function restoreSite(
  deps: Deps,
  user: User,
  p: Principal,
  siteId: string,
  req: RestoreSiteRequest
): Promise<RestoreResult> {
  ensure(p, 'admin.deleted.restore')
  const record = await deps.store.getDeletedSite('site', siteId)
  if (record?.kind !== 'site') throw notFound(`No deleted site ${siteId}`)
  if (record.purging) throw purgeInProgress()
  const what = `"${record.name}" (${siteId})`
  const file = await readRecovery(deps, siteId, SiteRecoverySchema, what)
  const pathFiles: PathRecovery[] = []
  for (const { folder, pathId } of file.paths) {
    pathFiles.push(
      await readRecovery(
        deps,
        pathId,
        PathRecoverySchema,
        `${displayPublishPath(folder)} of ${what}`
      )
    )
  }

  // The name: the one a restore under way holds, else the one asked for, else its own.
  const held = record.restoring
    ? (await deps.store.getNameClaim(record.restoring.name))?.siteId === siteId
    : false
  const name = held && record.restoring ? record.restoring.name : (req.name ?? file.site.name)
  if (!isValidSiteName(name)) throw badRequest(`"${name}" is not a valid site name`, 'invalid_name')
  if (!held) {
    const claim = await deps.store.getNameClaim(name)
    if (claim && claim.siteId !== siteId) throw await nameTaken(deps, user, name)
    if (!record.restoring) {
      const left = await Promise.all([
        deps.store.hasSiteRecords(siteId),
        ...file.paths.map(p => deps.store.hasSiteRecords(p.pathId)),
      ])
      if (left.some(Boolean)) throw deleteIncomplete(what)
    }
    const at = deps.clock.now().toISOString()
    if (!(await deps.store.markRestoring(record, { name, by: user.email, at }))) {
      throw await markRefused(deps, record, `No deleted site ${siteId}`)
    }
  }

  // Who comes back.
  const dropped: Dropped = { emails: new Set(), groups: new Set() }
  const people = await keptPeople(deps, file.site as unknown as SiteRecord, dropped)
  const adminBecameOwner = people.owners.emails.length === 0
  if (adminBecameOwner) ownedBy(people, user.email)

  // The records, into the site's own partitions: nothing reads them until the site exists.
  const original = file.site as unknown as SiteRecord
  const ref = { id: siteId, email: original.email }
  for (const v of file.versions) await deps.store.putVersion(ref, v as unknown as VersionRecord)
  for (const c of file.comments) await deps.store.createComment(c as unknown as CommentRecord)
  const paths: PathRecord[] = []
  for (const pf of pathFiles) {
    const recorded = pf.path as unknown as PathRecord
    const path: PathRecord = { ...recorded, siteId, ...(await keptPeople(deps, recorded, dropped)) }
    for (const v of pf.versions) {
      await deps.store.putVersion(pathRef(ref, path), v as unknown as VersionRecord)
    }
    if (!(await deps.store.createPath(path))) {
      const there = await deps.store.getPath(siteId, path.folder)
      if (there?.id !== path.id) throw deleteIncomplete(what)
    }
    paths.push(path)
  }

  // The name, through the usual claim; then the site goes live as it was.
  const {
    shareToken: _share,
    server: _server,
    paths: _paths,
    home: _home,
    revision: _revision,
    ...kept
  } = original
  const created = await deps.store.createSite({
    ...kept,
    id: siteId,
    name,
    owners: people.owners,
    publishers: people.publishers,
    audience: people.audience ?? { emails: [], groups: [] },
    // Restricted as before, so dropping someone never widens who can open it.
    restricted: restrictsToAudience(original),
    shareToken: null,
    currentVersionId: null,
    archived: false,
  })
  if (created?.id !== siteId) throw await nameTaken(deps, user, name)
  const site = created
  const current = original.currentVersionId
    ? await deps.store.getVersion(site, original.currentVersionId)
    : null
  const withServer = current?.server ? (current as VersionRecord & { server: ServerMark }) : null
  // Every save changes `updatedAt`, so this one writes the role items and grants afresh.
  await writeSite(deps, site, s => {
    s.currentVersionId = current ? current.id : null
    s.archived = original.archived
    if (withServer) s.server = waitingServer(original, withServer)
    else delete s.server
    return true
  })
  for (const path of paths) await syncPathRoute(deps, site, path)
  if (paths.length > 0) await refreshHome(deps, site)

  let server: RestoreResult['server']
  if (withServer) {
    const started = await startAwaiting(deps, user, site, withServer)
    if (started.missing) server = { state: 'needs_secrets', secrets: started.missing }
    else if (started.deployed && 'url' in started.deployed) server = { state: 'running' }
    else server = { state: 'failed', message: started.deployed?.message ?? 'It did not start' }
  }
  await queueMaintenance(deps, site)
  await audit(deps, {
    action: 'site.restore',
    actor: user.email,
    target: name,
    owner: firstOwner(site),
    siteId,
  })
  await forget(deps, record, [siteId, ...file.paths.map(p => p.pathId)])
  return {
    name,
    url: siteUrlOf(deps, name),
    dropped: droppedOf(dropped),
    adminBecameOwner,
    ...(server ? { server } : {}),
    ...(paths.length ? { paths: paths.map(p => p.folder) } : {}),
  }
}

/** POST /api/admin/deleted/:siteId/paths/:pathId/restore (see the header). */
export async function restorePath(
  deps: Deps,
  user: User,
  p: Principal,
  siteId: string,
  pathId: string
): Promise<RestoreResult> {
  ensure(p, 'admin.deleted.restore')
  const record = await deps.store.getDeletedSite('path', pathId)
  if (record?.kind !== 'path' || record.siteId !== siteId) {
    throw notFound(`No deleted Path ${pathId} of ${siteId}`)
  }
  if (record.purging) throw purgeInProgress()
  const what = `${displayPublishPath(record.folder ?? '')} of "${record.name}"`
  const file = await readRecovery(deps, pathId, PathRecoverySchema, what)
  const stored = await deps.store.getSiteById(siteId)
  const site = stored ? await deps.store.findSite(stored.name) : null
  if (!site || site.id !== siteId) {
    throw conflict(
      `The site ${what} belonged to is no longer there: restore the site first`,
      'site_gone'
    )
  }
  const recorded = file.path as unknown as PathRecord
  const folder = recorded.folder
  const there = await deps.store.getPath(siteId, folder)
  const resumed = there?.id === pathId
  const taken = () =>
    conflict(
      `"${site.name}" has a Path at ${displayPublishPath(folder)} already: delete or archive it first`,
      'path_taken'
    )
  if (there && !resumed) throw taken()
  if (!resumed) {
    if (!record.restoring && (await deps.store.hasSiteRecords(pathId))) {
      throw deleteIncomplete(what)
    }
    if (folder === SERVER_PATH_FOLDER && site.server?.live) {
      throw conflict(
        `"${site.name}" has a site server, which answers at /${SERVER_PATH_FOLDER}/: a Path there would be hidden`,
        'path_conflict'
      )
    }
    if (isLivePath(recorded)) await ensureRoomForLivePath(deps, site, null)
    const at = deps.clock.now().toISOString()
    if (!(await deps.store.markRestoring(record, { name: site.name, by: user.email, at }))) {
      throw await markRefused(deps, record, `No deleted Path ${pathId} of ${siteId}`)
    }
  }

  const dropped: Dropped = { emails: new Set(), groups: new Set() }
  const people = await keptPeople(deps, recorded, dropped)
  const adminBecameOwner = people.owners.emails.length === 0
  if (adminBecameOwner) ownedBy(people, user.email)
  const path: PathRecord = { ...recorded, siteId, ...people }
  for (const v of file.versions) {
    await deps.store.putVersion(pathRef(site, path), v as unknown as VersionRecord)
  }
  if (!resumed && !(await deps.store.createPath(path))) {
    if ((await deps.store.getPath(siteId, folder))?.id !== pathId) throw taken()
  }
  await syncPathRoute(deps, site, path)
  await refreshHome(deps, site)
  await queueMaintenance(deps, site)
  await audit(deps, {
    action: 'path.restore',
    actor: user.email,
    target: `${site.name}/${folder}`,
    owner: firstOwner(site),
    siteId,
  })
  await forget(deps, record, [pathId])
  return {
    name: site.name,
    folder,
    url: `${siteUrlOf(deps, site.name)}${encodeURIComponent(folder)}/`,
    dropped: droppedOf(dropped),
    adminBecameOwner,
  }
}

// --- purging -------------------------------------------------------------------------------------

/** 409: what a purge refuses rather than delete the files of something live (see the header). */
async function ensurePurgeable(
  deps: Deps,
  record: DeletedSiteRecord,
  what: string,
  storageIds: readonly string[],
  code: 'site_live' | 'path_live'
) {
  if (record.restoring) {
    throw conflict(
      `${what} is being restored (or was, and its record is left): it can't be deleted for good`,
      'restore_in_progress'
    )
  }
  const left = await Promise.all(storageIds.map(id => deps.store.hasSiteRecords(id)))
  if (left.some(Boolean)) {
    throw conflict(
      `${what} still has records in the store (it is live again, or its delete didn't finish): its files are kept`,
      code
    )
  }
}

/** Mark the purge under way, audit it, delete each prefix, then forget the record (see the header). */
async function purge(
  deps: Deps,
  user: User,
  record: DeletedSiteRecord,
  storageIds: readonly string[],
  entry: { action: 'site.purge' | 'path.purge'; target: string },
  what: string
) {
  const at = deps.clock.now().toISOString()
  if (!(await deps.store.markPurging(record, { by: user.email, at }))) {
    const now = await deps.store.getDeletedSite(record.kind, deletedIdOf(record))
    if (!now) throw notFound(`No deleted ${what}`)
    throw conflict(`${what} is being restored: it can't be deleted for good`, 'restore_in_progress')
  }
  await audit(deps, {
    action: entry.action,
    actor: user.email,
    target: entry.target,
    owner: record.owner,
    siteId: record.siteId,
  })
  for (const id of storageIds) await deps.blobs.deletePrefix(sitePrefix(id))
  await deps.store.deleteDeletedSite(record)
}

/** DELETE /api/admin/deleted/:siteId: a deleted site's files for good, its Paths' too. */
export async function purgeSite(deps: Deps, user: User, p: Principal, siteId: string) {
  ensure(p, 'admin.deleted.purge')
  const record = await deps.store.getDeletedSite('site', siteId)
  if (record?.kind !== 'site') throw notFound(`No deleted site ${siteId}`)
  const what = `"${record.name}" (${siteId})`
  const storageIds = [siteId, ...(record.paths ?? []).map(p => p.pathId)]
  await ensurePurgeable(deps, record, what, storageIds, 'site_live')
  await purge(deps, user, record, storageIds, { action: 'site.purge', target: record.name }, what)
}

/** DELETE /api/admin/deleted/:siteId/paths/:pathId: a Path deleted on its own, for good. */
export async function purgePath(
  deps: Deps,
  user: User,
  p: Principal,
  siteId: string,
  pathId: string
) {
  ensure(p, 'admin.deleted.purge')
  const record = await deps.store.getDeletedSite('path', pathId)
  if (record?.kind !== 'path' || record.siteId !== siteId) {
    throw notFound(`No deleted Path ${pathId} of ${siteId}`)
  }
  const folder = record.folder ?? ''
  const what = `${displayPublishPath(folder)} of "${record.name}"`
  await ensurePurgeable(deps, record, what, [pathId], 'path_live')
  // Its Path record lives in its site's partition, which hasSiteRecords(pathId) doesn't read.
  if ((await deps.store.getPath(siteId, folder))?.id === pathId) {
    throw conflict(`${what} is live again: its files are kept`, 'path_live')
  }
  await purge(
    deps,
    user,
    record,
    [pathId],
    { action: 'path.purge', target: `${record.name}/${folder}` },
    what
  )
}
