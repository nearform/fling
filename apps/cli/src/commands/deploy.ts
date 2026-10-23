/**
 * `fling [path] [--name x] [--spa] [--public] [--yes] [--[no-]list-html]` — the default command.
 *
 * `path` is a folder, a single .html file, a .zip or any other file (inputs.ts). It must exist as
 * given: the CLI never goes looking for it elsewhere (the MCP server does, see locate.ts).
 *
 * On a terminal (and without `--yes`) it asks before flinging: it confirms the generated site name
 * (checked against GET /api/names/:name; a taken name defaults to the first free suggestion) and,
 * when there is no root index.html, whether to list the HTML pages on a generated index page,
 * fling anyway or abort. Without a terminal (CI, agents) or with `--yes` it never asks: with no
 * index.html it generates the listing when there are HTML pages (else warns), and a taken name
 * fails with suggestions (it never silently picks another name). `--list-html` / `--no-list-html`
 * decide the listing up front.
 *
 * Dotfiles, gitignored files, secret files and files containing secrets are never flung (see
 * manifest.ts); there is no flag to include them. Skipped files are listed (`skipped` in --json).
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isValidSiteName, SITE_NAME_MAX } from '@fling/shared'
import chalk from 'chalk'
import type { ApiClient } from '../api.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { deploy, resolveSiteName } from '../deploy.ts'
import { CliError } from '../errors.ts'
import { type PreparedInput, prepareInput } from '../inputs.ts'
import {
  buildManifest,
  describeSkipped,
  hasRootIndex,
  htmlPages,
  NO_INDEX_WARNING,
  withHtmlListing,
} from '../manifest.ts'
import { waitWithSpinner } from '../ready.ts'
import { checkName, discoverSitesBase, type SitesBase, sitesBaseFor, siteUrlFor } from '../sites.ts'
import { box, brand } from '../ui/theme.ts'
import { formatBytes } from '../utils/output.ts'

export interface DeployCommandOptions {
  name?: string
  spa?: boolean
  public?: boolean
  /** never prompt */
  yes?: boolean
  /** No root index.html: true → generate a listing of the HTML pages; false → fling anyway. */
  listHtml?: boolean
}

export type NoIndexChoice = 'list' | 'fling'

export async function runDeploy(
  ctx: CommandContext,
  input: string | undefined,
  opts: DeployCommandOptions
): Promise<void> {
  const client = requireClient(ctx)
  const ask = ctx.interactive && !opts.yes
  // Where the site will be served, for the prompts (only worth a lookup when we're asking).
  const base = ask ? await discoverSitesBase(client) : sitesBaseFor(client.serverUrl)

  const path = resolve(input ?? '.')
  if (!(await stat(path).catch(() => null)))
    throw new CliError(`No such file or folder: ${input ?? '.'}`, {
      hint: `Give the path to a folder, .html, .zip or other file, e.g. \`${ctx.binName} deploy ./dist\`.`,
    })
  const prepared = await prepareInput(path)
  try {
    await deployPrepared(ctx, client, base, prepared, opts, ask)
  } finally {
    await prepared.cleanup()
  }
}

async function deployPrepared(
  ctx: CommandContext,
  client: ApiClient,
  base: SitesBase | null,
  prepared: PreparedInput,
  opts: DeployCommandOptions,
  ask: boolean
): Promise<void> {
  let local = await buildManifest(prepared.dir)
  local.skipped.dotfiles.unshift(...prepared.skippedDotfiles)
  // Never flung, whatever the flags: say so, so nobody wonders where .env went.
  for (const line of describeSkipped(local.skipped)) ctx.log.info(line)
  let name =
    opts.name !== undefined ? resolveSiteName(prepared.dir, opts.name) : prepared.defaultName
  if (opts.name === undefined && ask) name = await confirmSiteName(ctx, client, name, base)

  if (!hasRootIndex(local)) {
    const pages = htmlPages(local).length
    const root = base ? siteUrlFor(name, base) : 'the site root'
    const warning = `No index.html at the root — ${root} will show a 404.`
    const choice: NoIndexChoice =
      opts.listHtml === true
        ? 'list'
        : opts.listHtml === false
          ? 'fling'
          : ask
            ? await askNoIndex(ctx, pages)
            : pages > 0
              ? 'list'
              : 'fling'
    if (choice === 'list') {
      local = await withHtmlListing(local, name)
      ctx.log.info(`Generated index.html listing ${pages} HTML page${pages === 1 ? '' : 's'}`)
    } else ctx.log.warn(warning)
  }

  let progressShown = false
  const result = await deploy(
    { client, fetch: ctx.fetch },
    {
      dir: prepared.dir,
      name,
      manifest: local,
      spa: opts.spa ? true : undefined,
      public: opts.public,
      onProgress: p => {
        if (p.total === 0) return
        progressShown = true
        ctx.progress(
          `${progressBar(p.totalBytes ? p.bytes / p.totalBytes : p.uploaded / p.total)} uploading ${p.uploaded}/${p.total} files · ${formatBytes(p.bytes)}/${formatBytes(p.totalBytes)}`
        )
      },
    }
  ).finally(() => {
    if (progressShown) ctx.progress(null)
  })

  for (const warning of result.warnings) if (warning !== NO_INDEX_WARNING) ctx.log.warn(warning)
  const summary = `${result.fileCount} files, ${formatBytes(result.totalBytes)}`
  if (result.status === 'unchanged') ctx.log.info(`Unchanged ${chalk.dim(`(${summary})`)}`)
  else if (result.status === 'repointed')
    ctx.log.success(`Restored version ${result.versionId} ${chalk.dim(`(${summary})`)}`)
  else
    ctx.log.success(
      `Deployed ${result.name} ${chalk.dim(`(${summary}; uploaded ${result.uploaded}, version ${result.versionId})`)}`
    )

  // A new or re-pointed version takes a few seconds to reach every edge: don't hand out a URL
  // that 404s. (`unchanged` was already live.)
  const ready =
    result.status === 'unchanged'
      ? true
      : (
          await waitWithSpinner(
            ctx.waitReady,
            result.url,
            local.files.map(f => f.path),
            { progress: ctx.progress, warn: m => ctx.log.warn(m) }
          )
        ).ready

  const privateNote = `Private: Nearform sign-in required. Share publicly with \`${ctx.binName} share ${result.name}\`.`
  ctx.out.data({ status: result.status, site: result.site, ready, skipped: local.skipped }, () => {
    const isPrivate = result.site.visibility === 'private'
    // On a terminal the URL gets a box; piped, it stays a bare line so `fling deploy … | pbcopy` works.
    if (ctx.out.tty)
      return box(
        [brand.url(result.url), ...(isPrivate ? [chalk.dim(privateNote)] : [])],
        isPrivate ? chalk.bold('flung · private') : chalk.bold('flung · public')
      )
    const lines = [chalk.bold(result.url)]
    if (isPrivate) lines.push(chalk.dim(privateNote))
    return lines.join('\n')
  })
}

const BAR_WIDTH = 20

/** `━━━━━━━━──────` for a fraction 0…1. */
function progressBar(fraction: number): string {
  const done = Math.round(Math.min(Math.max(fraction, 0), 1) * BAR_WIDTH)
  return brand.primary('━'.repeat(done)) + chalk.dim('─'.repeat(BAR_WIDTH - done))
}

/**
 * No root index.html, on a terminal: list the HTML pages on a generated index (the default when
 * there are any), fling anyway, or abort (the default when there are none).
 */
export async function askNoIndex(ctx: CommandContext, pages: number): Promise<NoIndexChoice> {
  const question =
    pages > 0
      ? 'No index.html at the root. [L]ist the HTML pages on a generated index page / [f]ling anyway (the root will 404) / [a]bort '
      : 'No index.html at the root (and no HTML pages to list). [f]ling anyway (the root will 404) / [A]bort '
  for (;;) {
    const answer = (await ctx.prompt(question)).trim().toLowerCase()
    if (pages > 0 && (answer === '' || answer === 'l' || answer === 'list')) return 'list'
    if (answer === 'f' || answer === 'fling') return 'fling'
    if (answer === 'a' || answer === 'abort' || answer === 'n' || answer === 'no' || answer === '')
      throw new CliError('Not flung: no index.html at the root', {
        hint: 'Fling the folder that contains index.html (your build output, e.g. ./dist), or pass --list-html / --no-list-html.',
      })
  }
}

/**
 * Show the generated name (and whether it is new, yours or taken) and let the user accept it,
 * type another, or abort. Loops until a usable name is accepted.
 */
export async function confirmSiteName(
  ctx: CommandContext,
  client: ApiClient,
  generated: string,
  base: SitesBase | null
): Promise<string> {
  const where = (n: string) => (base ? ` → ${siteUrlFor(n, base)}` : '')
  const describe = (n: string, note: string) =>
    ctx.log.info(`Site name: ${chalk.bold(n)}${where(n)}  ${chalk.dim(`(${note})`)}`)

  let candidate = generated
  for (;;) {
    const check = await checkName(client, candidate)
    let proposal: string | undefined
    if (check.status === 'available' || check.status === 'yours') {
      proposal = candidate
      describe(candidate, check.status === 'yours' ? 'updates your existing site' : 'new')
    } else {
      const why = check.status === 'taken' ? 'is taken' : 'is not a valid site name'
      const alternatives = check.suggestions.length
        ? ` Suggestions: ${check.suggestions.join(', ')}`
        : ''
      ctx.log.warn(`${candidate} ${why}.${alternatives}`)
      proposal = check.suggestions[0]
      if (proposal) describe(proposal, 'new')
    }

    for (;;) {
      const question = proposal
        ? `Use "${proposal}"? [Y/n or type another name] `
        : 'Type a site name (or n to abort): '
      const answer = (await ctx.prompt(question)).trim()
      if (proposal && (answer === '' || /^y(es)?$/i.test(answer))) return proposal
      if (/^no?$/i.test(answer))
        throw new CliError('Aborted — nothing was flung', {
          hint: 'Pass --name <name> to choose the site name up front.',
        })
      if (answer === '') continue
      if (!isValidSiteName(answer)) {
        ctx.log.warn(
          `"${answer}" is not a valid site name: use lowercase letters, digits and single hyphens (max ${SITE_NAME_MAX}); some names are reserved.`
        )
        continue
      }
      candidate = answer
      break
    }
  }
}
