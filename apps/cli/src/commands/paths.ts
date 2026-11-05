/**
 * Paths (the `paths` capability; paths.ts in the API): a site's top-level folders published on
 * their own (`fling deploy <dir> --name <site> --path <folder>`), each with its own versions,
 * rollback, owners and publishers, served at `<site>/<folder>/`.
 *
 * - `fling paths <site>` lists them: folder, title, current version, updated, archived, and
 *   whether you can publish to it; then what a site's home page can do with them.
 * - `fling paths archive|unarchive <site> <folder>` takes one off the site or puts it back;
 *   `fling paths delete <site> <folder> [--yes]` deletes it with its versions.
 * - `fling paths init [dir] [--template …] [--title …] [--force]` writes a starter home page
 *   (`index.html`, paths-templates.ts) with its Paths block in place.
 * - `fling paths check [dir|file]` checks a home page's Paths block (`checkPathsIndex`).
 *
 * `versions`, `files`, `rollback`, `owners` and `publishers` take `--path <folder>` to act on a
 * Path (commands/sites.ts). `init` and `check` work offline; the others need a Fling with Paths.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { MAX_PATH_FOLDER_LENGTH, normalizePathFolder, type SitePath } from '@fling/shared'
import { checkPathsIndex, PATHS_OPTIONS, PATHS_PLACEHOLDERS } from '@fling/shared/paths-index'
import {
  isPathsTemplateName,
  PATHS_TEMPLATE_DESCRIPTIONS,
  PATHS_TEMPLATE_NAMES,
  pathsTemplate,
} from '@fling/shared/paths-templates'
import chalk from 'chalk'
import type { ApiClient } from '../api.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadInstanceWith } from '../instance.ts'
import { archivePath, deletePath, listPaths, pathsEnabled } from '../sites.ts'
import { formatDate, renderTable } from '../utils/output.ts'

/** The home page a site with Paths has, and how to choose another: for `paths` and `paths init`. */
export const pathsHomeChoice = (bin: string) => [
  "A site's home page (its root index.html) can list its Paths:",
  `  default  no index.html of its own: Fling serves a listing of the live Paths (a site whose first publish is a Path gets one). Nothing to do.`,
  `  custom   your own index.html with a Paths block, filled with the live Paths: \`${bin} paths init\` writes a starter (${PATHS_TEMPLATE_NAMES.join(', ')}); adapt it, keeping the block, \`${bin} paths check\` it, then deploy it as the site root (without --path).`,
  '  none     an index.html without a Paths block lists no Paths; a deploy then says so.',
]

/** The client, unless the instance says it has no Paths. */
export async function pathsClient(ctx: CommandContext): Promise<ApiClient> {
  const client = requireClient(ctx)
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'paths')
  if (instance && !pathsEnabled(instance)) {
    throw new CliError(`${instance.name} has no Paths`, { hint: 'Ask its operator to update it.' })
  }
  return client
}

/** `--path` or a folder argument, normalised: one top-level folder of the site. */
export function pathFolder(raw: string): string {
  const folder = normalizePathFolder(raw)
  if (folder === null) {
    throw new CliError(`Invalid Path "${raw}"`, {
      hint: `A Path is one top-level folder of the site, like PAY-412 (no dotfiles, at most ${MAX_PATH_FOLDER_LENGTH} characters).`,
    })
  }
  return folder
}

const stateOf = (p: SitePath) =>
  p.archived ? chalk.yellow('archived') : p.currentVersionId ? 'live' : chalk.dim('unpublished')

export async function runPaths(ctx: CommandContext, name: string): Promise<void> {
  const paths = await listPaths(await pathsClient(ctx), name)
  if (!ctx.json) {
    if (paths.length === 0) ctx.log.info(`${name} has no Paths yet`)
    for (const line of pathsHomeChoice(ctx.binName)) ctx.log.hint(line)
  }
  ctx.out.data({ name, paths }, () =>
    paths.length === 0
      ? chalk.dim(
          `Publish a folder as one: \`${ctx.binName} deploy ./plan --name ${name} --path PAY-412\`.`
        )
      : renderTable(paths, [
          { header: 'PATH', value: p => `/${p.folder}/` },
          { header: 'TITLE', value: p => p.title || '-' },
          { header: 'VERSION', value: p => p.currentVersionId ?? '-' },
          { header: 'STATE', value: stateOf },
          { header: 'PUBLISH', value: p => (p.canPublish ? 'yes' : 'no') },
          { header: 'UPDATED', value: p => formatDate(p.updatedAt) },
        ])
  )
}

export async function runPathArchive(
  ctx: CommandContext,
  name: string,
  raw: string,
  unarchive = false
): Promise<void> {
  const folder = pathFolder(raw)
  const path = await archivePath(await pathsClient(ctx), name, folder, !unarchive)
  ctx.log.success(
    unarchive
      ? `/${folder}/ of ${name} restored`
      : `/${folder}/ of ${name} archived: it 404s until \`${ctx.binName} paths unarchive ${name} ${folder}\``
  )
  if (ctx.json) ctx.out.data(path, () => '')
  else if (unarchive) ctx.out.text(path.url)
}

export async function runPathDelete(
  ctx: CommandContext,
  name: string,
  raw: string,
  opts: { yes?: boolean }
): Promise<void> {
  const folder = pathFolder(raw)
  const client = await pathsClient(ctx)
  if (!opts.yes) {
    if (!ctx.interactive) {
      throw new CliError(`Refusing to delete /${folder}/ of ${name} without confirmation`, {
        hint: 'Pass --yes to delete.',
      })
    }
    const ok = await ctx.confirm(
      `Delete /${folder}/ of ${name} and every version of it? This cannot be undone.`
    )
    if (!ok) throw new CliError('Cancelled')
  }
  const result = await deletePath(client, name, folder)
  ctx.log.success(`/${folder}/ of ${name} deleted`)
  if (ctx.json) ctx.out.data(result, () => '')
}

/** A path as typed from here: relative when inside the working directory, else absolute. */
const shown = (path: string) => {
  const rel = relative(process.cwd(), path)
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel
}

export async function runPathsInit(
  ctx: CommandContext,
  dir: string | undefined,
  opts: { template?: string; title?: string; force?: boolean }
): Promise<void> {
  const template = opts.template ?? 'minimal'
  if (!isPathsTemplateName(template)) {
    throw new CliError(`Unknown template "${template}"`, {
      hint: `Use one of: ${PATHS_TEMPLATE_NAMES.join(', ')}.`,
    })
  }
  const folder = resolve(dir ?? '.')
  const info = await stat(folder).catch(() => null)
  if (!info?.isDirectory()) throw new CliError(`No such folder: ${dir ?? '.'}`)
  const file = join(folder, 'index.html')
  if (!opts.force && (await stat(file).catch(() => null))) {
    throw new CliError(`${shown(file)} already exists`, {
      hint: `Pass --force to replace it with the template, or add a Paths block to it (\`${ctx.binName} paths check ${shown(file)}\` says how).`,
    })
  }
  const html = pathsTemplate(template, { title: opts.title })
  await writeFile(file, html)
  ctx.log.success(`Wrote ${shown(file)} (${template}: ${PATHS_TEMPLATE_DESCRIPTIONS[template]})`)
  ctx.out.data({ path: file, template }, () =>
    chalk.dim(
      `Adapt its wording and look, keeping the <!-- fling:paths --> block; check it with \`${ctx.binName} paths check ${shown(folder)}\`, then deploy the folder as the site root (without --path).`
    )
  )
}

export async function runPathsCheck(ctx: CommandContext, path: string | undefined): Promise<void> {
  const target = resolve(path ?? '.')
  const info = await stat(target).catch(() => null)
  if (!info) throw new CliError(`No such file or folder: ${path ?? '.'}`)
  const file = info.isDirectory() ? join(target, 'index.html') : target
  const html = await readFile(file, 'utf8').catch(() => null)
  if (html === null) {
    throw new CliError(`No ${shown(file)}`, {
      hint: `\`${ctx.binName} paths init ${shown(info.isDirectory() ? target : resolve(target, '..'))}\` writes a starter.`,
    })
  }
  const check = checkPathsIndex(html)
  for (const w of check.warnings) ctx.log.warn(w)
  if (!check.ok) {
    if (ctx.json) ctx.out.data({ path: file, ...check }, () => '')
    throw new CliError(`${shown(file)} has no Paths block:\n  ${check.errors.join('\n  ')}`, {
      hint: `Placeholders in a template: ${PATHS_PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}. Options: ${PATHS_OPTIONS.join(', ')}.`,
    })
  }
  ctx.log.success(
    `${shown(file)} has a ${check.block} Paths block${check.options.length ? ` (${check.options.join(', ')})` : ''}`
  )
  ctx.out.data({ path: file, ...check }, () =>
    chalk.dim(
      'Deploy it as the site root (without --path): the listing fills in with the live Paths.'
    )
  )
}
