/** Comments on a site: comments (list), comment (add or reply), resolve (or reopen), uncomment. */
import { authorLabel, type Comment, commentThreads, reviewUrl } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import {
  addComment,
  commentsEnabled,
  deleteComment,
  listComments,
  resolveComment,
} from '../sites.ts'
import { formatDate } from '../utils/output.ts'

/** The client, unless the stored instance says it has comments turned off. */
function commentsClient(ctx: CommandContext) {
  const instance = ctx.config.instance
  if (instance && !commentsEnabled(instance)) {
    throw new CliError(`${instance.name} has comments turned off`)
  }
  return requireClient(ctx)
}

const reviewPage = (ctx: CommandContext, name: string, path?: string) =>
  reviewUrl(ctx.config.instance?.appOrigin ?? ctx.config.serverUrl ?? '', name, path)

function describe(c: Comment, currentVersionId: string | null): string {
  const version =
    c.versionId === null
      ? ''
      : c.versionId === currentVersionId
        ? ''
        : chalk.dim(` (on version ${c.versionId})`)
  return `${chalk.bold(authorLabel(c.author))} ${chalk.dim(formatDate(c.createdAt))}${version}`
}

export async function runComments(
  ctx: CommandContext,
  name: string,
  opts: { path?: string; all?: boolean }
): Promise<void> {
  const list = await listComments(commentsClient(ctx), name, { path: opts.path })
  const all = commentThreads(list.comments)
  const threads = opts.all ? all : all.filter(t => t.comment.resolvedAt === null)
  const hidden = all.length - threads.length
  ctx.out.data({ ...list, reviewUrl: reviewPage(ctx, name) }, () => {
    const lines: string[] = []
    let lastPath: string | null = null
    for (const { comment: c, replies } of threads.sort((a, b) =>
      a.comment.path.localeCompare(b.comment.path)
    )) {
      if (c.path !== lastPath) {
        lines.push('', chalk.bold.underline(c.path))
        lastPath = c.path
      }
      const state = c.resolvedAt ? chalk.green(' ✓ resolved') : ''
      lines.push(`${chalk.dim(c.id)}${state}  ${describe(c, list.site.currentVersionId)}`)
      lines.push(...c.body.split('\n').map(l => `  ${l}`))
      for (const r of replies) {
        lines.push(`  ${chalk.dim('↳')} ${describe(r, list.site.currentVersionId)}`)
        lines.push(...r.body.split('\n').map(l => `    ${l}`))
      }
    }
    const summary = chalk.dim(
      `${threads.length} ${opts.all ? '' : 'open '}thread${threads.length === 1 ? '' : 's'}` +
        (hidden ? ` (${hidden} resolved — \`--all\` shows them)` : '') +
        ` · review: ${reviewPage(ctx, name)}`
    )
    return [...lines, '', summary].join('\n').replace(/^\n/, '')
  })
}

export async function runComment(
  ctx: CommandContext,
  name: string,
  text: string,
  opts: { path?: string; reply?: string }
): Promise<void> {
  if (!text.trim()) throw new CliError('The comment is empty')
  const comment = await addComment(commentsClient(ctx), name, {
    body: text,
    path: opts.path,
    parentId: opts.reply,
  })
  ctx.log.success(
    comment.parentId
      ? `Replied to ${comment.parentId} on ${name}`
      : `Comment added on ${name} ${comment.path}`
  )
  ctx.out.data(comment, () => reviewPage(ctx, name, comment.path))
}

export async function runResolve(
  ctx: CommandContext,
  name: string,
  id: string,
  opts: { reopen?: boolean }
): Promise<void> {
  const comment = await resolveComment(commentsClient(ctx), name, id, !opts.reopen)
  ctx.log.success(opts.reopen ? `Thread ${id} reopened` : `Thread ${id} resolved`)
  if (ctx.json) ctx.out.data(comment, () => '')
}

export async function runUncomment(
  ctx: CommandContext,
  name: string,
  id: string,
  opts: { yes?: boolean }
): Promise<void> {
  if (!opts.yes) {
    if (!ctx.interactive) {
      throw new CliError(`Refusing to delete comment ${id} without confirmation`, {
        hint: 'Pass --yes to delete.',
      })
    }
    const ok = await ctx.confirm(`Delete comment ${id} (and its replies)? This cannot be undone.`)
    if (!ok) throw new CliError('Cancelled')
  }
  const result = await deleteComment(commentsClient(ctx), name, id)
  ctx.log.success(`Comment ${id} deleted`)
  if (ctx.json) ctx.out.data(result, () => '')
}
