/**
 * Site management: ls, info, versions, rollback, share, visibility, access, owners, publishers,
 * archive/unarchive, keep (the archive policy's flag), rm, stats. `versions`, `files`, `rollback`, `owners` and `publishers` take `--path`
 * to act on one of the site's Paths instead (commands/paths.ts).
 */
import {
  ACCESS_LABELS,
  type AccessLevel,
  changesAudience,
  deleteConfirmText,
  deletedText,
  describeAudience,
  describeRoles,
  describeSiteArchive,
  privateAudience,
  recoverableDeletesOf,
  type Site,
  type SiteDetail,
  type SiteSort,
  sharedVia,
  siteAccessLevel,
  splitEmails,
  splitGroups,
  type Visibility,
  whoHolds,
} from '@fling/shared'
import chalk from 'chalk'
import { CliApiError } from '../api.ts'
import { requireArchivePolicy, setKeep } from '../archive-policy.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadFreshInstance, loadInstanceWith } from '../instance.ts'
import { waitWithSpinner } from '../ready.ts'
import {
  accessLevelsEnabled,
  archiveSite,
  audiencesEnabled,
  audienceWarnings,
  deleteSite,
  getAudience,
  getPath,
  getPathRoles,
  getRoles,
  getSite,
  groupsEnabled,
  listShared,
  listSharedPage,
  listSites,
  listSitesPage,
  pathVersionFiles,
  type RoleList,
  rollback,
  rollbackPath,
  setAccess,
  setAudience,
  setPathRoles,
  setRoles,
  setVisibility,
  share,
  siteRolesEnabled,
  versionFiles,
} from '../sites.ts'
import { getSiteMetrics, getYourSitesMetrics, metricsEnabled, sparkline } from '../stats.ts'
import { formatBytes, formatDate, renderTable } from '../utils/output.ts'
import { pathFolder, pathsClient } from './paths.ts'
import { ago } from './servers.ts'

/** `ls` and `ls --shared`: `limit` asks for one page, after `after` (a page's cursor). */
export interface ListOptions {
  archived?: boolean
  sort?: SiteSort
  limit?: number
  after?: string
}

/**
 * The command that lists the next page, after a page with more to come: the same flags, and
 * `--after` the page's cursor.
 */
export function nextPageCommand(
  opts: ListOptions & { shared?: boolean; limit: number },
  cursor: string
): string {
  return [
    'fling ls',
    ...(opts.shared ? ['--shared'] : []),
    ...(opts.archived ? ['--archived'] : []),
    ...(opts.sort ? [`--sort ${opts.sort}`] : []),
    `--limit ${opts.limit}`,
    `--after ${cursor}`,
  ].join(' ')
}

/** A page's rows, then (with more to come) the command for the next page. */
function printList<T>(
  ctx: CommandContext,
  page: { sites: T[]; cursor?: string | null },
  next: (cursor: string) => string,
  table: () => string
) {
  const paged = page.cursor !== undefined
  ctx.out.data(paged ? { sites: page.sites, cursor: page.cursor } : { sites: page.sites }, () =>
    page.cursor ? `${table()}\n\nMore sites: ${next(page.cursor)}` : table()
  )
}

export async function runList(ctx: CommandContext, opts: ListOptions): Promise<void> {
  const client = requireClient(ctx)
  const { limit } = opts
  const page =
    limit === undefined
      ? { sites: await listSites(client, opts) }
      : await listSitesPage(client, { ...opts, limit, cursor: opts.after })
  const { sites } = page
  printList(
    ctx,
    page,
    cursor => nextPageCommand({ ...opts, limit: limit ?? 0 }, cursor),
    () =>
      renderTable(sites, [
        { header: 'NAME', value: s => s.name },
        { header: 'URL', value: s => s.url },
        {
          header: 'ACCESS',
          value: s => accessLabel(s) + (s.archived ? ' (archived)' : ''),
        },
        ...(sites.some(s => s.role) ? [{ header: 'ROLE', value: (s: Site) => s.role ?? '-' }] : []),
        { header: 'SHARE', value: s => s.shareUrl },
        { header: 'UPDATED', value: s => formatDate(s.updatedAt) },
      ])
  )
}

/** `ls --shared`: the restricted sites others have shared with the caller. */
export async function runListShared(
  ctx: CommandContext,
  opts: Omit<ListOptions, 'archived'>
): Promise<void> {
  const instance = ctx.config.instance
  if (instance && !audiencesEnabled(instance)) {
    throw new CliError(`${instance.name} can't limit a site to listed people, so nothing is shared`)
  }
  const client = requireClient(ctx)
  const { limit } = opts
  const page =
    limit === undefined
      ? { sites: await listShared(client, opts) }
      : await listSharedPage(client, { ...opts, limit, cursor: opts.after })
  printList(
    ctx,
    page,
    cursor => nextPageCommand({ ...opts, shared: true, limit: limit ?? 0 }, cursor),
    () =>
      renderTable(page.sites, [
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

const row = (label: string, value: string) => `${chalk.bold(`${label}:`.padEnd(14))}${value}`

function describeSite(site: Site & { versions?: SiteDetail['versions'] }): string[] {
  return [
    row('Name', site.name),
    row('URL', site.url),
    row('Access', accessLabel(site) + (site.archived ? chalk.yellow(' (archived)') : '')),
    row('SPA', site.spa ? 'yes' : 'no'),
    row('Share link', site.shareUrl ?? '-'),
    row('Version', site.currentVersionId ?? '-'),
    ...filesRow(site),
    row('Created', formatDate(site.createdAt)),
    row('Updated', formatDate(site.updatedAt)),
  ]
}

/** Owners, Publishers and You: the site's roles, from servers with site roles. */
function rolesRows(site: SiteDetail): string[] {
  return [
    ...(site.owners ? [row('Owners', whoHolds(site.owners))] : []),
    ...(site.owners ? [row('Publishers', whoHolds(site.publishers))] : []),
    ...(site.role ? [row('You', site.role)] : []),
  ]
}

/** What the archive policy says of the site: kept, archived by it, what it does next and when. */
function archiveRows(site: SiteDetail): string[] {
  return describeSiteArchive(site, formatDate).map((line, i) =>
    i === 0 ? row('Archiving', line) : `${' '.repeat(14)}${line}`
  )
}

function filesRow(site: Site & { versions?: SiteDetail['versions'] }): string[] {
  const current = site.versions?.find(v => v.id === site.currentVersionId)
  if (!current) return []
  const n = current.fileCount
  return [
    row('Files', `${n} file${n === 1 ? '' : 's'}, ${formatBytes(current.totalBytes)}`),
    ...(current.publishedBy ? [row('Published by', current.publishedBy)] : []),
    ...(current.path ? [row('Published to', `/${current.path}/`)] : []),
  ]
}

/** Who may open a private site, for copy: the instance's members, or a generic phrase. */
const membersOf = (ctx: CommandContext) =>
  ctx.config.instance ? privateAudience(ctx.config.instance) : 'anyone signed in to this Fling'

export async function runInfo(ctx: CommandContext, name: string): Promise<void> {
  const site = await getSite(requireClient(ctx), name)
  const access =
    site.audience && audiencesEnabled(ctx.config.instance)
      ? [`${chalk.bold('Who:'.padEnd(14))}${describeAudience(site, membersOf(ctx))}`]
      : []
  ctx.out.data(site, () =>
    [
      ...describeSite(site),
      ...access,
      ...rolesRows(site),
      ...archiveRows(site),
      '',
      chalk.dim(
        `${site.versions.length} version(s) — \`fling versions ${name}\`; files — \`fling files ${name}\``
      ),
    ].join('\n')
  )
}

/** `fling stats [name]`: a site's views and pushes, or without a name your live sites', counts only. */
export async function runStats(ctx: CommandContext, name?: string): Promise<void> {
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'metrics')
  if (metricsEnabled(instance) === false) {
    throw new CliError(`${instance?.name ?? 'This Fling'} has no site metrics`, {
      hint: 'Ask its operator to update it.',
    })
  }
  const instanceName = instance?.name ?? 'this Fling'
  const client = requireClient(ctx)
  const m =
    name === undefined
      ? await getYourSitesMetrics(client, instanceName)
      : await getSiteMetrics(client, name, instanceName)
  const totals = (key: 'views' | 'pushes') =>
    `${m.totals.days[key]} in ${m.days.length} days · ${m.totals.months[key]} in ${m.months.length} months`
  const daily = (key: 'views' | 'pushes') =>
    `${sparkline(m.days.map(d => d[key]))}  ${chalk.dim(`${m.days[0]?.day} → ${m.days.at(-1)?.day}`)}`
  const when = (iso: string | null) => (iso ? `${ago(iso)} (${formatDate(iso)})` : 'never')
  ctx.out.data(m, () =>
    [
      'name' in m
        ? row('Site', m.name)
        : row(
            'Sites',
            m.sites < m.of
              ? `your ${m.sites} live sites updated last, of ${m.of}`
              : `your ${m.sites} live site${m.sites === 1 ? '' : 's'} together`
          ),
      ...(m.viewCounts ? [row('Views', totals('views')), row('Views/day', daily('views'))] : []),
      row('Pushes', totals('pushes')),
      row('Pushes/day', daily('pushes')),
      ...(m.viewCounts ? [row('Last viewed', when(m.lastViewAt))] : []),
      row('Last pushed', when(m.lastPushAt)),
      row('Since', m.since ? formatDate(m.since) : 'nothing counted yet'),
      '',
      chalk.dim(
        !m.viewCounts
          ? `${instanceName} doesn't count views, so these are pushes only. Days are UTC.`
          : m.counting === false
            ? `View counting is off on ${instanceName}: these are the views counted before. Days are UTC.`
            : 'Counts only: nothing is recorded about who viewed. Days are UTC; today is so far.'
      ),
    ].join('\n')
  )
}

export async function runVersions(
  ctx: CommandContext,
  name: string,
  opts: { path?: string } = {}
): Promise<void> {
  if (opts.path !== undefined) return runPathVersions(ctx, name, pathFolder(opts.path))
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
        { header: 'PATH', value: v => (v.path ? `/${v.path}/` : '-') },
        { header: 'CREATED', value: v => formatDate(v.createdAt) },
      ])
  )
}

/** `versions --path`: the Path's own versions, newest first (* = the one it serves). */
async function runPathVersions(ctx: CommandContext, name: string, folder: string): Promise<void> {
  const path = await getPath(await pathsClient(ctx), name, folder)
  ctx.out.data(
    {
      name,
      path: path.folder,
      currentVersionId: path.currentVersionId,
      versions: path.versions,
    },
    () =>
      renderTable(path.versions, [
        { header: '', value: v => (v.id === path.currentVersionId ? '*' : ' ') },
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
  versionId?: string,
  opts: { path?: string } = {}
): Promise<void> {
  const folder = opts.path === undefined ? undefined : pathFolder(opts.path)
  const result =
    folder === undefined
      ? await versionFiles(requireClient(ctx), name, versionId)
      : await pathVersionFiles(await pathsClient(ctx), name, folder, versionId)
  // A Path's files are named within its folder, so its home page is its own index.html too.
  if (!result.files.some(f => f.path === 'index.html')) {
    ctx.log.warn(
      folder === undefined
        ? 'No index.html at the root — the site root URL will 404'
        : `No index.html in /${folder}/ — it will 404`
    )
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
  versionId: string,
  opts: { path?: string } = {}
): Promise<void> {
  if (opts.path !== undefined) {
    const folder = pathFolder(opts.path)
    const path = await rollbackPath(await pathsClient(ctx), name, folder, versionId)
    ctx.log.success(
      `/${folder}/ of ${name} now serves version ${path.currentVersionId ?? versionId} (the rest of the site untouched)`
    )
    ctx.out.data(path, () => path.url)
    return
  }
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
  visibility: string,
  opts: { yes?: boolean } = {}
): Promise<void> {
  if (visibility !== 'private' && visibility !== 'public') {
    throw new CliError(`Visibility must be "private" or "public", not "${visibility}"`)
  }
  const client = requireClient(ctx)
  const site = await confirmingPublicServer(ctx, name, opts.yes, confirmed =>
    setVisibility(client, name, visibility as Visibility, confirmed)
  )
  ctx.log.success(
    site.visibility === 'public'
      ? `${name} is public — no sign-in needed`
      : `${name} is private — sign-in required`
  )
  ctx.out.data(site, () => site.url)
}

/**
 * Make a change that may make public a site whose live version has a server: with `yes`, confirmed
 * up front; on a terminal, asked when the API answers 409 `public_server` (anyone could then call
 * its `/api/*` and use its secrets through it); else that refusal, with how to confirm.
 */
async function confirmingPublicServer<T>(
  ctx: CommandContext,
  name: string,
  yes: boolean | undefined,
  change: (confirmed: boolean) => Promise<T>
): Promise<T> {
  try {
    return await change(yes === true)
  } catch (error) {
    if (!(error instanceof CliApiError) || error.code !== 'public_server') throw error
    if (!ctx.interactive) {
      throw new CliError(error.message, { hint: 'Confirm with --yes.' })
    }
    ctx.log.warn(error.message)
    if (!(await ctx.confirm(`Make ${name} public, with its server callable by anyone?`))) {
      throw new CliError(`Nothing changed: ${name} keeps its access`)
    }
    return change(true)
  }
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
    /** making a site with a server public: confirmed up front */
    yes?: boolean
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
    yes?: boolean
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
  const client = requireClient(ctx)
  const site = await confirmingPublicServer(ctx, name, opts.yes, confirmed =>
    setAccess(client, name, level, undefined, confirmed)
  )
  const warnings = audienceWarnings(site)
  for (const w of warnings) ctx.log.warn(w)
  ctx.out.data({ ...site, warnings }, () => describeAudience(site, membersOf(ctx)))
}

/**
 * `fling owners|publishers <name> [--add …] [--remove …] [--set …] [--group …] [--remove-group …]`:
 * show a site's owners and publishers or, with options, change one list (the whole new list goes
 * to the server, which keeps at least one person owner and only takes members).
 */
export async function runRoles(
  ctx: CommandContext,
  which: RoleList,
  name: string,
  opts: {
    add?: string[]
    remove?: string[]
    set?: string[]
    group?: string[]
    removeGroup?: string[]
    path?: string
  }
): Promise<void> {
  if (opts.path !== undefined) return runPathRoles(ctx, which, name, pathFolder(opts.path), opts)
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'siteRoles')
  if (instance && !siteRolesEnabled(instance)) {
    throw new CliError(`${instance.name} has no site owners and publishers yet`, {
      hint: 'Ask its operator to update it.',
    })
  }
  const change = {
    ...(opts.set ? { set: splitEmails(opts.set) } : {}),
    add: splitEmails(opts.add ?? []),
    remove: splitEmails(opts.remove ?? []),
    addGroups: splitGroups(opts.group ?? []),
    removeGroups: splitGroups(opts.removeGroup ?? []),
  }
  if (instance && (change.addGroups.length || change.removeGroups.length)) {
    if (!groupsEnabled(instance)) throw new CliError(`${instance.name} has no groups`)
  }
  const client = requireClient(ctx)
  const changed = changesAudience(change)
  const site = changed ? await setRoles(client, name, which, change) : await getRoles(client, name)
  if (changed) ctx.log.success(`${name}'s ${which} changed`)
  ctx.out.data(
    { name: site.name, role: site.role, owners: site.owners, publishers: site.publishers },
    () => describeRoles(site)
  )
}

/**
 * `owners|publishers <name> --path <folder>`: a Path's owners and publishers, who may publish it,
 * roll it back and change it, besides the site's owners.
 */
async function runPathRoles(
  ctx: CommandContext,
  which: RoleList,
  name: string,
  folder: string,
  opts: {
    add?: string[]
    remove?: string[]
    set?: string[]
    group?: string[]
    removeGroup?: string[]
  }
): Promise<void> {
  const client = await pathsClient(ctx)
  const change = {
    ...(opts.set ? { set: splitEmails(opts.set) } : {}),
    add: splitEmails(opts.add ?? []),
    remove: splitEmails(opts.remove ?? []),
    addGroups: splitGroups(opts.group ?? []),
    removeGroups: splitGroups(opts.removeGroup ?? []),
  }
  const changed = changesAudience(change)
  const path = changed
    ? await setPathRoles(client, name, folder, which, change)
    : await getPathRoles(client, name, folder)
  if (changed) ctx.log.success(`The ${which} of /${folder}/ of ${name} changed`)
  ctx.out.data(
    { name, path: path.folder, owners: path.owners, publishers: path.publishers },
    () => `/${path.folder}/: ${describeRoles(path)}`
  )
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

/**
 * `fling keep <name> [--off]`: exempt the site from the archive policy, or stop exempting it. Its
 * owners only (an admin, from their browser session); a Fling without the policy is refused.
 */
export async function runKeep(
  ctx: CommandContext,
  name: string,
  opts: { off?: boolean }
): Promise<void> {
  const client = requireClient(ctx)
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'archivePolicy')
  requireArchivePolicy(instance)
  const keep = !opts.off
  const site = await setKeep(client, name, keep, { appOrigin: instance?.appOrigin })
  ctx.log.success(
    keep
      ? `${name} is kept: the archive policy never archives it for disuse (undo with \`fling keep ${name} --off\`)`
      : `${name} is no longer kept: it is archived like any site once nobody views or publishes it for a while`
  )
  if (ctx.json) ctx.out.data(site, () => '')
}

export async function runRemove(
  ctx: CommandContext,
  name: string,
  opts: { yes?: boolean }
): Promise<void> {
  const client = requireClient(ctx)
  const recoverable = recoverableDeletesOf(
    await loadFreshInstance(ctx.store, ctx.config, ctx.fetch)
  )
  if (!opts.yes) {
    if (!ctx.interactive) {
      throw new CliError(`Refusing to delete ${name} without confirmation`, {
        hint: 'Pass --yes to delete.',
      })
    }
    const ok = await ctx.confirm(deleteConfirmText(recoverable, name))
    if (!ok) throw new CliError('Cancelled')
  }
  const result = await deleteSite(client, name)
  ctx.log.success(deletedText(recoverable, name))
  if (ctx.json) ctx.out.data({ ...result, recoverable }, () => '')
}
