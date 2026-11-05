// Comments on a site: the API contract (`/api/sites/:name/comments`), the page-path rule every
// client and the API agree on, and the threading the web, the CLI and the MCP servers show.
// Browser-safe (zod only).
//
// A comment is made in review mode: an app-origin page that frames the review shell, a page on the
// site's own origin that frames the site and reports what it sees (review-bridge.ts). A comment
// attaches to `{ path, versionId }`, the page the frame was showing and the version being served
// when it was made. An optional `anchor` is the spot the reviewer pinned (a point, a box they drew
// or text they selected), with enough context (element, document point, scroll, viewport, SPA hash
// route, the quoted text) to find it again on another screen.

import { z } from 'zod'
import { isMarkdownPath } from './markdown-path.ts'

/** Characters in one comment. */
export const COMMENT_MAX_CHARS = 4000
/** Comments (threads and replies) one site may hold. */
export const COMMENTS_PER_SITE_MAX = 1000
/** Characters in a page path. */
export const COMMENT_PATH_MAX = 1024
/** Characters in a form's id (forms.ts). */
export const FORM_ID_MAX = 40
/** The most a response's data may weigh, as JSON (UTF-8 bytes). */
export const RESPONSE_DATA_MAX_BYTES = 16 * 1024
/** Responses one site may hold, counted apart from its comments. */
export const RESPONSES_PER_SITE_MAX = 10_000

/**
 * Who wrote a comment: a signed-in user, or (later) a guest who opened a share link and gave a
 * name (`guest`: a signed per-site cookie, not built yet; the API never creates one today).
 */
export const CommentAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), email: z.string() }),
  z.object({ kind: z.literal('guest'), name: z.string() }),
])
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>

/** Characters in an anchor's CSS selector. */
export const ANCHOR_SELECTOR_MAX = 512
/** Characters of selected text an anchor quotes. */
export const ANCHOR_QUOTE_MAX = 500

const px = z.number().finite().min(-1e7).max(1e7)
const percent = z.number().min(0).max(100)

/**
 * A spot on a page. `x`/`y` (percentages of the frame's viewport) are always there and are the last
 * resort; the review shell finds the spot again by, in order: `selector` plus `ex`/`ey` (the
 * element and the point inside it, as percentages of its box), then `docX`/`docY` (document
 * pixels), then `x`/`y`. `scrollX`/`scrollY` and `vw`/`vh` record the scroll and viewport the pin
 * was placed with; `hash` is the page's fragment, the route of a hash-routed single-page app.
 *
 * An area (a box the reviewer drew, or text they selected) has the spot as its top-left corner and
 * a size: `ew`/`eh` (percentages of the element's box) and `docW`/`docH` (document pixels). Selected
 * text also has its `quote`, which the shell finds again inside the element before falling back to
 * the box.
 */
export const CommentAnchorSchema = z.object({
  x: percent,
  y: percent,
  selector: z.string().min(1).max(ANCHOR_SELECTOR_MAX).optional(),
  ex: percent.optional(),
  ey: percent.optional(),
  docX: px.optional(),
  docY: px.optional(),
  scrollX: px.optional(),
  scrollY: px.optional(),
  vw: z.number().finite().min(0).max(1e5).optional(),
  vh: z.number().finite().min(0).max(1e5).optional(),
  hash: z.string().max(COMMENT_PATH_MAX).optional(),
  ew: percent.optional(),
  eh: percent.optional(),
  docW: z.number().finite().min(0).max(1e7).optional(),
  docH: z.number().finite().min(0).max(1e7).optional(),
  quote: z.string().min(1).max(ANCHOR_QUOTE_MAX).optional(),
})
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>

/** A form's id: letters, digits, `-` and `_`, starting with a letter or digit. */
export const FormIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, - and _, starting with a letter or digit')
  .max(FORM_ID_MAX)

/** The bytes a value takes as JSON (UTF-8). */
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength

/** A response's data: a JSON object of at most RESPONSE_DATA_MAX_BYTES. */
export const ResponseDataSchema = z
  .record(z.string(), z.unknown())
  .refine(data => jsonBytes(data) <= RESPONSE_DATA_MAX_BYTES, {
    message: `at most ${RESPONSE_DATA_MAX_BYTES / 1024} KB of data`,
  })

/**
 * The response a comment carries (forms.ts): the form, the data (valid against the form's schema
 * when it was written) and the version whose forms it answered. Its `body` is the response's
 * summary (`responseSummary`), so clients that don't know forms still show something readable.
 */
export const CommentResponseSchema = z.object({
  formId: z.string(),
  data: z.record(z.string(), z.unknown()),
  versionId: z.string().nullable(),
})
export type CommentResponse = z.infer<typeof CommentResponseSchema>

export const CommentSchema = z.object({
  id: z.string(),
  /** the thread this replies to; null for the comment that starts a thread */
  parentId: z.string().nullable(),
  /** the page, as normalizeCommentPath() writes it ('/', '/docs/', '/about.html') */
  path: z.string(),
  /** the version the site was serving when the comment was made (null: none was) */
  versionId: z.string().nullable(),
  anchor: CommentAnchorSchema.nullable(),
  body: z.string(),
  author: CommentAuthorSchema,
  createdAt: z.string(),
  /** threads only: when and by whom it was resolved (null: open) */
  resolvedAt: z.string().nullable(),
  resolvedBy: CommentAuthorSchema.nullable(),
  /** whether the caller may delete it (policy's answer, so clients don't guess) */
  canDelete: z.boolean(),
  /** a response to a form (forms.ts); absent on a plain comment */
  response: CommentResponseSchema.optional(),
  /** a page-kind response: when it was last changed (absent until it is) */
  updatedAt: z.string().optional(),
})
export type Comment = z.infer<typeof CommentSchema>

/**
 * GET /api/sites/:name/comments[?path=] — the site (as much as a reviewer needs: members can't
 * read the site itself), its comments oldest first, and what the caller may do. 404 when the
 * caller may not read comments on the site, or the instance has comments turned off.
 */
export const CommentListSchema = z.object({
  site: z.object({
    name: z.string(),
    url: z.string(),
    currentVersionId: z.string().nullable(),
  }),
  comments: z.array(CommentSchema),
  can: z.object({
    create: z.boolean(),
    resolve: z.boolean(),
    /** delete anyone's comment (everyone may delete their own) */
    deleteAny: z.boolean(),
  }),
})
export type CommentList = z.infer<typeof CommentListSchema>

/**
 * POST /api/sites/:name/comments → CommentSchema (201). A reply takes its thread's path.
 *
 * With `response` (the `forms` capability) the comment answers one of the live version's forms
 * that applies to `path`, and `body` is ignored (the server writes the response's summary). A
 * page-kind form takes no `anchor`: it is one response per reviewer per page, and sending it again
 * replaces it (same id). A comment-kind response starts a new thread, pinned like a comment. Never
 * a reply. 400 `unknown_form` when no such form applies to the page, 400 `invalid_response` when
 * the data doesn't fit the form's schema (`error.errors`: FieldError[], forms.ts) or the kind doesn't fit.
 */
export const CreateCommentRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(COMMENT_MAX_CHARS).optional(),
    path: z.string().max(COMMENT_PATH_MAX).optional(),
    parentId: z.string().min(1).max(100).optional(),
    anchor: CommentAnchorSchema.optional(),
    response: z.object({ formId: FormIdSchema, data: ResponseDataSchema }).optional(),
  })
  .refine(req => req.body !== undefined || req.response !== undefined, {
    message: 'body: a comment needs some text',
    path: ['body'],
  })
export type CreateCommentRequest = z.infer<typeof CreateCommentRequestSchema>

/** PATCH /api/sites/:name/comments/:id { resolved } → CommentSchema. Threads only. */
export const UpdateCommentRequestSchema = z.object({ resolved: z.boolean() })

/**
 * A page path as comments store it: site-relative with a leading slash, without the query or
 * fragment, `index.html` folded into its folder (`/docs/index.html` → `/docs/`). Accepts a full
 * URL (its path is used) and a bare relative path (`about.html` → `/about.html`). Null when it is
 * not a path. One query is kept: a Markdown file's source (`/plan.md?raw=1`, markdown.ts) is a page
 * of its own, so a comment on it reopens there and not on the rendered page.
 */
export function normalizeCommentPath(input: string | undefined | null): string | null {
  let path = (input ?? '').trim()
  if (path === '') return '/'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      const url = new URL(path)
      path = url.pathname + url.search
    } catch {
      return null
    }
  }
  const query = /^[^?#]*\?([^#]*)/.exec(path)?.[1] ?? ''
  path = path.replace(/[?#].*$/, '')
  if (isMarkdownPath(path) && query.split('&').includes('raw=1')) path += RAW_QUERY
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/{2,}/g, '/').replace(/(^|\/)index\.html$/, '$1')
  if (path.length > COMMENT_PATH_MAX || /\s/.test(path)) return null
  if (path.split('/').some(s => s === '.' || s === '..')) return null
  return path
}

const RAW_QUERY = '?raw=1'

/** A thread: the comment that starts it and its replies, oldest first. */
export interface CommentThread {
  comment: Comment
  replies: Comment[]
}

/**
 * Comments (oldest first, as the API lists them) grouped into threads, oldest thread first.
 * Replies whose thread is gone are dropped.
 */
export function commentThreads(comments: readonly Comment[]): CommentThread[] {
  const threads = new Map<string, CommentThread>()
  for (const c of comments) {
    if (c.parentId === null) threads.set(c.id, { comment: c, replies: [] })
  }
  for (const c of comments) {
    if (c.parentId !== null) threads.get(c.parentId)?.replies.push(c)
  }
  return [...threads.values()]
}

/** How an author is shown: their email, or a guest's name marked as such. */
export function authorLabel(author: CommentAuthor): string {
  return author.kind === 'user' ? author.email : `${author.name} (guest)`
}

/** The review page of a site on the app: `https://fling.example.test/review/<name>[?path=…]`. */
export function reviewUrl(appOrigin: string, name: string, path?: string): string {
  const base = `${appOrigin.replace(/\/+$/, '')}/review/${name === '<name>' ? name : encodeURIComponent(name)}`
  return path && path !== '/' ? `${base}?path=${encodeURIComponent(path)}` : base
}
