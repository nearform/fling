/**
 * Forms (the `forms` capability; forms.ts in @fling/shared and in the CLI):
 *
 * - `fling forms <name> [--path <page>]` shows a site's live forms config: a line per form on
 *   stderr, the config itself on stdout (so `fling forms <name> > fling.forms.json` saves it).
 * - `fling forms init [dir] [--template …] [--title …] [--force]` writes a starter
 *   `fling.forms.json` (forms-templates.ts) into the folder to deploy.
 * - `fling forms check [path]` checks a folder's file (or a file) as a deploy will, against the
 *   folder's pages.
 * - `fling responses <name> [--form] [--path] [--format json|jsonl|csv] [-o file]` lists the
 *   responses: a table and each form's progress, or the export as JSON, JSON Lines or CSV.
 *
 * `init` and `check` work offline; the others need a Fling with forms.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  checkFormsConfig,
  FORM_TEMPLATE_DESCRIPTIONS,
  FORM_TEMPLATE_NAMES,
  FORMS_FILE,
  type FormDefinition,
  formsSummaryLines,
  formsTemplate,
  isFormTemplateName,
  progressLines,
  type ResponseExportFormat,
  ResponseExportFormatSchema,
  responseFields,
  responsesCsv,
  responsesJsonl,
  responsesPageUrl,
} from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import { formsEnabled, getForms, getResponses, readFormsFile, requireValidForms } from '../forms.ts'
import { loadInstanceWith } from '../instance.ts'
import { buildManifest } from '../manifest.ts'
import { formatDate, formatJson, renderTable } from '../utils/output.ts'

/** The client, unless the instance says it has no forms. */
async function formsClient(ctx: CommandContext) {
  const client = requireClient(ctx)
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'forms')
  if (instance && !formsEnabled(instance)) {
    throw new CliError(`${instance.name} has no forms`, {
      hint: 'Ask its operator to update it (forms come with comments).',
    })
  }
  return { client, instance }
}

/** A path as typed from here: relative when inside the working directory, else absolute. */
const shown = (path: string) => {
  const rel = relative(process.cwd(), path)
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel
}

export async function runForms(
  ctx: CommandContext,
  name: string,
  opts: { path?: string }
): Promise<void> {
  const { client, instance } = await formsClient(ctx)
  const forms = await getForms(client, name, opts.path)
  if (!forms.config) {
    ctx.log.info(`${name} has no forms on its live version`)
    ctx.log.hint(
      `\`${ctx.binName} forms init\` writes a ${FORMS_FILE} to deploy with the site's folder.`
    )
    if (ctx.json) ctx.out.data(forms, () => '')
    return
  }
  const summary = checkFormsConfig(forms.config).summary
  if (summary) {
    const lines = formsSummaryLines(summary)
    const onPath = opts.path
      ? ` (on ${forms.path ?? opts.path}: ${forms.forms.map(f => f.id).join(', ') || 'none'})`
      : ''
    ctx.log.info(`${summary.title} on ${name}${onPath}`)
    for (const line of lines) ctx.log.hint(line)
  }
  if (instance)
    ctx.log.hint(`Responses and progress: ${responsesPageUrl(instance.appOrigin, name)}`)
  ctx.out.data(forms, () => formatJson(forms.config))
}

export async function runFormsInit(
  ctx: CommandContext,
  dir: string | undefined,
  opts: { template?: string; title?: string; force?: boolean }
): Promise<void> {
  const template = opts.template ?? 'labels'
  if (!isFormTemplateName(template)) {
    throw new CliError(`Unknown template "${template}"`, {
      hint: `Use one of: ${FORM_TEMPLATE_NAMES.join(', ')}.`,
    })
  }
  const folder = resolve(dir ?? '.')
  const info = await stat(folder).catch(() => null)
  if (!info?.isDirectory()) throw new CliError(`No such folder: ${dir ?? '.'}`)
  const file = join(folder, FORMS_FILE)
  if (!opts.force && (await stat(file).catch(() => null))) {
    throw new CliError(`${shown(file)} already exists`, {
      hint: 'Pass --force to replace it with the template.',
    })
  }
  const config = formsTemplate(template, opts.title)
  requireValidForms(config, undefined, 'The template', ctx.binName)
  await writeFile(file, `${formatJson(config)}\n`)
  ctx.log.success(`Wrote ${shown(file)} (${template}: ${FORM_TEMPLATE_DESCRIPTIONS[template]})`)
  ctx.out.data({ path: file, template, forms: config }, () =>
    chalk.dim(
      `Change its options, wording and paths to fit, check it with \`${ctx.binName} forms check ${shown(dirname(file))}\`, then deploy the folder.`
    )
  )
}

export async function runFormsCheck(ctx: CommandContext, path: string | undefined): Promise<void> {
  const target = resolve(path ?? '.')
  const info = await stat(target).catch(() => null)
  if (!info) throw new CliError(`No such file or folder: ${path ?? '.'}`)
  const folder = info.isDirectory() ? target : dirname(target)
  const file = info.isDirectory() ? join(target, FORMS_FILE) : target
  const config = info.isDirectory() ? (await readFormsFile(folder))?.config : await readJson(file)
  if (config === undefined) {
    throw new CliError(`No ${FORMS_FILE} in ${shown(folder)}`, {
      hint: `\`${ctx.binName} forms init ${shown(folder)}\` writes a starter.`,
    })
  }
  // Against the pages a deploy of the folder would publish (none known if it can't be deployed).
  const pages = await buildManifest(folder)
    .then(m => m.files.map(f => f.path))
    .catch(() => undefined)
  const check = checkFormsConfig(config, pages)
  if (!check.ok) {
    if (ctx.json) ctx.out.data(check, () => '')
    throw new CliError(
      `${shown(file)} is not a forms config Fling can use:\n  ${check.errors.join('\n  ')}`
    )
  }
  ctx.log.success(`${shown(file)} is valid`)
  ctx.out.data(check, () => (check.summary ? formsSummaryLines(check.summary).join('\n') : ''))
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new CliError(`${shown(file)} is not valid JSON: ${(error as Error).message}`)
  }
}

export async function runResponses(
  ctx: CommandContext,
  name: string,
  opts: { form?: string; path?: string; format?: string; output?: string }
): Promise<void> {
  let format: ResponseExportFormat | undefined
  if (opts.format !== undefined) {
    const parsed = ResponseExportFormatSchema.safeParse(opts.format)
    if (!parsed.success) throw new CliError('--format is json, jsonl or csv')
    format = parsed.data
  }
  const { client, instance } = await formsClient(ctx)
  const exported = await getResponses(client, name, { form: opts.form, path: opts.path })
  const page = instance ? responsesPageUrl(instance.appOrigin, name) : undefined

  if (format !== undefined || opts.output !== undefined) {
    const as = format ?? 'json'
    const body =
      as === 'csv'
        ? responsesCsv(exported.responses, exported.forms)
        : as === 'jsonl'
          ? responsesJsonl(exported.responses)
          : `${formatJson(exported)}\n`
    if (opts.output !== undefined) {
      await writeFile(resolve(opts.output), body)
      ctx.log.success(
        `Wrote ${exported.responses.length} response${exported.responses.length === 1 ? '' : 's'} to ${shown(resolve(opts.output))}`
      )
    } else ctx.out.data(as === 'json' ? exported : body, () => body.replace(/\n$/, ''))
    return
  }

  ctx.out.data({ ...exported, ...(page ? { responsesUrl: page } : {}) }, () => {
    if (!exported.title) return chalk.dim(`${name} has no forms on its live version.`)
    const byId = new Map<string, FormDefinition>(exported.forms.map(f => [f.id, f]))
    const table = renderTable(exported.responses, [
      { header: 'PAGE', value: r => r.path },
      { header: 'FORM', value: r => r.formId },
      { header: 'REVIEWER', value: r => r.author },
      { header: 'UPDATED', value: r => formatDate(r.updatedAt) },
      {
        header: 'ANSWERS',
        value: r => {
          const form = byId.get(r.formId)
          const fields = form
            ? responseFields(form, r.data).map(f => `${f.label}: ${f.value}`)
            : Object.entries(r.data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          const text = fields.join(' · ').replace(/\s+/g, ' ')
          return text.length > 80 ? `${text.slice(0, 79)}…` : text
        },
      },
    ])
    return [
      chalk.bold(`${exported.title} on ${name}`),
      '',
      table,
      '',
      ...progressLines(exported).map(l => chalk.dim(l)),
      ...(page ? [chalk.dim(`Progress and downloads: ${page}`)] : []),
      chalk.dim(`Export: \`${ctx.binName} responses ${name} --format csv -o responses.csv\``),
    ].join('\n')
  })
}
