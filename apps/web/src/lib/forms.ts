/**
 * Forms on the review page, the parts that need no React (the `forms` capability, forms.ts in
 * @fling/shared): which forms a page shows, which comments are page-kind responses (shown in the
 * forms tab, never as threads or pins), the reviewer's own response, how far they have got, the
 * progress view's page × reviewer matrix, and the server's field errors in the shape the form
 * renderer takes.
 */
import {
  type Comment,
  type FieldError,
  type FormDefinition,
  type FormKind,
  type FormProgress,
  type FormsConfig,
  formsForPath,
} from '@fling/shared'

/** The app route of a site's progress view. */
export const responsesHref = (name: string) => `/sites/${encodeURIComponent(name)}/responses`

/** The forms of one kind that apply to a page. */
export function formsOfKind(
  config: FormsConfig | null | undefined,
  path: string,
  kind: FormKind
): FormDefinition[] {
  return formsForPath(config, path).filter(f => f.kind === kind)
}

/** Whether the config has any form of this kind, on any page. */
export const hasKind = (config: FormsConfig | null | undefined, kind: FormKind) =>
  config?.forms.some(f => f.kind === kind) === true

/** Whether a comment was written by the signed-in reviewer. */
export const isMine = (c: Comment, email: string | null | undefined): boolean =>
  !!email && c.author.kind === 'user' && c.author.email === email

/**
 * Whether a comment is a page-kind response: a thread answering a form the config says is
 * `page`. A form the config no longer has is judged by its shape: page-kind responses have no pin.
 */
export function isPageResponse(c: Comment, config: FormsConfig | null | undefined): boolean {
  if (!c.response || c.parentId !== null) return false
  const form = config?.forms.find(f => f.id === c.response?.formId)
  return form ? form.kind === 'page' : c.anchor === null
}

/**
 * The site's comments split in two: what the comment threads and pins show (comments, comment-kind
 * responses and their replies) and the page-kind responses, which the forms tab shows. Replies to
 * a page-kind response go with it, out of the threads.
 */
export function splitPageResponses(
  comments: readonly Comment[],
  config: FormsConfig | null | undefined
): { comments: Comment[]; pageResponses: Comment[] } {
  const pageResponses = comments.filter(c => isPageResponse(c, config))
  const ids = new Set(pageResponses.map(c => c.id))
  return {
    comments: comments.filter(c => !ids.has(c.id) && !(c.parentId && ids.has(c.parentId))),
    pageResponses,
  }
}

/** The page-kind responses to one form on one page, mine first. */
export function responsesTo(
  pageResponses: readonly Comment[],
  where: { formId: string; path: string; email: string | null | undefined }
): { mine: Comment | undefined; others: Comment[] } {
  const here = pageResponses.filter(
    c => c.response?.formId === where.formId && c.path === where.path
  )
  return {
    mine: here.find(c => isMine(c, where.email)),
    others: here.filter(c => !isMine(c, where.email)),
  }
}

/** The reviewer's own page-kind progress over the site. */
export interface MyProgress {
  /** pages with a page-kind form, sorted */
  pages: string[]
  /** those where every page-kind form has my response */
  done: string[]
  /** those where some page-kind form lacks one */
  pending: string[]
}

/**
 * How far the reviewer has got: a page counts as done when every page-kind form that applies to it
 * has their response. `progress` (the export's) says which pages each form applies to; the
 * responses come from the comments, so the count follows the live list.
 */
export function myProgress(
  config: FormsConfig | null | undefined,
  progress: readonly FormProgress[],
  pageResponses: readonly Comment[],
  email: string | null | undefined
): MyProgress {
  const pageForms = new Set((config?.forms ?? []).filter(f => f.kind === 'page').map(f => f.id))
  const formsOn = new Map<string, string[]>()
  for (const p of progress) {
    if (!pageForms.has(p.form)) continue
    for (const page of p.pages) formsOn.set(page, [...(formsOn.get(page) ?? []), p.form])
  }
  const answered = new Set(
    pageResponses.filter(c => isMine(c, email)).map(c => `${c.response?.formId}\u0000${c.path}`)
  )
  const pages = [...formsOn.keys()].sort()
  const done = pages.filter(page =>
    (formsOn.get(page) ?? []).every(form => answered.has(`${form}\u0000${page}`))
  )
  const doneSet = new Set(done)
  return { pages, done, pending: pages.filter(p => !doneSet.has(p)) }
}

/**
 * The next page still waiting for my response after `current`, in page order and round to the
 * start; never `current` itself. Null when none is.
 */
export function nextPending(pending: readonly string[], current: string): string | null {
  const others = pending.filter(p => p !== current)
  if (others.length === 0) return null
  return others.find(p => p > current) ?? (others[0] as string)
}

/** "12 / 51" after the config's title, as the progress links say it. */
export const progressLabel = (title: string, done: number, total: number) =>
  `${title} · ${done} / ${total}`

/** One form's progress as a page × reviewer matrix, for the progress view. */
export interface ProgressMatrix {
  reviewers: string[]
  rows: { path: string; done: boolean[]; count: number }[]
  /** pages with at least one response */
  answered: number
}

export function progressMatrix(p: FormProgress): ProgressMatrix {
  const rows = p.pages.map(path => {
    const by = new Set(p.done[path] ?? [])
    const done = p.reviewers.map(r => by.has(r))
    return { path, done, count: done.filter(Boolean).length }
  })
  return { reviewers: p.reviewers, rows, answered: rows.filter(r => r.count > 0).length }
}

/**
 * The site's page-kind progress in one pair: pages where every page-kind form has at least one
 * response, of the pages that have one. Null when the config has no page-kind form.
 */
export function siteProgress(
  config: Pick<FormsConfig, 'forms'> | null | undefined,
  progress: readonly FormProgress[]
): { done: number; total: number } | null {
  const pageForms = new Set((config?.forms ?? []).filter(f => f.kind === 'page').map(f => f.id))
  if (pageForms.size === 0) return null
  const formsOn = new Map<string, FormProgress[]>()
  for (const p of progress) {
    if (!pageForms.has(p.form)) continue
    for (const page of p.pages) formsOn.set(page, [...(formsOn.get(page) ?? []), p])
  }
  let done = 0
  for (const [page, forms] of formsOn) {
    if (forms.every(f => (f.done[page]?.length ?? 0) > 0)) done++
  }
  return { done, total: formsOn.size }
}

/** The JSON type all of these values share, or null when they differ or one has none. */
function sharedType(values: readonly unknown[]): string | null {
  const types = new Set(
    values.map(v =>
      v === null
        ? 'null'
        : Array.isArray(v)
          ? 'array'
          : typeof v === 'number'
            ? Number.isInteger(v)
              ? 'integer'
              : 'number'
            : typeof v
    )
  )
  if (types.has('integer') && types.has('number')) types.delete('integer')
  const [only, ...more] = [...types]
  return only && more.length === 0 && ['string', 'integer', 'number', 'boolean'].includes(only)
    ? only
    : null
}

/** The values a subschema chooses between: its `enum`, its `const`, or a list of `const`s. */
function choiceValues(node: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(node.enum)) return node.enum
  if ('const' in node) return [node.const]
  const list = Array.isArray(node.oneOf)
    ? node.oneOf
    : Array.isArray(node.anyOf)
      ? node.anyOf
      : null
  if (list?.length && list.every(o => o && typeof o === 'object' && 'const' in o)) {
    return list.map(o => (o as { const: unknown }).const)
  }
  return null
}

function withTypes(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) }
  if (out.type === undefined) {
    const values = choiceValues(out)
    const type = values ? sharedType(values) : null
    if (type) out.type = type
  }
  for (const key of ['properties', '$defs', 'definitions'] as const) {
    const map = out[key]
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      out[key] = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, withTypes(v)]))
    }
  }
  if (out.items)
    out.items = Array.isArray(out.items) ? out.items.map(withTypes) : withTypes(out.items)
  return out
}

/**
 * A form's schema as the renderer takes it: without the root title (the page shows the form's
 * own), and with a `type` on each choice that leaves it out, taken from its values (a `oneOf` of
 * string `const`s is a string), since the renderer can't draw a field of no type. Validation is
 * unchanged: the type only says what the values already are.
 */
export function renderableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { title: _title, ...rest } = withTypes(schema) as Record<string, unknown>
  return rest
}

/** The renderer's error tree: `__errors` per field, nested by property. */
export interface ErrorTree {
  __errors?: string[]
  [key: string]: ErrorTree | string[] | undefined
}

/**
 * The server's field errors (`notes`, `scores/clarity`; '' for the whole response) as the form
 * renderer's error tree, so each shows under its field.
 */
export function errorTree(errors: readonly FieldError[]): ErrorTree {
  const root: ErrorTree = {}
  for (const e of errors) {
    let node = root
    for (const part of e.field.split('/').filter(Boolean)) {
      let child = node[part]
      if (!child || Array.isArray(child)) {
        child = {}
        node[part] = child
      }
      node = child
    }
    node.__errors = [...(node.__errors ?? []), e.message]
  }
  return root
}
