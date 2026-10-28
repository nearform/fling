/**
 * Comments on a site, for the API routes and the remote MCP tools: list, add (a thread or a reply),
 * resolve/reopen a thread, delete. The site is found by name and every operation asks policy.ts
 * (`comment.*`); a refusal is the same 404 as a site nobody holds. With comments turned off
 * (config `comments`, the `comments` capability) every operation is a 404 too.
 *
 * What a comment is attached to (contract and limitation in @fling/shared/comments): a page path
 * and the version being served when it was made. Comments outlive versions; deleting the site
 * deletes them with its partition.
 *
 * Every change (add, resolve, reopen, delete) tells the site's live room `comments`, so open
 * review pages refetch the list (through policy) at once.
 */
import {
  COMMENTS_PER_SITE_MAX,
  type Comment,
  type CommentAnchor,
  type CommentAuthor,
  type CommentList,
  normalizeCommentPath,
  siteLabel,
  siteUrl,
} from '@fling/shared'
import { ApiError, badRequest, forbidden, notFound } from './lib/errors.ts'
import { newCommentId } from './lib/ids.ts'
import { publishQuietly } from './live.ts'
import { type Acting, notifyComment } from './notifications/notify.ts'
import { type Action, type Actor, can, canDeleteComment } from './policy.ts'
import { resolveSite } from './sites.ts'
import type { CommentRecord, SiteRecord } from './store/types.ts'
import type { Deps } from './types.ts'

/** 404 unless the instance has comments on. */
export function requireComments(deps: Deps) {
  if (!deps.config.comments) throw notFound('Comments are turned off on this instance')
}

/**
 * The site named `name` and the actor as policy sees them there, if the actor may `action` its
 * comments; else 404.
 */
function commentSite(deps: Deps, actor: Actor, name: string, action: Action) {
  requireComments(deps)
  return resolveSite(deps, actor, name, action)
}

const authorOf = (actor: Actor): CommentAuthor => {
  if (actor.kind !== 'user') throw new Error('only signed-in users write comments today')
  return { kind: 'user', email: actor.email }
}

export function toComment(actor: Actor, site: SiteRecord, c: CommentRecord): Comment {
  return {
    id: c.id,
    parentId: c.parentId,
    path: c.path,
    versionId: c.versionId,
    anchor: c.anchor,
    body: c.body,
    author: c.author,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
    resolvedBy: c.resolvedBy,
    canDelete: canDeleteComment(actor, site, c),
  }
}

/** A comment of the site, or 404. */
async function findComment(deps: Deps, site: SiteRecord, id: string, name: string) {
  const comment = await deps.store.getComment(site.id, id)
  if (!comment) throw notFound(`No comment ${id} on "${name}"`)
  return comment
}

/** The site's comments, oldest first (only one page's with `path`); replies to gone threads dropped. */
export async function listComments(
  deps: Deps,
  actor: Actor,
  name: string,
  opts: { path?: string } = {}
): Promise<CommentList> {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.read')
  const path = opts.path === undefined ? undefined : normalizeCommentPath(opts.path)
  if (path === null) throw badRequest(`"${opts.path}" is not a page path`)
  const all = await deps.store.listComments(site.id)
  const threads = new Set(all.filter(c => c.parentId === null).map(c => c.id))
  const comments = all
    .filter(c => c.parentId === null || threads.has(c.parentId))
    .filter(c => path === undefined || c.path === path)
  return {
    site: {
      name: site.name,
      url: siteUrl(siteLabel(site.name), deps.config.sitesDomain, `${deps.config.siteScheme}:`),
      currentVersionId: site.currentVersionId,
    },
    comments: comments.map(c => toComment(who, site, c)),
    can: {
      create: can(who, 'comment.create', site),
      resolve: can(who, 'comment.resolve', site),
      deleteAny: can(who, 'comment.delete', site),
    },
  }
}

/**
 * Start a thread on a page, or reply to one (`parentId`: a reply takes the thread's path). The
 * site's owner hears of a new thread (`comment.created`), the thread's author and earlier repliers
 * of a reply (`comment.reply`).
 */
export async function addComment(
  deps: Deps,
  actor: Actor,
  name: string,
  input: { body: string; path?: string; parentId?: string; anchor?: CommentAnchor },
  acting: Acting = {}
): Promise<Comment> {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.create')
  let path = normalizeCommentPath(input.path)
  if (path === null) throw badRequest(`"${input.path}" is not a page path`)
  let anchor = input.anchor ?? null
  if (input.parentId !== undefined) {
    const parent = await findComment(deps, site, input.parentId, name)
    if (parent.parentId !== null) throw badRequest('Reply to the thread, not to a reply')
    path = parent.path
    anchor = null
  }
  const existing = await deps.store.listComments(site.id)
  if (existing.length >= COMMENTS_PER_SITE_MAX) {
    throw new ApiError(
      409,
      'too_many_comments',
      `"${name}" has ${COMMENTS_PER_SITE_MAX} comments, the most a site can have. Delete some first`
    )
  }
  const now = deps.clock.now()
  const record: CommentRecord = {
    siteId: site.id,
    id: newCommentId(now),
    parentId: input.parentId ?? null,
    path,
    versionId: site.currentVersionId,
    anchor,
    body: input.body.trim(),
    author: authorOf(who),
    createdAt: now.toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  }
  if (!(await deps.store.createComment(record))) throw new Error('comment id collision')
  await publishQuietly(deps, site.id, { type: 'comments' })
  await notifyComment(deps, site, record, acting)
  return toComment(who, site, record)
}

/** Resolve (or, `resolved: false`, reopen) a thread. */
export async function resolveComment(
  deps: Deps,
  actor: Actor,
  name: string,
  id: string,
  resolved: boolean
): Promise<Comment> {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.resolve')
  const comment = await findComment(deps, site, id, name)
  if (comment.parentId !== null) throw badRequest('Only a thread is resolved, not a reply')
  const updated = await deps.store.resolveComment(
    site.id,
    id,
    resolved
      ? { resolvedAt: deps.clock.now().toISOString(), resolvedBy: authorOf(who) }
      : { resolvedAt: null, resolvedBy: null }
  )
  if (!updated) throw notFound(`No comment ${id} on "${name}"`)
  await publishQuietly(deps, site.id, { type: 'comments' })
  return toComment(who, site, updated)
}

/** Delete a comment (a thread with its replies): the author's own, or any for the owner. */
export async function deleteComment(deps: Deps, actor: Actor, name: string, id: string) {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.read')
  const comment = await findComment(deps, site, id, name)
  // Someone who may read but not delete it is told so: the comment is visible to them anyway.
  if (!canDeleteComment(who, site, comment)) {
    throw forbidden('Only its author or the site owner can delete a comment')
  }
  await deps.store.deleteComment(site.id, id)
  await publishQuietly(deps, site.id, { type: 'comments' })
}
