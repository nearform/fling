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
 *
 * A comment may be a **response** to one of the live version's forms (forms.ts): `addComment` with
 * `response` checks that the form applies to the page and that the comment fits its kind, then
 * validates the data against its schema (400 `invalid_response` with each field's error). A
 * page-kind response is one per reviewer per page (`pageResponseId`): the first is created and
 * the next ones change it (`Store.updateResponse`), so it is never a second row. Responses count
 * towards RESPONSES_PER_SITE_MAX, apart from the comments' COMMENTS_PER_SITE_MAX. Responses to an
 * `own` form are seen only by their author and those with `response.read.all`, here as in the
 * export; to anyone else such a response does not exist (404), replies included.
 */
import {
  COMMENTS_PER_SITE_MAX,
  type Comment,
  type CommentAnchor,
  type CommentAuthor,
  type CommentList,
  formsForPath,
  normalizeCommentPath,
  RESPONSES_PER_SITE_MAX,
  responseSummary,
  siteLabel,
  siteUrl,
  validateResponse,
} from '@fling/shared'
import { byCreatedAt, pageResponseId, readForms, responseFilter } from './forms.ts'
import { ApiError, badRequest, forbidden, notFound } from './lib/errors.ts'
import { newCommentId } from './lib/ids.ts'
import { publishQuietly } from './live.ts'
import { type Acting, notifyComment } from './notifications/notify.ts'
import { type Action, type Actor, can, canDeleteComment, isAuthor } from './policy.ts'
import { auditAdmin, resolveSite } from './sites.ts'
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
export function commentSite(deps: Deps, actor: Actor, name: string, action: Action) {
  requireComments(deps)
  return resolveSite(deps, actor, name, action)
}

const authorOf = (actor: Actor): Extract<CommentAuthor, { kind: 'user' }> => {
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
    ...(c.response ? { response: c.response } : {}),
    ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
  }
}

/** A comment of the site the actor may see (a reply: and its thread), or 404. */
async function findComment(deps: Deps, actor: Actor, site: SiteRecord, id: string, name: string) {
  const comment = await deps.store.getComment(site.id, id)
  if (!comment) throw notFound(`No comment ${id} on "${name}"`)
  const thread =
    comment.parentId === null ? comment : await deps.store.getComment(site.id, comment.parentId)
  const responses = [comment, thread].filter(c => c?.response)
  if (responses.length > 0) {
    const visible = responseFilter(
      actor,
      site,
      await readForms(deps, site.id, site.currentVersionId)
    )
    if (!responses.every(c => visible(c as CommentRecord))) {
      throw notFound(`No comment ${id} on "${name}"`)
    }
  }
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
  const config = await readForms(deps, site.id, site.currentVersionId)
  const all = (await deps.store.listComments(site.id))
    .filter(responseFilter(who, site, config))
    .sort(byCreatedAt)
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

/** 400 `invalid_response`, with each field's error when the data was at fault. */
const invalidResponse = (message: string, errors?: unknown) =>
  new ApiError(400, 'invalid_response', message, errors ? { errors } : undefined)

/**
 * Start a thread on a page, or reply to one (`parentId`: a reply takes the thread's path); with
 * `response`, answer a form (see the header). The site's owners hear of a new thread
 * (`comment.created`), the thread's author and earlier repliers of a reply (`comment.reply`); a
 * response answered again tells no one.
 */
export async function addComment(
  deps: Deps,
  actor: Actor,
  name: string,
  input: {
    body?: string
    path?: string
    parentId?: string
    anchor?: CommentAnchor
    response?: { formId: string; data: Record<string, unknown> }
  },
  acting: Acting = {}
): Promise<Comment> {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.create')
  let path = normalizeCommentPath(input.path)
  if (path === null) throw badRequest(`"${input.path}" is not a page path`)
  let anchor = input.anchor ?? null
  if (input.parentId !== undefined) {
    if (input.response) throw invalidResponse('A response starts a thread: it is never a reply')
    const parent = await findComment(deps, who, site, input.parentId, name)
    if (parent.parentId !== null) throw badRequest('Reply to the thread, not to a reply')
    path = parent.path
    anchor = null
  }
  const now = deps.clock.now().toISOString()
  const author = authorOf(who)
  let body = input.body?.trim() ?? ''
  let response: CommentRecord['response']
  let id: string | null = null
  if (input.response) {
    const { formId, data } = input.response
    const config = await readForms(deps, site.id, site.currentVersionId)
    const form = formsForPath(config, path).find(f => f.id === formId)
    if (!form) {
      throw badRequest(
        config?.forms.some(f => f.id === formId)
          ? `The form "${formId}" of "${name}" is not for ${path}`
          : `"${name}" has no form "${formId}"`,
        'unknown_form'
      )
    }
    if (form.kind === 'page' && anchor) {
      throw invalidResponse(`"${form.title}" is answered for the whole page: send no anchor`)
    }
    const check = validateResponse(form, data)
    if (!check.ok) {
      throw invalidResponse(
        `The response doesn't fit "${form.title}": ${check.errors
          .map(e => (e.field ? `${e.field} ${e.message}` : e.message))
          .join('; ')}`,
        check.errors
      )
    }
    body = responseSummary(form, data)
    response = { formId, data, versionId: site.currentVersionId }
    if (form.kind === 'page') {
      id = pageResponseId(formId, path, author.email)
      const updated = await deps.store.updateResponse(site.id, id, author.email, {
        response,
        body,
        updatedAt: now,
      })
      if (updated) {
        await publishQuietly(deps, site.id, { type: 'comments' })
        return toComment(who, site, updated)
      }
    }
  }
  if (!response && body === '') throw badRequest('A comment needs some text')
  const existing = await deps.store.listComments(site.id)
  if (response) {
    if (existing.filter(c => c.response).length >= RESPONSES_PER_SITE_MAX) {
      throw new ApiError(
        409,
        'too_many_responses',
        `"${name}" has ${RESPONSES_PER_SITE_MAX} responses, the most a site can have`
      )
    }
  } else if (existing.filter(c => !c.response).length >= COMMENTS_PER_SITE_MAX) {
    throw new ApiError(
      409,
      'too_many_comments',
      `"${name}" has ${COMMENTS_PER_SITE_MAX} comments, the most a site can have. Delete some first`
    )
  }
  const record: CommentRecord = {
    siteId: site.id,
    id: id ?? newCommentId(new Date(now)),
    parentId: input.parentId ?? null,
    path,
    versionId: site.currentVersionId,
    anchor,
    body,
    author,
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    ...(response ? { response, respondent: author.email } : {}),
  }
  if (!(await deps.store.createComment(record))) {
    // Two first answers to a page-kind form at once: the other was created, so change it.
    if (id && response) {
      const updated = await deps.store.updateResponse(site.id, id, author.email, {
        response,
        body,
        updatedAt: now,
      })
      if (updated) {
        await publishQuietly(deps, site.id, { type: 'comments' })
        return toComment(who, site, updated)
      }
    }
    throw new Error('comment id collision')
  }
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
  const comment = await findComment(deps, who, site, id, name)
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

/**
 * Delete a comment (a thread with its replies): the author's own, or any for the owner and admins
 * (an admin deleting someone else's is audited).
 */
export async function deleteComment(deps: Deps, actor: Actor, name: string, id: string) {
  const { site, actor: who } = await commentSite(deps, actor, name, 'comment.read')
  const comment = await findComment(deps, who, site, id, name)
  // Someone who may read but not delete it is told so: the comment is visible to them anyway.
  if (!canDeleteComment(who, site, comment)) {
    throw forbidden('Only its author, the site owner or an admin can delete a comment')
  }
  if (!isAuthor(who, comment.author)) await auditAdmin(deps, who, site, 'comment.delete')
  await deps.store.deleteComment(site.id, id)
  await publishQuietly(deps, site.id, { type: 'comments' })
}
