/**
 * `fling [path] [--name x] [--spa] [--access <level> [--add …] [--group …]] [--public] [--yes]
 * [--[no-]list-html]` — the default command.
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
 * `--access` (access.ts in @fling/shared) is who can open a new site; without it the site gets the
 * instance's default, and the CLI says who that is. A site that has been live keeps its access
 * (`fling access` changes it).
 *
 * Dotfiles, gitignored files, secret files and files containing secrets are never flung (see
 * manifest.ts); there is no flag to include them. Skipped files are listed (`skipped` in --json).
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ACCESS_LABELS,
  type AccessLevel,
  type AudienceInput,
  accessChangeHint,
  describeSiteAccess,
  type InstanceMetadata,
  isValidSiteName,
  needsAudience,
  parseAccessLevel,
  privateAudience,
  reviewUrl,
  SITE_NAME_MAX,
  siteAccessLevel,
  splitEmails,
  splitGroups,
} from '@fling/shared'
import chalk from 'chalk'
import type { ApiClient } from '../api.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { deploy, resolveSiteName } from '../deploy.ts'
import { CliError } from '../errors.ts'
import { type PreparedInput, prepareInput } from '../inputs.ts'
import { loadInstance, loadInstanceWith } from '../instance.ts'
import {
  buildManifest,
  describeSkipped,
  hasRootIndex,
  htmlPages,
  NO_INDEX_WARNING,
  withHtmlListing,
} from '../manifest.ts'
import { waitWithSpinner } from '../ready.ts'
import {
  accessLevelsEnabled,
  checkName,
  commentsEnabled,
  type SitesBase,
  sitesBaseOf,
  siteUrlFor,
} from '../sites.ts'
import { box, brand } from '../ui/theme.ts'
import { formatBytes } from '../utils/output.ts'

export interface DeployCommandOptions {
  name?: string
  spa?: boolean
  public?: boolean
  /** who can open a new site: an access level (or one of its aliases, `parseAccessLevel`) */
  access?: string
  /** with `access` people (or groups): the addresses that may open it */
  add?: string[]
  /** with `access` groups (or people): the groups, by slug */
  group?: string[]
  /** never prompt */
  yes?: boolean
  /** No root index.html: true → generate a listing of the HTML pages; false → fling anyway. */
  listHtml?: boolean
}

export type NoIndexChoice = 'list' | 'fling'

/** Who can open a new site, from `--access`, `--add` and `--group`; checked before anything runs. */
export function accessChoice(
  opts: Pick<DeployCommandOptions, 'access' | 'add' | 'group' | 'public'>,
  bin = 'fling'
): { access?: AccessLevel; audience?: AudienceInput } {
  const emails = splitEmails(opts.add ?? [])
  const groups = splitGroups(opts.group ?? [])
  const named = emails.length + groups.length > 0
  let level: AccessLevel | undefined
  if (opts.access !== undefined) {
    const parsed = parseAccessLevel(opts.access)
    if (!parsed) {
      throw new CliError(`Unknown access "${opts.access}"`, {
        hint: 'Use only_me, members, groups, people or public.',
      })
    }
    level = parsed
  } else if (named) level = emails.length ? 'people' : 'groups'
  if (!level) return {}
  if (opts.public) throw new CliError('Use --access or --public, not both')
  if (needsAudience(level) && !named) {
    throw new CliError(`--access ${level} needs someone to let in`, {
      hint: `Add --add <emails> or --group <slugs> (\`${bin} groups\` lists them).`,
    })
  }
  if (!needsAudience(level) && named) {
    throw new CliError(`--access ${level} lets no one else in: leave out --add and --group`)
  }
  return { access: level, ...(needsAudience(level) ? { audience: { emails, groups } } : {}) }
}

export async function runDeploy(
  ctx: CommandContext,
  input: string | undefined,
  opts: DeployCommandOptions
): Promise<void> {
  const client = requireClient(ctx)
  const ask = ctx.interactive && !opts.yes
  const choice = accessChoice(opts, ctx.binName)
  // Where the site will be served and who can see it: from the instance stored at login.
  // (Asked for an access level: fetched again if the stored copy predates them.)
  const instance = choice.access
    ? await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'accessLevels')
    : await loadInstance(ctx.store, ctx.config, ctx.fetch)
  const base = sitesBaseOf(instance)
  if (choice.access && instance && !accessLevelsEnabled(instance)) {
    throw new CliError(`${instance.name} can't take --access yet`, {
      hint: `Leave it out, then use \`${ctx.binName} access\` or \`${ctx.binName} visibility\`.`,
    })
  }

  const path = resolve(input ?? '.')
  if (!(await stat(path).catch(() => null)))
    throw new CliError(`No such file or folder: ${input ?? '.'}`, {
      hint: `Give the path to a folder, .html, .zip or other file, e.g. \`${ctx.binName} deploy ./dist\`.`,
    })
  const prepared = await prepareInput(path)
  try {
    const { access: _asked, ...rest } = opts
    await deployPrepared(ctx, client, instance, base, prepared, { ...rest, ...choice }, ask)
  } finally {
    await prepared.cleanup()
  }
}

async function deployPrepared(
  ctx: CommandContext,
  client: ApiClient,
  instance: InstanceMetadata | null,
  base: SitesBase | null,
  prepared: PreparedInput,
  opts: Omit<DeployCommandOptions, 'access'> & ReturnType<typeof accessChoice>,
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
      access: opts.access,
      audience: opts.audience,
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

  // Who can open it: a new site's access (asked for, or the instance's default) and how to
  // change it; an existing one's, which a deploy never changes.
  const members = instance ? privateAudience(instance) : 'anyone signed in to this Fling'
  const level = siteAccessLevel(result.site)
  const who = describeSiteAccess(result.site, members)
  if (!result.first && opts.access) {
    ctx.log.warn(
      `--access only applies to a new site: ${result.name} keeps its access. Change it with \`${ctx.binName} access ${result.name}\`.`
    )
  }
  const accessNotes = result.first
    ? [`Who can open it: ${who}`, accessChangeHint('cli', result.name, ctx.binName)]
    : level === 'public'
      ? []
      : [`${who} Share it with a link: \`${ctx.binName} share ${result.name}\`.`]
  // With comments on, the review page is the link to share for feedback; the site URL follows.
  const review =
    instance && commentsEnabled(instance) ? reviewUrl(instance.appOrigin, result.name) : undefined
  const reviewNote = instance
    ? `Share for feedback (reviewers sign in to ${instance.name}):`
    : 'Share for feedback:'
  const data = {
    status: result.status,
    site: result.site,
    access: level,
    ...(result.first ? { created: true } : {}),
    ...(review ? { reviewUrl: review } : {}),
    ready,
    skipped: local.skipped,
  }
  ctx.out.data(data, () => {
    // On a terminal the URLs get a box; piped, the site URL stays the first line on its own so
    // `fling deploy … | pbcopy` works.
    if (ctx.out.tty)
      return box(
        [
          ...(review ? [chalk.dim(reviewNote), brand.url(review), '', chalk.dim('Site:')] : []),
          brand.url(result.url),
          ...accessNotes.map(n => chalk.dim(n)),
        ],
        chalk.bold(`flung · ${ACCESS_LABELS[level].toLowerCase()}`)
      )
    const lines = [chalk.bold(result.url)]
    if (review) lines.push(chalk.dim(`${reviewNote} ${review}`))
    for (const n of accessNotes) lines.push(chalk.dim(n))
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
