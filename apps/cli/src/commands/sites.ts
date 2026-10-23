/** Site management: ls, info, versions, rollback, share, visibility, archive/unarchive, rm. */
import type { Site, Visibility } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import {
  archiveSite,
  deleteSite,
  getSite,
  listSites,
  rollback,
  setVisibility,
  share,
} from '../sites.ts'
import { formatBytes, formatDate, renderTable } from '../utils/output.ts'

export async function runList(ctx: CommandContext, opts: { archived?: boolean }): Promise<void> {
  const sites = await listSites(requireClient(ctx), opts)
  ctx.out.data({ sites }, () =>
    renderTable(sites, [
      { header: 'NAME', value: s => s.name },
      { header: 'URL', value: s => s.url },
      {
        header: 'VISIBILITY',
        value: s => (s.archived ? `${s.visibility} (archived)` : s.visibility),
      },
      { header: 'SHARE', value: s => s.shareUrl },
      { header: 'UPDATED', value: s => formatDate(s.updatedAt) },
    ])
  )
}

function describeSite(site: Site): string[] {
  const row = (label: string, value: string) => `${chalk.bold(`${label}:`.padEnd(12))}${value}`
  return [
    row('Name', site.name),
    row('URL', site.url),
    row('Visibility', site.visibility + (site.archived ? chalk.yellow(' (archived)') : '')),
    row('SPA', site.spa ? 'yes' : 'no'),
    row('Share link', site.shareUrl ?? '-'),
    row('Version', site.currentVersionId ?? '-'),
    row('Created', formatDate(site.createdAt)),
    row('Updated', formatDate(site.updatedAt)),
  ]
}

export async function runInfo(ctx: CommandContext, name: string): Promise<void> {
  const site = await getSite(requireClient(ctx), name)
  ctx.out.data(site, () =>
    [
      ...describeSite(site),
      '',
      chalk.dim(`${site.versions.length} version(s) — \`fling versions ${name}\``),
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
        { header: 'CREATED', value: v => formatDate(v.createdAt) },
      ])
  )
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
  const result = await share(requireClient(ctx), name, opts)
  if (result.action === 'revoked') ctx.log.success(`Share link for ${name} revoked`)
  else if (result.action === 'refreshed')
    ctx.log.success('New share link — the old one no longer works')
  else if (result.action === 'created')
    ctx.log.success('Share link created — anyone with it can view the site')
  ctx.out.data(result, () => result.shareUrl ?? chalk.dim('(no share link)'))
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
      : `${name} is private — Nearform sign-in required`
  )
  ctx.out.data(site, () => site.url)
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
