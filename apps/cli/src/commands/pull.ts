/**
 * `fling pull <name> [dir] [--version-id <id>] [--path <folder>] [--force]`: download a site's files
 * into `dir` (default `./<name>`) to change them and deploy again (pull.ts; the `pull`
 * capability). Anyone who can open the site may pull its current version; another version needs
 * an owner, publisher or admin. `--path` pulls one folder of the site, its files at the top of
 * `dir`. A folder that isn't empty needs `--force`.
 *
 * `fling deploy` in the folder then publishes on the version pulled (commands/deploy.ts).
 */
import { relative, resolve } from 'node:path'
import { normalizePublishPath } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadInstanceWith } from '../instance.ts'
import { pullSite } from '../pull.ts'
import { pullEnabled } from '../sites.ts'
import { formatBytes } from '../utils/output.ts'

export interface PullCommandOptions {
  versionId?: string
  path?: string
  force?: boolean
}

export async function runPull(
  ctx: CommandContext,
  name: string,
  dir: string | undefined,
  opts: PullCommandOptions
): Promise<void> {
  const client = requireClient(ctx)
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'pull')
  if (instance && !pullEnabled(instance)) {
    throw new CliError(`${instance.name} can't pull sites yet`, {
      hint: 'Ask its operator to update it.',
    })
  }
  let path: string | undefined
  if (opts.path !== undefined) {
    const folder = normalizePublishPath(opts.path)
    if (folder === null) {
      throw new CliError(`Invalid --path "${opts.path}"`, {
        hint: 'Use a folder of the site, like 30-10-26 or reports/2026 (no dotfiles).',
      })
    }
    path = folder
  }
  const target = resolve(dir ?? name)
  let progressShown = false
  const pulled = await pullSite(
    { client, fetch: ctx.fetch },
    {
      name,
      dir: target,
      ...(opts.versionId ? { versionId: opts.versionId } : {}),
      ...(path === undefined ? {} : { path }),
      force: opts.force,
      onProgress: p => {
        if (p.total === 0) return
        progressShown = true
        ctx.progress(
          `downloading ${p.done}/${p.total} files · ${formatBytes(p.bytes)}/${formatBytes(p.totalBytes)}`
        )
      },
    }
  ).finally(() => {
    if (progressShown) ctx.progress(null)
  })
  const shown = relative(process.cwd(), pulled.dir) || '.'
  ctx.log.success(
    `Pulled ${name}${path ? ` /${path}/` : ''} into ${shown} ${chalk.dim(`(${pulled.fileCount} files, ${formatBytes(pulled.totalBytes)}, version ${pulled.versionId})`)}`
  )
  ctx.out.data(pulled, () =>
    chalk.dim(
      `Change what you need, then \`${ctx.binName} deploy ${shown}\`: it publishes on version ${pulled.versionId}, and stops if someone publishes ${name} before you do.`
    )
  )
}
