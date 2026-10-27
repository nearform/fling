/**
 * Groups: named lists of people that a site's audience can name (the `groups` capability). Any
 * signed-in user makes one and becomes its owner; policy.ts (`canGroup`) decides the rest: every
 * member of the instance lists groups, sees their members and uses them in an audience, and only
 * the owner renames one, changes its members or deletes it.
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

/** GET /api/groups — every group on the instance, or (`mine`) the user's own; by slug. */
export async function listGroups(
  deps: Deps,
  user: User,
  opts: { mine?: boolean } = {}
): Promise<GroupSummary[]> {
  const groups = opts.mine
    ? await deps.store.listOwnedGroups(user.email)
    : await deps.store.listGroups()
  return groups.map(summaryOf)
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
  input: CreateGroupRequest
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
 * pass's lifetime at the edge.
 */
export async function changeMembers(
  deps: Deps,
  user: User,
  slug: string,
  input: GroupMembersRequest
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
