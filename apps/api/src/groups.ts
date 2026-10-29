/**
 * Groups: named lists of people that a site's audience can name (the `groups` capability). Any
 * signed-in user but a guest makes one and becomes its owner (`account.group.create`, checked by
 * the routes and the MCP server); policy.ts (`canGroup`) decides the rest: every member of the
 * instance lists groups, sees their members and uses them in an audience, and only the owner
 * renames one, changes its members or deletes it. Guests may be members, and read none.
 *
 * Groups are not secret, so an unknown slug is a 404 and a refusal a 403. Members are addresses the
 * instance would let sign in (`checkEmails`, as for audiences), at most GROUP_MEMBERS_MAX. Clients
 * name a group by slug; audiences store its id, so deleting a group first takes it out of the
 * audiences that name it (`dropGroup` in sites.ts), except where it is the only entry: there it
 * stays, matching nobody, so the site stays restricted to its owner.
 */
import {
  type CreateGroupRequest,
  CreateGroupRequestSchema,
  GROUP_MEMBERS_MAX,
  type GroupDetail,
  type GroupMembersRequest,
  GroupMembersRequestSchema,
  type GroupSummary,
  isValidGroupSlug,
} from '@fling/shared'
import { badRequest, conflict, forbidden, notFound } from './lib/errors.ts'
import { newId } from './lib/ids.ts'
import { type Acting, notifyMembersAdded } from './notifications/notify.ts'
import { canGroup, type GroupAction, userActor } from './policy.ts'
import { checkEmails, dropGroup } from './sites.ts'
import type { GroupRecord, User } from './store/types.ts'
import type { Deps } from './types.ts'

const summaryOf = (g: GroupRecord): GroupSummary => ({
  slug: g.slug,
  name: g.name,
  owner: g.owner,
  size: g.size,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
})

const REFUSALS: Record<Exclude<GroupAction, 'group.read'>, string> = {
  'group.manage': 'Only its owner can change the group',
  'group.delete': 'Only its owner can delete the group',
}

/** The group with this slug, if the user may do `action` to it: else 404 (none) or 403. */
export async function requireGroup(
  deps: Deps,
  user: User,
  slug: string,
  action: GroupAction
): Promise<GroupRecord> {
  const group = isValidGroupSlug(slug) ? await deps.store.findGroup(slug) : null
  if (!group) throw notFound(`No group named "${slug}"`)
  if (!canGroup(userActor(user), action, group)) {
    throw forbidden(`${REFUSALS[action as keyof typeof REFUSALS]} (${group.owner})`)
  }
  return group
}

/**
 * GET /api/groups — every group on the instance, or (`mine`) the user's own; by slug. With
 * `members`, only the groups whose members are exactly those people (`groupsWithMembers`).
 */
export async function listGroups(
  deps: Deps,
  user: User,
  opts: { mine?: boolean; members?: readonly string[] } = {}
): Promise<GroupSummary[]> {
  const groups = opts.members
    ? (await groupsWithMembers(deps, opts.members)).filter(
        g => !opts.mine || g.owner === user.email
      )
    : opts.mine
      ? await deps.store.listOwnedGroups(user.email)
      : await deps.store.listGroups()
  return groups.filter(g => canGroup(userActor(user), 'group.read', g)).map(summaryOf)
}

/**
 * The groups whose members are exactly `emails`, by slug: the groups each address is in
 * (memberships, one query per address), intersected, then those whose `size` is the number of
 * addresses. No scan, so it answers "is there already a group of these people?" at any size.
 */
export async function groupsWithMembers(
  deps: Deps,
  emails: readonly string[]
): Promise<GroupRecord[]> {
  const wanted = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0 || wanted.length > GROUP_MEMBERS_MAX) return []
  let common = new Set(await deps.store.listMemberships(wanted[0] as string))
  for (const email of wanted.slice(1)) {
    if (common.size === 0) return []
    const before = common
    common = new Set((await deps.store.listMemberships(email)).filter(id => before.has(id)))
  }
  const groups = await deps.store.getGroups([...common])
  return groups.filter(g => g.size === wanted.length).sort((a, b) => a.slug.localeCompare(b.slug))
}

async function detailOf(deps: Deps, user: User, group: GroupRecord): Promise<GroupDetail> {
  const members = await deps.store.listGroupMembers(group.id)
  const known = await deps.store.knownEmails(members)
  return {
    ...summaryOf(group),
    members: members.map(email => ({ email, known: known.has(email) })),
    canManage: canGroup(userActor(user), 'group.manage', group),
  }
}

/** GET /api/groups/:slug — the group and its members, each with whether they have signed in. */
export async function groupDetail(deps: Deps, user: User, slug: string): Promise<GroupDetail> {
  return detailOf(deps, user, await requireGroup(deps, user, slug, 'group.read'))
}

const capped = (n: number) => {
  if (n > GROUP_MEMBERS_MAX) throw badRequest(`A group holds at most ${GROUP_MEMBERS_MAX} people`)
}

/** POST /api/groups — a new group, owned by the user. */
export async function createGroup(
  deps: Deps,
  user: User,
  input: CreateGroupRequest,
  acting: Acting = {}
): Promise<GroupDetail> {
  const { slug, name, members = [] } = CreateGroupRequestSchema.parse(input)
  const emails = [...new Set(members)]
  capped(emails.length)
  checkEmails(deps, emails)
  const now = deps.clock.now().toISOString()
  const group: GroupRecord = {
    id: newId(),
    slug,
    name,
    owner: user.email,
    size: emails.length,
    createdAt: now,
    updatedAt: now,
  }
  const created = await deps.store.createGroup(group, emails)
  if (!created) throw conflict(`There is already a group named "${slug}"`, 'group_taken')
  await notifyMembersAdded(deps, user.email, created, emails, acting)
  return detailOf(deps, user, created)
}

/** PATCH /api/groups/:slug { name } — the owner renames it (the slug stays). */
export async function renameGroup(
  deps: Deps,
  user: User,
  slug: string,
  name: string
): Promise<GroupDetail> {
  const group = await requireGroup(deps, user, slug, 'group.manage')
  group.name = name
  group.updatedAt = deps.clock.now().toISOString()
  await deps.store.putGroup(group)
  return detailOf(deps, user, group)
}

/**
 * POST /api/groups/:slug/members { add?, remove? } — the owner adds people, then takes people out.
 * Taking someone out shuts them out of the sites it opens at once for the API, and within a site
 * pass's lifetime at the edge. The people added hear of it (`group.member_added`); those taken
 * out don't.
 */
export async function changeMembers(
  deps: Deps,
  user: User,
  slug: string,
  input: GroupMembersRequest,
  acting: Acting = {}
): Promise<GroupDetail> {
  const change = GroupMembersRequestSchema.parse(input)
  const group = await requireGroup(deps, user, slug, 'group.manage')
  const removing = new Set(change.remove ?? [])
  const adding = [...new Set(change.add ?? [])].filter(e => !removing.has(e))
  checkEmails(deps, adding)
  const current = new Set(await deps.store.listGroupMembers(group.id))
  const add = adding.filter(e => !current.has(e))
  const remove = [...removing].filter(e => current.has(e))
  const size = current.size + add.length - remove.length
  capped(size)
  group.size = size
  group.updatedAt = deps.clock.now().toISOString()
  await deps.store.putGroup(group, { add, remove })
  await notifyMembersAdded(deps, user.email, group, add, acting)
  return detailOf(deps, user, group)
}

/**
 * DELETE /api/groups/:slug — the owner deletes it, first taking it out of the audiences that name
 * others too. Anyone it let in loses access; no site opens up.
 */
export async function deleteGroup(deps: Deps, user: User, slug: string): Promise<void> {
  const group = await requireGroup(deps, user, slug, 'group.delete')
  await dropGroup(deps, group.id)
  await deps.store.deleteGroup(group)
}
