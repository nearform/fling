/**
 * Admin commands (an admin's credential; everyone else is refused with exit 3).
 *
 * - `fling admin deleted [name]` lists deleted sites and Paths, newest first: what, owner, who
 *   deleted it and when, the bytes kept and a site's Paths; then the link to Admin → Deleted, where
 *   an admin restores one, or deletes it for good, from their browser session (deleted.ts).
 */
import type { DeletedSite } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { deletedWhat, listDeleted, restoreLine } from '../deleted.ts'
import { loadInstance } from '../instance.ts'
import { formatBytes, formatDate, renderTable } from '../utils/output.ts'

export async function runAdminDeleted(
  ctx: CommandContext,
  name: string | undefined
): Promise<void> {
  const client = requireClient(ctx)
  const instance = await loadInstance(ctx.store, ctx.config, ctx.fetch)
  const deleted = await listDeleted(client, { name, instanceName: instance?.name })
  const appOrigin = instance?.appOrigin ?? ctx.config.serverUrl ?? client.serverUrl
  ctx.out.data({ deleted }, () =>
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
      '',
      restoreLine(appOrigin),
    ].join('\n')
  )
}
