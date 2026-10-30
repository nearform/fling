/** Site management: ls, info, versions, rollback, share, visibility, access, archive/unarchive, rm. */
import {
  ACCESS_LABELS,
  type AccessLevel,
  changesAudience,
  describeAudience,
  privateAudience,
  type Site,
  type SiteDetail,
  type SiteSort,
  sharedVia,
  siteAccessLevel,
  splitEmails,
  splitGroups,
  type Visibility,
} from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadInstanceWith } from '../instance.ts'
import { waitWithSpinner } from '../ready.ts'
import {
  accessLevelsEnabled,
  archiveSite,
  audiencesEnabled,
  audienceWarnings,
  deleteSite,
  getAudience,
  getSite,
  groupsEnabled,
  listShared,
  listSites,
  rollback,
  setAccess,
  setAudience,
  setVisibility,
  share,
  versionFiles,
} from '../sites.ts'
import { formatBytes, formatDate, renderTable } from '../utils/output.ts'

export async function runList(
  ctx: CommandContext,
  opts: { archived?: boolean; sort?: SiteSort }
): Promise<void> {
  const sites = await listSites(requireClient(ctx), opts)
  ctx.out.data({ sites }, () =>
    renderTable(sites, [
      { header: 'NAME', value: s => s.name },
      { header: 'URL', value: s => s.url },
      {
        header: 'ACCESS',
        value: s => accessLabel(s) + (s.archived ? ' (archived)' : ''),
      },
      { header: 'SHARE', value: s => s.shareUrl },
      { header: 'UPDATED', value: s => formatDate(s.updatedAt) },
    ])
  )
}

/** `ls --shared`: the restricted sites others have shared with the caller. */
export async function runListShared(ctx: CommandContext, opts: { sort?: SiteSort }): Promise<void> {
  const instance = ctx.config.instance
  if (instance && !audiencesEnabled(instance)) {
    throw new CliError(`${instance.name} can't limit a site to listed people, so nothing is shared`)
  }
  const sites = await listShared(requireClient(ctx), opts)
  ctx.out.data({ sites }, () =>
    renderTable(sites, [
      { header: 'NAME', value: s => s.name },
      { header: 'URL', value: s => s.url },
      { header: 'OWNER', value: s => s.owner },
      { header: 'VIA', value: s => sharedVia(s) },
      { header: 'UPDATED', value: s => formatDate(s.updatedAt) },
    ])
  )
}

/** `Only you`, `Everyone signed in`, `Specific people`…: a site's access level, for tables. */
const accessLabel = (site: Site) => ACCESS_LABELS[siteAccessLevel(site)]

function describeSite(site: Site & { versions?: SiteDetail['versions'] }): string[] {
  const row = (label: string, value: string) => `${chalk.bold(`${label}:`.padEnd(12))}${value}`
  return [
    row('Name', site.name),
    row('URL', site.url),
    row('Access', accessLabel(site) + (site.archived ? chalk.yellow(' (archived)') : '')),
    row('SPA', site.spa ? 'yes' : 'no'),
    row('Share link', site.shareUrl ?? '-'),
    row('Version', site.currentVersionId ?? '-'),
    ...filesRow(site, row),
    row('Created', formatDate(site.createdAt)),
    row('Updated', formatDate(site.updatedAt)),
  ]
}

function filesRow(
  site: Site & { versions?: SiteDetail['versions'] },
  row: (label: string, value: string) => string
): string[] {
  const current = site.versions?.find(v => v.id === site.currentVersionId)
  if (!current) return []
  const n = current.fileCount
  return [
    row('Files', `${n} file${n === 1 ? '' : 's'}, ${formatBytes(current.totalBytes)}`),
    ...(current.publishedBy ? [row('Published by', current.publishedBy)] : []),
  ]
}

/** Who may open a private site, for copy: the instance's members, or a generic phrase. */
const membersOf = (ctx: CommandContext) =>
  ctx.config.instance ? privateAudience(ctx.config.instance) : 'anyone signed in to this Fling'

export async function runInfo(ctx: CommandContext, name: string): Promise<void> {
  const site = await getSite(requireClient(ctx), name)
  const access =
    site.audience && audiencesEnabled(ctx.config.instance)
      ? [`${chalk.bold('Who:'.padEnd(12))}${describeAudience(site, membersOf(ctx))}`]
      : []
  ctx.out.data(site, () =>
    [
      ...describeSite(site),
      ...access,
      '',
      chalk.dim(
        `${site.versions.length} version(s) — \`fling versions ${name}\`; files — \`fling files ${name}\``
      ),
    ].join('\n')
  )
}

export async function runVersions(ctx: CommandContext, name: string): Promise<void> {
  const site = await getSite(requireClient(ctx), name)
  ctx.out.data(
    { name: site.name, currentVersionId: site.currentVersionId, versions: site.versions },
    () =>
      renderTable(site.versions, [
        { header: '', value: v => (v.id === site.currentVersionId ? '*' : ' ') },
        { header: 'VERSION', value: v => v.id },
        { header: 'FILES', value: v => v.fileCount },
        { header: 'SIZE', value: v => formatBytes(v.totalBytes) },
        { header: 'BY', value: v => v.publishedBy ?? '-' },
        { header: 'CREATED', value: v => formatDate(v.createdAt) },
      ])
  )
}

export async function runFiles(
  ctx: CommandContext,
  name: string,
  versionId?: string
): Promise<void> {
  const result = await versionFiles(requireClient(ctx), name, versionId)
  if (!result.files.some(f => f.path === 'index.html')) {
    ctx.log.warn('No index.html at the root — the site root URL will 404')
  }
  ctx.out.data(result, () => {
    const n = result.files.length
    const header = chalk.dim(
      `${result.versionId}${result.current ? ' (current)' : ' (not served)'} — ${n} file${n === 1 ? '' : 's'}, ` +
        `${formatBytes(result.totalBytes)}${result.generatedIndex ? ', generated index.html' : ''}`
    )
    const table = renderTable(result.files, [
      { header: 'PATH', value: f => f.path },
      { header: 'SIZE', value: f => formatBytes(f.size) },
      { header: 'TYPE', value: f => f.contentType },
    ])
    return `${header}\n${table}`
  })
}

export async function runRollback(
  ctx: CommandContext,
  name: string,
  versionId: string
): Promise<void> {
  const site = await rollback(requireClient(ctx), name, versionId)
  ctx.log.success(`${name} now serves version ${site.currentVersionId ?? versionId}`)
  ctx.out.data(site, () => site.url)
}

export async function runShare(
  ctx: CommandContext,
  name: string,
  opts: { refresh?: boolean; revoke?: boolean }
): Promise<void> {
  if (opts.refresh && opts.revoke) throw new CliError('Use either --refresh or --revoke, not both')
  const client = requireClient(ctx)
  const result = await share(client, name, opts)
  let ready: boolean | undefined
  if (result.action === 'created' || result.action === 'refreshed') {
    // a new share label takes a few seconds to reach every edge
    const files = ctx.waitReady ? await versionFiles(client, name).catch(() => null) : null
    ready = (
      await waitWithSpinner(ctx.waitReady, result.shareUrl, files?.files.map(f => f.path) ?? [], {
        progress: ctx.progress,
        warn: m => ctx.log.warn(m),
      })
    ).ready
  }
  if (result.action === 'revoked') ctx.log.success(`Share link for ${name} revoked`)
  else if (result.action === 'refreshed')
    ctx.log.success('New share link — the old one no longer works')
  else if (result.action === 'created')
    ctx.log.success('Share link created — anyone with it can view the site')
  ctx.out.data(ready === undefined ? result : { ...result, ready }, () =>
    result.shareUrl ? result.shareUrl : chalk.dim('(no share link)')
  )
}

export async function runVisibility(
  ctx: CommandContext,
  name: string,
  visibility: string
): Promise<void> {
  if (visibility !== 'private' && visibility !== 'public') {
    throw new CliError(`Visibility must be "private" or "public", not "${visibility}"`)
  }
  const site = await setVisibility(requireClient(ctx), name, visibility as Visibility)
  ctx.log.success(
    site.visibility === 'public'
      ? `${name} is public — no sign-in needed`
      : `${name} is private — sign-in required`
  )
  ctx.out.data(site, () => site.url)
}

/** The level `fling access` sets, from `--only-me`, `--members` and `--public`. */
function levelOf(opts: { onlyMe?: boolean; members?: boolean; public?: boolean }) {
  const levels: AccessLevel[] = [
    ...(opts.onlyMe ? (['only_me'] as const) : []),
    ...(opts.members ? (['members'] as const) : []),
    ...(opts.public ? (['public'] as const) : []),
  ]
  if (levels.length > 1) throw new CliError('Use one of --only-me, --members and --public')
  return levels[0]
}

/**
 * `fling access <name> [--only-me | --members | --public] [--add …] [--remove …] [--group …]
 * [--remove-group …] [--clear]`: show who can open a site or, with options, change it: a whole
 * access level (`--only-me`, `--members`, `--public`), or its audience (the addresses and groups
 * besides the owner who may open it; editing the audience makes the site private to them, and
 * `--clear` opens it to everyone signed in).
 */
export async function runAccess(
  ctx: CommandContext,
  name: string,
  opts: {
    add?: string[]
    remove?: string[]
    group?: string[]
    removeGroup?: string[]
    clear?: boolean
    onlyMe?: boolean
    members?: boolean
    public?: boolean
  }
): Promise<void> {
  const level = levelOf(opts)
  if (level) return runSetLevel(ctx, name, level, opts)
  const instance = ctx.config.instance
  if (instance && !audiencesEnabled(instance)) {
    throw new CliError(`${instance.name} can't limit a site to listed people`)
  }
  const change = {
    add: splitEmails(opts.add ?? []),
    remove: splitEmails(opts.remove ?? []),
    addGroups: splitGroups(opts.group ?? []),
    removeGroups: splitGroups(opts.removeGroup ?? []),
    clear: opts.clear,
  }
  if (instance && (change.addGroups.length || change.removeGroups.length)) {
    if (!groupsEnabled(instance)) throw new CliError(`${instance.name} has no groups`)
  }
  const client = requireClient(ctx)
  const site = changesAudience(change)
    ? await setAudience(client, name, change)
    : await getAudience(client, name)
  const warnings = audienceWarnings(site)
  for (const w of warnings) ctx.log.warn(w)
  ctx.out.data({ ...site, warnings }, () => describeAudience(site, membersOf(ctx)))
}

async function runSetLevel(
  ctx: CommandContext,
  name: string,
  level: AccessLevel,
  opts: {
    add?: string[]
    remove?: string[]
    group?: string[]
    removeGroup?: string[]
    clear?: boolean
  }
): Promise<void> {
  if (
    opts.add?.length ||
    opts.remove?.length ||
    opts.group?.length ||
    opts.removeGroup?.length ||
    opts.clear
  ) {
    throw new CliError(`--${level === 'only_me' ? 'only-me' : level} lets no one else in`, {
      hint: 'Leave out --add, --remove, --group, --remove-group and --clear.',
    })
  }
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'accessLevels')
  if (instance && !accessLevelsEnabled(instance)) {
    throw new CliError(`${instance.name} has no access levels yet`, {
      hint: `Use \`${ctx.binName} visibility ${name} public|private\` and \`${ctx.binName} access ${name} --clear\`.`,
    })
  }
  const site = await setAccess(requireClient(ctx), name, level)
  const warnings = audienceWarnings(site)
  for (const w of warnings) ctx.log.warn(w)
  ctx.out.data({ ...site, warnings }, () => describeAudience(site, membersOf(ctx)))
}

export async function runArchive(
  ctx: CommandContext,
  name: string,
  unarchive = false
): Promise<void> {
  const site = await archiveSite(requireClient(ctx), name, { unarchive })
  ctx.log.success(
    unarchive ? `${name} restored` : `${name} archived — it 404s until \`fling unarchive ${name}\``
  )
  if (ctx.json) ctx.out.data(site, () => '')
  else if (unarchive) ctx.out.text(site.url)
}

export async function runRemove(
  ctx: CommandContext,
  name: string,
  opts: { yes?: boolean }
): Promise<void> {
  if (!opts.yes) {
    if (!ctx.interactive) {
      throw new CliError(`Refusing to delete ${name} without confirmation`, {
        hint: 'Pass --yes to delete.',
      })
    }
    const ok = await ctx.confirm(`Delete ${name} and every version of it? This cannot be undone.`)
    if (!ok) throw new CliError('Cancelled')
  }
  const result = await deleteSite(requireClient(ctx), name)
  ctx.log.success(`${name} deleted`)
  if (ctx.json) ctx.out.data(result, () => '')
}
