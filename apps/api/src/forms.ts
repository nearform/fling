/**
 * Forms (the `forms` capability, on with comments; forms.ts in @fling/shared): a version's forms
 * config, and the responses to its forms.
 *
 * A version's config is a blob beside its manifest (`formsKey`). Publication writes it when the
 * deploy is made (`formsForDeploy`): the request's `forms` when it sends them (`null`: none), else
 * a layered publish keeps its base's and any other deploy has none. A version is named by its
 * files alone, so a deploy that is `unchanged` or `repointed` and sends `forms` sets that version's
 * config in place.
 *
 * Responses are comments (comments.ts) that carry `response`. Reading them goes through
 * `comment.read`; on a form whose visibility is `own`, others' responses are left out unless the
 * caller has `response.read.all` (`canSeeResponse` in policy.ts), here and in the comments list.
 * Which forms there are, and their visibility, is the live version's config: a response to a form
 * the live version no longer has is treated as `own`, so taking a form away never reveals answers.
 */
import { createHash } from 'node:crypto'
import {
  authorLabel,
  type FormDefinition,
  type FormsConfig,
  type FormsResponse,
  formProgress,
  formsForPath,
  normalizeCommentPath,
  type ResponseRow,
  type ResponsesExport,
  reviewPages,
} from '@fling/shared'
import { formsKey, manifestKey } from './blobs/types.ts'
import { badRequest } from './lib/errors.ts'
import { type Actor, canSeeResponse, type PolicySite } from './policy.ts'
import type { StoredManifest } from './sites.ts'
import type { CommentRecord, SiteRecord } from './store/types.ts'
import type { Deps } from './types.ts'

/** A version's forms config; null when it has none. */
export async function readForms(
  deps: Deps,
  siteId: string,
  versionId: string | null
): Promise<FormsConfig | null> {
  if (!versionId) return null
  return deps.blobs.getJson<FormsConfig>(formsKey(siteId, versionId))
}

/** Set a version's forms config, or (null) remove it. */
export async function writeForms(
  deps: Deps,
  siteId: string,
  versionId: string,
  forms: FormsConfig | null
) {
  if (forms) await deps.blobs.putJson(formsKey(siteId, versionId), forms)
  else await deps.blobs.delete(formsKey(siteId, versionId))
}

/**
 * The forms config a deploy gives its version: what it sends (null: none); else, for a layered
 * publish, its base's; else none. `undefined` when a deploy that leaves a version as it is should
 * leave its config alone too (sent nothing, no base).
 */
export async function formsForDeploy(
  deps: Deps,
  siteId: string,
  req: { forms?: FormsConfig | null },
  base: string | null
): Promise<FormsConfig | null | undefined> {
  if (req.forms !== undefined) return req.forms
  if (base) return readForms(deps, siteId, base)
  return undefined
}

/**
 * The id of a reviewer's response to a page-kind form on one page: the same every time, so
 * answering again finds it (`R` and 24 hex characters of a SHA-256).
 */
export function pageResponseId(formId: string, path: string, email: string): string {
  const hash = createHash('sha256').update(`${formId}\u0000${path}\u0000${email}`).digest('hex')
  return `R${hash.slice(0, 24)}`
}

/** Whether the live config makes a response's form `own` (a form it lacks counts as `own`). */
export function isOwnForm(config: FormsConfig | null, formId: string): boolean {
  const form = config?.forms.find(f => f.id === formId)
  return !form || form.visibility === 'own'
}

/** A filter for the comments the actor may see, as far as forms go (`canSeeResponse`). */
export function responseFilter(actor: Actor, site: PolicySite, config: FormsConfig | null) {
  return (c: Pick<CommentRecord, 'author' | 'response'>) =>
    canSeeResponse(actor, site, c, c.response ? isOwnForm(config, c.response.formId) : false)
}

/** Comments in the order they were made (page-kind responses' ids don't sort by time). */
export const byCreatedAt = (a: CommentRecord, b: CommentRecord) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1

/** A path from a query string as comments store it; 400 when it is not a page path. */
function pagePath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const path = normalizeCommentPath(raw)
  if (path === null) throw badRequest(`"${raw}" is not a page path`)
  return path
}

/** GET /api/sites/:name/forms[?path=]: the live version's config, and the forms for `path`. */
export async function formsOf(
  deps: Deps,
  site: SiteRecord,
  rawPath?: string
): Promise<FormsResponse> {
  const path = pagePath(rawPath)
  const config = await readForms(deps, site.id, site.currentVersionId)
  return {
    versionId: site.currentVersionId,
    config,
    ...(path !== undefined ? { path } : {}),
    forms: path === undefined ? (config?.forms ?? []) : formsForPath(config, path),
  }
}

/** A response comment as an export row. */
function rowOf(
  c: CommentRecord & { response: NonNullable<CommentRecord['response']> }
): ResponseRow {
  return {
    id: c.id,
    path: c.path,
    formId: c.response.formId,
    author: authorLabel(c.author),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? c.createdAt,
    versionId: c.response.versionId,
    data: c.response.data,
  }
}

/**
 * GET /api/sites/:name/responses: the responses `actor` may see (only to `form` and on `path` when
 * given), oldest first, and each of the live version's forms' progress over its pages.
 */
export async function responsesOf(
  deps: Deps,
  actor: Actor,
  site: SiteRecord,
  opts: { form?: string; path?: string } = {}
): Promise<ResponsesExport> {
  const path = pagePath(opts.path)
  const config = await readForms(deps, site.id, site.currentVersionId)
  const visible = responseFilter(actor, site, config)
  const rows = (await deps.store.listComments(site.id))
    .filter((c): c is CommentRecord & { response: NonNullable<CommentRecord['response']> } =>
      Boolean(c.response)
    )
    .filter(visible)
    .filter(c => opts.form === undefined || c.response.formId === opts.form)
    .filter(c => path === undefined || c.path === path)
    .sort(byCreatedAt)
    .map(rowOf)
  const forms: FormDefinition[] = (config?.forms ?? []).filter(
    f => opts.form === undefined || f.id === opts.form
  )
  const manifest = site.currentVersionId
    ? await deps.blobs.getJson<StoredManifest>(manifestKey(site.id, site.currentVersionId))
    : null
  const pages = reviewPages((manifest?.files ?? []).map(f => f.path)).filter(
    p => path === undefined || p === path
  )
  return {
    site: { name: site.name, currentVersionId: site.currentVersionId },
    title: config?.title ?? null,
    forms,
    responses: rows,
    progress: forms.map(f => formProgress(f, pages, rows)),
  }
}
