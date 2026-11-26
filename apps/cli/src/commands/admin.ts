/**
 * Admin commands (an admin's credential; everyone else is refused with exit 3).
 *
 * - `fling admin deleted [name]` lists deleted sites and Paths, a page at a time, newest first
 *   (`--oldest`, oldest first; `--all`, every page): what, owner, who
 *   deleted it and when, the bytes kept and a site's Paths; then the link to Admin → Deleted, where
 *   an admin restores one, or deletes it for good, from their browser session (deleted.ts).
 * - `fling admin archive-policy` shows the archive policy: its settings, live or dry run, why it is
 *   paused, what it would (or will) do in the next days and what it did lately; then the link to
 *   Admin → Archive policy, where an admin turns it live or back to dry run (archive-policy.ts).
 */
import {
  ARCHIVE_PREVIEW_DAYS,
  type ArchivePolicyAction,
  type ArchivePreviewPurge,
  type ArchivePreviewSite,
  archiveActionText,
  archivePolicySwitchLine,
  archiveWhen,
  type DeletedSite,
  describeArchivePolicySettings,
} from '@fling/shared'
import chalk from 'chalk'
import { getArchivePolicy } from '../archive-policy.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { deletedWhat, listDeleted, restoreLine } from '../deleted.ts'
import { loadInstance } from '../instance.ts'
import { formatBytes, formatDate, renderTable } from '../utils/output.ts'

export async function runAdminDeleted(
  ctx: CommandContext,
  name: string | undefined,
  opts: { oldest?: boolean; limit?: number; cursor?: string; all?: boolean } = {}
): Promise<void> {
  const client = requireClient(ctx)
  const instance = await loadInstance(ctx.store, ctx.config, ctx.fetch)
  const order = opts.oldest ? 'oldest' : 'newest'
  const { deleted, cursor } = await listDeleted(client, {
    name,
    order,
    limit: opts.limit,
    cursor: opts.cursor,
    all: opts.all,
    instanceName: instance?.name,
  })
  const appOrigin = instance?.appOrigin ?? ctx.config.serverUrl ?? client.serverUrl
  ctx.out.data({ deleted, cursor }, () =>
    [
      deleted.length
        ? renderTable<DeletedSite>(deleted, [
            { header: 'DELETED', value: deletedWhat },
            { header: 'ID', value: d => d.pathId ?? d.siteId },
            { header: 'OWNER', value: d => d.owner },
            { header: 'BY', value: d => d.deletedBy },
            { header: 'WHEN', value: d => formatDate(d.deletedAt) },
            { header: 'KEPT', value: d => formatBytes(d.bytes) },
            { header: 'PATHS', value: d => d.paths?.map(p => `${p.folder}/`).join(', ') },
          ])
        : chalk.dim(name ? `Nothing named ${name} was deleted.` : 'No deleted sites.'),
      ...(cursor
        ? [
            '',
            chalk.dim(
              `There are more: --all lists every one, --cursor ${cursor} the next ${deleted.length}.`
            ),
          ]
        : []),
      '',
      restoreLine(appOrigin),
    ].join('\n')
  )
}

const ACTION_DONE: Record<ArchivePolicyAction['action'], string> = {
  'site.archive': 'archived',
  'site.delete': 'deleted',
  'site.purge': 'deleted for good',
  'path.purge': 'deleted for good',
}

export async function runAdminArchivePolicy(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const instance = await loadInstance(ctx.store, ctx.config, ctx.fetch)
  const status = await getArchivePolicy(client, { instanceName: instance?.name })
  const appOrigin = instance?.appOrigin ?? ctx.config.serverUrl ?? client.serverUrl
  const { preview } = status
  const when = (at: string) => archiveWhen(at, preview.from, formatDate)
  const coming = () => {
    if (!preview.sites.length && !preview.purge.length) return [chalk.dim('Nothing.')]
    return [
      ...(preview.sites.length
        ? [
            renderTable<ArchivePreviewSite>(preview.sites, [
              { header: 'WHEN', value: p => when(p.at) },
              { header: 'DOES', value: p => archiveActionText(p.action) },
              { header: 'SITE', value: p => p.name },
              { header: 'OWNER', value: p => p.owner },
              { header: 'SINCE', value: p => formatDate(p.since) },
            ]),
          ]
        : []),
      ...(preview.purge.length
        ? [
            '',
            renderTable<ArchivePreviewPurge>(preview.purge, [
              { header: 'WHEN', value: p => when(p.at) },
              {
                header: 'DELETES FOR GOOD',
                value: p => (p.kind === 'path' ? `${p.folder}/ of ${p.name}` : p.name),
              },
              { header: 'DELETED', value: p => formatDate(p.deletedAt) },
            ]),
          ]
        : []),
      ...(preview.more ? [chalk.dim('And more: see Admin → Archive policy.')] : []),
    ]
  }
  ctx.out.data(status, () =>
    [
      chalk.bold(`The archive policy on ${instance?.name ?? 'this Fling'}`),
      ...describeArchivePolicySettings(status, formatDate),
      ...(status.on
        ? [
            '',
            chalk.bold(
              `What it ${status.live ? 'will do' : 'would do'} in the next ${ARCHIVE_PREVIEW_DAYS} days`
            ),
            ...coming(),
          ]
        : []),
      ...(status.recent.length
        ? [
            '',
            chalk.bold('What it did lately'),
            renderTable<ArchivePolicyAction>(status.recent, [
              { header: 'WHEN', value: a => formatDate(a.at) },
              {
                header: 'DID',
                value: a =>
                  a.action === 'site.delete' && a.change === 'hard'
                    ? 'deleted for good'
                    : ACTION_DONE[a.action],
              },
              { header: 'WHAT', value: a => a.target },
            ]),
          ]
        : []),
      '',
      archivePolicySwitchLine(appOrigin),
    ].join('\n')
  )
}
