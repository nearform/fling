/**
 * Forms on the CLI side (forms.ts in @fling/shared; the `forms` capability): a folder's
 * `fling.forms.json`, what a deploy sends as `forms`, and the forms and responses routes.
 *
 * The file sits at the top of the folder deployed. The manifest walker never lists it
 * (manifest.ts), so it is never served; a deploy checks it against the folder's pages
 * (`checkFormsConfig`), stops on errors, and sends it as the new version's `forms`. Without the
 * file, a deploy of the whole site sends `null` (the folder is the whole site, so it has no forms),
 * and a layered one (a path publish, or a pulled folder on its base) sends nothing, keeping the
 * site's forms, unless the folder was pulled with a forms file that is gone since: that sends
 * `null`. A pull writes the file back and records its hash in the site link (pull.ts).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Comment,
  CommentSchema,
  checkFormsConfig,
  FORMS_FILE,
  type FormsCheck,
  type FormsConfig,
  type FormsResponse,
  FormsResponseSchema,
  type InstanceMetadata,
  type ResponsesExport,
  ResponsesExportSchema,
} from '@fling/shared'
import type { ApiClient } from './api.ts'
import { CliError } from './errors.ts'

/** The line a deploy of a site without forms ends with (`--quiet` hides it). */
export const formsHint = (bin: string) =>
  `To collect labels, ratings or eval judgements on these pages, add a form: \`${bin} forms init\` writes ${FORMS_FILE}, then deploy again.`

/** Whether the instance has forms (the `forms` capability); missing means no. */
export function formsEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean {
  return instance?.capabilities.forms === true
}

export interface FormsFile {
  /** the file as JSON, not yet checked */
  config: unknown
  /** SHA-256 of the file's bytes, as the site link records it */
  sha256: string
}

/** The folder's `fling.forms.json`; null when it has none. Not JSON: a CliError saying where. */
export async function readFormsFile(dir: string): Promise<FormsFile | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(join(dir, FORMS_FILE))
  } catch {
    return null
  }
  try {
    return {
      config: JSON.parse(bytes.toString('utf8')),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    throw new CliError(`${join(dir, FORMS_FILE)} is not valid JSON: ${(error as Error).message}`, {
      hint: 'Fix it, or delete it to deploy without forms.',
    })
  }
}

/** A forms config checked; a CliError listing every error unless it is valid. */
export function requireValidForms(
  config: unknown,
  paths: readonly string[] | undefined,
  where: string,
  bin: string
): FormsCheck {
  const check = checkFormsConfig(config, paths)
  if (!check.ok) {
    throw new CliError(
      `${where} is not a forms config Fling can use:\n  ${check.errors.join('\n  ')}`,
      { hint: `\`${bin} forms check\` checks it; \`${bin} forms init\` writes a starter.` }
    )
  }
  return check
}

/** What a deploy sends as `forms`, and the check behind it. */
export interface FormsPlan {
  /** the config, null for none, undefined to send nothing (keep the base's) */
  send: FormsConfig | null | undefined
  check: FormsCheck | null
  /** the file's hash, for the site link; undefined when there is no file */
  sha256?: string
}

/**
 * What a deploy of `dir` sends as `forms`. `pages` are the site paths of the folder's files (to
 * say which pages each form applies to); `layered` is a path publish or a deploy on a base;
 * `pulledWithForms` says the folder's site link recorded a forms file. A forms file on an instance
 * without forms is refused (an older server would drop it); without the file, nothing is sent there.
 */
export async function planForms(opts: {
  dir: string
  pages: readonly string[]
  layered: boolean
  pulledWithForms: boolean
  instance: InstanceMetadata | null
  bin: string
  /** a config given inline (the local MCP's `forms`): used instead of the file */
  inline?: unknown
  /** the Path the deploy publishes: forms are the site's, so it sends none and refuses a config */
  path?: string
}): Promise<FormsPlan> {
  const file = opts.inline === undefined ? await readFormsFile(opts.dir) : null
  const raw = opts.inline !== undefined ? opts.inline : file?.config
  if (opts.path !== undefined) {
    if (raw === undefined || raw === null) return { send: undefined, check: null }
    throw new CliError(`Forms belong to the site, not to the Path /${opts.path}/`, {
      hint: `Deploy ${file ? FORMS_FILE : 'the forms'} with the site's root (without a path), with \`paths\` patterns that reach /${opts.path}/ if its pages need them.`,
    })
  }
  if (raw === undefined) {
    if (!formsEnabled(opts.instance)) return { send: undefined, check: null }
    const send = !opts.layered || opts.pulledWithForms ? null : undefined
    return { send, check: null }
  }
  if (!formsEnabled(opts.instance)) {
    throw new CliError(`${opts.instance?.name ?? 'This Fling'} has no forms`, {
      hint: `Delete ${FORMS_FILE} from the folder to deploy without them, or ask its operator to update it.`,
    })
  }
  if (raw === null) return { send: null, check: null }
  const where = file ? FORMS_FILE : '`forms`'
  const check = requireValidForms(raw, opts.pages, where, opts.bin)
  return {
    send: raw as FormsConfig,
    check,
    ...(file ? { sha256: file.sha256 } : {}),
  }
}

const sitePath = (name: string) => `/api/sites/${encodeURIComponent(name)}`

/** GET …/forms: the live version's config, and the forms on `path` (all of them without it). */
export function getForms(client: ApiClient, name: string, path?: string): Promise<FormsResponse> {
  return client.request('GET', `${sitePath(name)}/forms`, {
    schema: FormsResponseSchema,
    query: { path },
  })
}

/** GET …/responses (JSON): the responses the caller may see, and each form's progress. */
export function getResponses(
  client: ApiClient,
  name: string,
  opts: { form?: string; path?: string } = {}
): Promise<ResponsesExport> {
  return client.request('GET', `${sitePath(name)}/responses`, {
    schema: ResponsesExportSchema,
    query: { form: opts.form, path: opts.path, format: 'json' },
  })
}

/** POST …/comments with `response`: answer a form on a page (a page-kind answer replaces the last). */
export function submitResponse(
  client: ApiClient,
  name: string,
  input: { path: string; formId: string; data: Record<string, unknown>; quote?: string }
): Promise<Comment> {
  return client.request('POST', `${sitePath(name)}/comments`, {
    schema: CommentSchema,
    body: {
      path: input.path,
      ...(input.quote ? { anchor: { x: 0, y: 0, quote: input.quote } } : {}),
      response: { formId: input.formId, data: input.data },
    },
  })
}
