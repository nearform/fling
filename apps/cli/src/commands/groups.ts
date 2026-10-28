/**
 * `fling groups …`: named lists of people that any member can use in a site's audience
 * (`fling access <site> --group <slug>`). Anyone lists and shows them; only a group's owner adds
 * or removes people, renames it or deletes it (the server refuses anyone else).
 */
import { describeGroup, describeGroups, splitEmails } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import {
  changeGroupMembers,
  createGroup,
  deleteGroup,
  getGroup,
  groupsEnabled,
  listGroups,
  renameGroup,
  whoami,
} from '../sites.ts'
import { renderTable } from '../utils/output.ts'

function requireGroups(ctx: CommandContext) {
  const instance = ctx.config.instance
  if (instance && !groupsEnabled(instance)) throw new CliError(`${instance.name} has no groups`)
  return requireClient(ctx)
}

/** `--members a,b`: only the groups of exactly those people (none: say so, not "no groups yet"). */
export async function runGroups(
  ctx: CommandContext,
  opts: { mine?: boolean; members?: string[] }
): Promise<void> {
  const client = requireGroups(ctx)
  const members = opts.members ? splitEmails(opts.members) : undefined
  if (members && members.length === 0) throw new CliError('Name at least one address')
  const [groups, me] = await Promise.all([
    listGroups(client, { mine: opts.mine, members }),
    whoami(client),
  ])
  ctx.out.data({ groups }, () =>
    groups.length
      ? renderTable(groups, [
          { header: 'SLUG', value: g => g.slug },
          { header: 'NAME', value: g => g.name },
          { header: 'PEOPLE', value: g => g.size },
          { header: 'OWNER', value: g => (g.owner === me.email ? 'you' : g.owner) },
        ])
      : chalk.dim(members ? 'No group has exactly those people.' : describeGroups([]))
  )
}

export async function runGroupShow(ctx: CommandContext, slug: string): Promise<void> {
  const group = await getGroup(requireGroups(ctx), slug)
  ctx.out.data(group, () => describeGroup(group))
}

export async function runGroupCreate(
  ctx: CommandContext,
  slug: string,
  opts: { name?: string; add?: string[] }
): Promise<void> {
  const group = await createGroup(requireGroups(ctx), {
    slug,
    name: opts.name ?? slug,
    members: splitEmails(opts.add ?? []),
  })
  ctx.log.success(`Group ${group.slug} created`)
  ctx.out.data(group, () => describeGroup(group))
}

export async function runGroupMembers(
  ctx: CommandContext,
  slug: string,
  emails: string[],
  how: 'add' | 'remove'
): Promise<void> {
  const list = splitEmails(emails)
  if (list.length === 0) throw new CliError('Name at least one address')
  const group = await changeGroupMembers(requireGroups(ctx), slug, { [how]: list })
  ctx.out.data(group, () => describeGroup(group))
}

export async function runGroupRename(ctx: CommandContext, slug: string, name: string) {
  const group = await renameGroup(requireGroups(ctx), slug, name)
  ctx.log.success(`Group ${group.slug} is now called ${group.name}`)
  ctx.out.data(group, () => describeGroup(group))
}

export async function runGroupDelete(
  ctx: CommandContext,
  slug: string,
  opts: { yes?: boolean }
): Promise<void> {
  const client = requireGroups(ctx)
  if (!opts.yes) {
    if (!ctx.interactive) {
      throw new CliError(`Refusing to delete group ${slug} without confirmation`, {
        hint: 'Pass --yes to delete.',
      })
    }
    const ok = await ctx.confirm(
      `Delete group ${slug}? Sites whose audience names it keep their restriction, and anyone it let in loses access. This cannot be undone.`
    )
    if (!ok) throw new CliError('Cancelled')
  }
  const result = await deleteGroup(client, slug)
  ctx.log.success(`Group ${slug} deleted`)
  if (ctx.json) ctx.out.data(result, () => '')
}
