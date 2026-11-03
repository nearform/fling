// Forms (the `forms` capability): a site's deploy can carry a forms config (`fling.forms.json` at the
// root of the folder, sent as `DeployRequest.forms` and never served), and reviewers answer its
// forms on the review page. A **form** is a JSON Schema (draft 2020-12) with an optional UI schema
// for the web's renderer; a **response** is a comment carrying JSON valid against it
// (`Comment.response`). Browser-safe: zod and @cfworker/json-schema, which validates without eval,
// so the API on every platform, the CLI and the web agree on what is valid.
//
// - `title` names the feature wherever this site's forms appear (e.g. "Labels", "Evals").
// - `kind: "page"`: one response per reviewer per page, which they change by answering again.
//   `kind: "comment"`: a comment type in the composer; each response is a new thread, pinned.
// - `paths` are globs over the review path (`formsForPath`): `*` within a segment, `**` across
//   them, `?` one character; one starting with `!` excludes. No `paths`: every page.
// - `visibility: "own"`: reviewers see only their own responses; owners and admins see all.
// - The root schema is `type: "object"`; `$ref`s are local only (no remote schemas are fetched).

import { Validator } from '@cfworker/json-schema'
import { z } from 'zod'
import { COMMENT_MAX_CHARS, FormIdSchema, jsonBytes, normalizeCommentPath } from './comments.ts'
import { JSON_SCHEMA_2020_12, METASCHEMA_2020_12 } from './json-schema-meta.ts'

/** Characters in the config's title. */
export const FORMS_TITLE_MAX = 40
/** Characters in a form's title. */
export const FORM_TITLE_MAX = 80
/** Forms one config may hold. */
export const FORMS_MAX = 20
/** The most a forms config may weigh, as JSON (UTF-8 bytes). */
export const FORMS_CONFIG_MAX_BYTES = 64 * 1024
/** Globs one form may list, and characters in one. */
export const FORM_PATHS_MAX = 50
export const FORM_GLOB_MAX = 200
/** The forms config's file name, at the root of a deployed folder. */
export const FORMS_FILE = 'fling.forms.json'

export const FormKindSchema = z.enum(['page', 'comment'])
export type FormKind = z.infer<typeof FormKindSchema>

export const FormVisibilitySchema = z.enum(['everyone', 'own'])
export type FormVisibility = z.infer<typeof FormVisibilitySchema>

/** A JSON Schema or UI schema object, as written. */
export type JsonObject = Record<string, unknown>

/** Why a glob is refused, or null when it will do. */
function globProblem(glob: string): string | null {
  const body = glob.startsWith('!') ? glob.slice(1) : glob
  if (body === '') return 'is empty'
  if (/\s/.test(body)) return 'has whitespace'
  if (body.includes('!')) return 'may only start with `!`'
  if (body.split('/').some(s => s === '.' || s === '..')) return 'has `.` or `..` segments'
  return null
}

const GlobSchema = z
  .string()
  .max(FORM_GLOB_MAX)
  .superRefine((glob, ctx) => {
    const problem = globProblem(glob)
    if (problem) ctx.addIssue({ code: 'custom', message: `"${glob}" ${problem}` })
  })

export const FormDefinitionSchema = z
  .object({
    id: FormIdSchema,
    title: z.string().trim().min(1).max(FORM_TITLE_MAX),
    kind: FormKindSchema.default('page'),
    paths: z.array(GlobSchema).max(FORM_PATHS_MAX).optional(),
    visibility: FormVisibilitySchema.default('everyone'),
    schema: z.record(z.string(), z.unknown()),
    uiSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((form, ctx) => {
    for (const problem of checkFormSchema(form.schema)) {
      ctx.addIssue({ code: 'custom', message: problem, path: ['schema'] })
    }
  })
export type FormDefinition = z.infer<typeof FormDefinitionSchema>

/** The forms config: `fling.forms.json`, `DeployRequest.forms`. */
export const FormsConfigSchema = z
  .object({
    title: z.string().trim().min(1).max(FORMS_TITLE_MAX),
    forms: z.array(FormDefinitionSchema).min(1).max(FORMS_MAX),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>()
    config.forms.forEach((form, i) => {
      if (seen.has(form.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${form.id}" is used twice`,
          path: ['forms', i, 'id'],
        })
      }
      seen.add(form.id)
    })
    if (jsonBytes(config) > FORMS_CONFIG_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `A forms config may be at most ${FORMS_CONFIG_MAX_BYTES / 1024} KB`,
      })
    }
  })
export type FormsConfig = z.infer<typeof FormsConfigSchema>
/** A forms config as written, before defaults (`kind`, `visibility`) are filled in. */
export type FormsConfigInput = z.input<typeof FormsConfigSchema>

// --- schemas -------------------------------------------------------------------------------------

/** Keywords whose values are data, not schemas: a `$ref` inside them is just a string. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples'])

/** Every `$ref` (and keyword we refuse) in a schema, with where it is. */
function walkSchema(
  node: unknown,
  at: string,
  visit: (key: string, value: unknown, at: string) => void
) {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) walkSchema(item, `${at}/${i}`, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    visit(key, value, at)
    if (!DATA_KEYWORDS.has(key)) walkSchema(value, `${at}/${key}`, visit)
  }
}

/** The subschema a local `$ref` (`#`, `#/json/pointer` or `#anchor`) points at, if any. */
function resolveLocalRef(root: JsonObject, ref: string): unknown {
  const fragment = ref.slice(1)
  if (fragment === '') return root
  if (!fragment.startsWith('/')) {
    let found: unknown
    walkSchema(root, '#', (key, value, at) => {
      if (key === '$anchor' && value === fragment && found === undefined) found = at
    })
    return found
  }
  let node: unknown = root
  for (const raw of fragment.slice(1).split('/')) {
    const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
    if (node === undefined) return undefined
  }
  return node
}

const metaValidator = new Validator(METASCHEMA_2020_12 as unknown as JsonObject, '2020-12', false)

/**
 * What is wrong with a form's schema (none: it will do): it must be a draft 2020-12 schema (checked
 * against the metaschema) whose root is `type: "object"`, whose `$ref`s are local and resolve, and
 * which uses no keyword the validator lacks (`$dynamicRef`, `$recursiveRef`) or a nested `$id`.
 */
export function checkFormSchema(schema: unknown): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return ['The schema must be a JSON object']
  }
  const root = schema as JsonObject
  const problems: string[] = []
  if (root.$schema !== undefined && root.$schema !== JSON_SCHEMA_2020_12) {
    problems.push(`Only draft 2020-12 schemas are supported ("$schema": "${JSON_SCHEMA_2020_12}")`)
  }
  if (root.type !== 'object') problems.push('The root schema must be `"type": "object"`')
  const meta = metaValidator.validate(root)
  if (!meta.valid) {
    for (const e of fieldErrors(meta.errors).slice(0, 10)) {
      problems.push(`Not a valid JSON Schema: ${e.field ? `${e.field} ` : ''}${e.message}`)
    }
  }
  walkSchema(root, '#', (key, value, at) => {
    if (key === '$ref' && typeof value === 'string') {
      if (!value.startsWith('#')) {
        problems.push(`${at}: $ref "${value}" is remote; only local refs ("#/$defs/…") are allowed`)
      } else if (resolveLocalRef(root, value) === undefined) {
        problems.push(`${at}: $ref "${value}" points at nothing`)
      }
    }
    if ((key === '$dynamicRef' || key === '$recursiveRef') && typeof value === 'string') {
      problems.push(`${at}: ${key} is not supported; use $ref`)
    }
    if (key === '$id' && at !== '#' && typeof value === 'string') {
      problems.push(`${at}: $id is only allowed at the root`)
    }
  })
  return problems
}

/** One thing wrong with a response: the field (`notes`, `scores/clarity`; '' for the whole). */
export const FieldErrorSchema = z.object({ field: z.string(), message: z.string() })
export type FieldError = z.infer<typeof FieldErrorSchema>

type OutputUnit = {
  keyword: string
  keywordLocation: string
  instanceLocation: string
  error: string
}

/** Keywords that only say a subschema failed: the subschema's own errors say how. */
const WRAPPERS = new Set([
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'contains',
  '$ref',
  'allOf',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
])

const fieldOf = (instanceLocation: string) =>
  instanceLocation
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(s => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('/')

/** A validator's output as one message per field, the most specific first. */
function fieldErrors(units: readonly OutputUnit[]): FieldError[] {
  // A failed oneOf/anyOf stands for its branches: drop what each branch said.
  const choices = units
    .filter(u => u.keyword === 'oneOf' || u.keyword === 'anyOf')
    .map(u => `${u.keywordLocation}/`)
  const out: FieldError[] = []
  const seen = new Set<string>()
  for (const u of units) {
    if (WRAPPERS.has(u.keyword) && /subschema|does not match schema|do not match/i.test(u.error)) {
      continue
    }
    if (choices.some(c => u.keywordLocation.startsWith(c))) continue
    let field = fieldOf(u.instanceLocation)
    let message = u.error
    const missing = u.keyword === 'required' && /"([^"]+)"/.exec(u.error)
    if (missing) {
      field = field ? `${field}/${missing[1]}` : (missing[1] as string)
      message = 'is required'
    }
    const key = `${field}\u0000${message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ field, message })
  }
  return out
}

/** Does a choice list of `const`s say which values are allowed (for a friendlier message)? */
function choicesAt(schema: JsonObject, field: string): string[] | null {
  let node: unknown = schema
  for (const part of field.split('/').filter(Boolean)) {
    const props = (node as { properties?: Record<string, unknown> } | null)?.properties
    node = props?.[part]
    if (!node) return null
  }
  const options = choiceOptions(node)
  return options ? options.map(o => o.title) : null
}

/** A property's choices: `oneOf`/`anyOf` of `const`s with titles, or an `enum`. */
function choiceOptions(node: unknown): { value: unknown; title: string }[] | null {
  if (node === null || typeof node !== 'object') return null
  const n = node as { oneOf?: unknown; anyOf?: unknown; enum?: unknown; items?: unknown }
  const list = Array.isArray(n.oneOf) ? n.oneOf : Array.isArray(n.anyOf) ? n.anyOf : null
  if (list?.every(o => o && typeof o === 'object' && 'const' in o)) {
    return list.map(o => {
      const { const: value, title } = o as { const: unknown; title?: unknown }
      return { value, title: typeof title === 'string' ? title : String(value) }
    })
  }
  if (Array.isArray(n.enum)) return n.enum.map(value => ({ value, title: String(value) }))
  return null
}

/** The result of checking a response's data against its form. */
export type ResponseCheck = { ok: true } | { ok: false; errors: FieldError[] }

/**
 * Whether `data` fits the form's schema (draft 2020-12, every error, no remote `$ref`s), and if
 * not, what is wrong with each field.
 */
export function validateResponse(
  form: Pick<FormDefinition, 'schema'>,
  data: unknown
): ResponseCheck {
  let result: { valid: boolean; errors: OutputUnit[] }
  try {
    result = new Validator(form.schema as JsonObject, '2020-12', false).validate(data)
  } catch (err) {
    // An unresolvable $ref: checkFormSchema refuses those, so only a schema it never saw gets here.
    return {
      ok: false,
      errors: [
        {
          field: '',
          message: `The form's schema can't be used: ${(err as Error).message.split('\n')[0]}`,
        },
      ],
    }
  }
  if (result.valid) return { ok: true }
  const errors = fieldErrors(result.errors).map(e => {
    if (!/exactly one subschema|any subschema|enum/i.test(e.message)) return e
    const choices = choicesAt(form.schema as JsonObject, e.field)
    return choices ? { ...e, message: `must be one of: ${choices.join(', ')}` } : e
  })
  return { ok: false, errors }
}

// --- paths ---------------------------------------------------------------------------------------

const globCache = new Map<string, RegExp>()

/** A glob (without its `!`) as a regular expression over a site-relative path with no leading slash. */
function globRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached
  const g = glob.replace(/^\/+/, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const out = new RegExp(`^${re}$`)
  globCache.set(glob, out)
  return out
}

/**
 * Whether a glob matches a review path. A folder page (`/docs/`) is also `docs` and
 * `docs/index.html`, and the home page (`/`) is also `index.html`, so globs written either way work.
 */
function globMatches(glob: string, path: string): boolean {
  const rel = path.replace(/^\/+/, '')
  const re = globRegExp(glob)
  const names =
    rel === '' || rel.endsWith('/') ? [rel, rel.replace(/\/$/, ''), `${rel}index.html`] : [rel]
  return names.some(n => re.test(n))
}

/** Whether a form applies to a page (a review path, as normalizeCommentPath writes it). */
export function formAppliesTo(form: Pick<FormDefinition, 'paths'>, path: string): boolean {
  const globs = form.paths ?? []
  const include = globs.filter(g => !g.startsWith('!'))
  const exclude = globs.filter(g => g.startsWith('!')).map(g => g.slice(1))
  if (include.length > 0 && !include.some(g => globMatches(g, path))) return false
  return !exclude.some(g => globMatches(g, path))
}

/** The forms of a config that apply to a page (any spelling normalizeCommentPath accepts). */
export function formsForPath(
  config: FormsConfig | null | undefined,
  path: string
): FormDefinition[] {
  const page = normalizeCommentPath(path)
  if (!config || page === null) return []
  return config.forms.filter(f => formAppliesTo(f, page))
}

/**
 * The pages reviewers comment on among a site's paths, sorted: its HTML files as review paths
 * (`docs/index.html` → `/docs/`, `about.html` → `/about.html`). Paths that already are review
 * paths of a folder (`/docs/`) are kept.
 */
export function reviewPages(paths: readonly string[]): string[] {
  const pages = new Set<string>()
  for (const p of paths) {
    if (!/\.html?$/i.test(p) && !p.endsWith('/')) continue
    const page = normalizeCommentPath(p)
    if (page !== null) pages.add(page)
  }
  return [...pages].sort()
}

// --- checking a config before publishing ---------------------------------------------------------

/** What a config holds, form by form, and how it lands on the site's pages. */
export interface FormsSummary {
  title: string
  forms: {
    id: string
    title: string
    kind: FormKind
    visibility: FormVisibility
    /** the pages it applies to, when the site's paths were given */
    pages: string[] | null
  }[]
  /** things that are allowed but probably wrong (a glob that matches no page, a form on no page) */
  warnings: string[]
}

export interface FormsCheck {
  ok: boolean
  /** why the config is refused, each with where (`forms.0.schema: …`) */
  errors: string[]
  /** null when the envelope can't be read at all */
  summary: FormsSummary | null
}

/**
 * Check a forms config as a deploy will (the envelope, each schema against the metaschema, the
 * limits and the globs). With the site's `paths` (file paths as in the folder, or review paths),
 * the summary says which pages each form applies to and warns about globs that match none.
 */
export function checkFormsConfig(config: unknown, paths?: readonly string[]): FormsCheck {
  const parsed = FormsConfigSchema.safeParse(config)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message
    )
    return { ok: false, errors, summary: null }
  }
  const pages = paths ? reviewPages(paths) : null
  const warnings: string[] = []
  const forms = parsed.data.forms.map(form => {
    const matched = pages ? pages.filter(p => formAppliesTo(form, p)) : null
    if (pages) {
      for (const glob of form.paths ?? []) {
        const body = glob.startsWith('!') ? glob.slice(1) : glob
        if (!pages.some(p => globMatches(body, p))) {
          warnings.push(`${form.id}: "${glob}" matches no page`)
        }
      }
      if (matched?.length === 0) warnings.push(`${form.id}: applies to no page`)
    }
    return {
      id: form.id,
      title: form.title,
      kind: form.kind,
      visibility: form.visibility,
      pages: matched,
    }
  })
  return { ok: true, errors: [], summary: { title: parsed.data.title, forms, warnings } }
}

/** A summary as lines for a terminal or an agent: one per form, then the warnings. */
export function formsSummaryLines(summary: FormsSummary): string[] {
  return [
    ...summary.forms.map(f => {
      const where =
        f.pages === null ? '' : `, ${f.pages.length} page${f.pages.length === 1 ? '' : 's'}`
      const own = f.visibility === 'own' ? ', each reviewer sees only their own' : ''
      return `${summary.title} · ${f.title} (${f.id}): ${f.kind === 'page' ? 'one per reviewer per page' : 'a comment type'}${where}${own}`
    }),
    ...summary.warnings.map(w => `warning: ${w}`),
  ]
}

// --- showing a response --------------------------------------------------------------------------

/** A response's answers in the schema's order, labelled with its titles. */
export function responseFields(
  form: Pick<FormDefinition, 'schema'>,
  data: Record<string, unknown>
): { key: string; label: string; value: string }[] {
  const props = (form.schema.properties ?? {}) as Record<string, unknown>
  const keys = [...Object.keys(props), ...Object.keys(data).filter(k => !(k in props))]
  const out: { key: string; label: string; value: string }[] = []
  for (const key of keys) {
    if (!(key in data) || data[key] === undefined || data[key] === '') continue
    const prop = props[key] as { title?: unknown; items?: unknown } | undefined
    const label = typeof prop?.title === 'string' ? prop.title : key
    out.push({ key, label, value: displayValue(prop, data[key]) })
  }
  return out
}

function displayValue(prop: unknown, value: unknown): string {
  const options = choiceOptions(prop)
  const titleOf = (v: unknown, opts: ReturnType<typeof choiceOptions>) =>
    opts?.find(o => o.value === v)?.title ?? (typeof v === 'string' ? v : JSON.stringify(v))
  if (options && !Array.isArray(value)) return titleOf(value, options)
  if (Array.isArray(value)) {
    const itemOptions = choiceOptions((prop as { items?: unknown } | undefined)?.items)
    return value.map(v => titleOf(v, itemOptions)).join(', ')
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * The text a response's comment carries as its `body`: the form's title, then each answer. Clients
 * that don't know forms show it as the comment.
 */
export function responseSummary(
  form: Pick<FormDefinition, 'title' | 'schema'>,
  data: Record<string, unknown>
): string {
  const lines = responseFields(form, data).map(f => `${f.label}: ${f.value}`)
  const text = [form.title, ...lines].join('\n')
  return text.length > COMMENT_MAX_CHARS ? `${text.slice(0, COMMENT_MAX_CHARS - 1)}…` : text
}

// --- the API -------------------------------------------------------------------------------------

/**
 * GET /api/sites/:name/forms[?path=] (`forms` capability; who may read comments): the live
 * version's forms config (`config`, null when it has none) and the forms that apply to `path`
 * (all of them without it).
 */
export const FormsResponseSchema = z.object({
  versionId: z.string().nullable(),
  config: FormsConfigSchema.nullable(),
  path: z.string().optional(),
  forms: z.array(FormDefinitionSchema),
})
export type FormsResponse = z.infer<typeof FormsResponseSchema>

export const RESPONSE_EXPORT_FORMATS = ['json', 'jsonl', 'csv'] as const
export const ResponseExportFormatSchema = z.enum(RESPONSE_EXPORT_FORMATS)
export type ResponseExportFormat = z.infer<typeof ResponseExportFormatSchema>

/** One response, as the export lists it. `author` is the reviewer's email. */
export const ResponseRowSchema = z.object({
  id: z.string(),
  path: z.string(),
  formId: z.string(),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  versionId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
})
export type ResponseRow = z.infer<typeof ResponseRowSchema>

/**
 * How far a form's reviewing has got: the live version's pages it applies to, who has answered it,
 * and, for each page with responses, who answered there.
 */
export const FormProgressSchema = z.object({
  form: z.string(),
  pages: z.array(z.string()),
  reviewers: z.array(z.string()),
  done: z.record(z.string(), z.array(z.string())),
})
export type FormProgress = z.infer<typeof FormProgressSchema>

/**
 * GET /api/sites/:name/responses?form=&path=&format=json (`forms` capability): the responses the
 * caller may see (on an `own` form, only their own unless they own the site or are an admin),
 * oldest first, and each form's progress. `format=jsonl` is the rows alone, one per line;
 * `format=csv` is the rows with each top-level answer in its own column (`responsesCsv`).
 */
export const ResponsesExportSchema = z.object({
  site: z.object({ name: z.string(), currentVersionId: z.string().nullable() }),
  /** the config's title, null when the live version has no forms */
  title: z.string().nullable(),
  forms: z.array(FormDefinitionSchema),
  responses: z.array(ResponseRowSchema),
  progress: z.array(FormProgressSchema),
})
export type ResponsesExport = z.infer<typeof ResponsesExportSchema>

/** Progress for one form, from the pages it applies to and the responses to it. */
export function formProgress(
  form: Pick<FormDefinition, 'id' | 'paths'>,
  pages: readonly string[],
  rows: readonly Pick<ResponseRow, 'formId' | 'path' | 'author'>[]
): FormProgress {
  const mine = rows.filter(r => r.formId === form.id)
  const done: Record<string, string[]> = {}
  for (const r of mine) {
    const authors = done[r.path] ?? []
    if (!authors.includes(r.author)) authors.push(r.author)
    done[r.path] = authors
  }
  return {
    form: form.id,
    pages: pages.filter(p => formAppliesTo(form, p)),
    reviewers: [...new Set(mine.map(r => r.author))].sort(),
    done,
  }
}

const csvCell = (value: unknown): string => {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Responses as CSV (RFC 4180, CRLF): the row's fields, then one column per top-level answer, in
 * the forms' schema order and then any others met. Nested answers are JSON in their cell.
 */
export function responsesCsv(
  rows: readonly ResponseRow[],
  forms: readonly Pick<FormDefinition, 'schema'>[] = []
): string {
  const columns: string[] = []
  const add = (k: string) => {
    if (!columns.includes(k)) columns.push(k)
  }
  for (const form of forms) Object.keys((form.schema.properties ?? {}) as object).forEach(add)
  for (const row of rows) Object.keys(row.data).forEach(add)
  const fixed = ['id', 'path', 'formId', 'author', 'createdAt', 'updatedAt', 'versionId'] as const
  const header = [...fixed, ...columns.map(c => (fixed.includes(c as never) ? `data.${c}` : c))]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [...fixed.map(k => csvCell(row[k])), ...columns.map(c => csvCell(row.data[c]))].join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Responses as JSON Lines: one row per line. */
export const responsesJsonl = (rows: readonly ResponseRow[]) =>
  rows.map(r => `${JSON.stringify(r)}\n`).join('')

/** A file name for an export: `<site>-<title>.<format>` (`interviewkit-labels.csv`). */
export function responsesFileName(
  site: string,
  title: string | null,
  format: ResponseExportFormat
) {
  const slug = (title ?? 'responses')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${site}-${slug || 'responses'}.${format}`
}
