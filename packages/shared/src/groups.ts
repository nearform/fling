// Groups: a named, reusable list of people (a team) that a site's audience can name. Any member of
// the instance lists them, sees who is in one and uses it in an audience; only its owner, who made
// it, renames it, changes its members or deletes it. Clients name a group by its slug, unique on
// the instance. The contract, and the words the CLI and both MCP servers describe groups with.
// Browser-safe (zod only).

import { z } from 'zod'
import { type AudienceEmail, AudienceEmailSchema, audienceList, groupLabel } from './audience.ts'

/** The most members a group holds. */
export const GROUP_MEMBERS_MAX = 500
export const GROUP_SLUG_MAX = 50
export const GROUP_NAME_MAX = 100

const GROUP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** 1-50 lowercase letters, digits and single hyphens, like a site name (without the reserved list). */
export function isValidGroupSlug(slug: string): boolean {
  return slug.length <= GROUP_SLUG_MAX && GROUP_SLUG_RE.test(slug) && !slug.includes('--')
}

export const GROUP_SLUG_RULES = `1-${GROUP_SLUG_MAX} lowercase letters, digits and single hyphens`

export const GroupSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidGroupSlug, `A group's slug is ${GROUP_SLUG_RULES}`)

export const GroupNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX)

const memberEmails = z
  .array(z.string().trim().toLowerCase().min(3).max(254))
  .max(GROUP_MEMBERS_MAX, `A group holds at most ${GROUP_MEMBERS_MAX} people`)

/** A group as lists show it. `size`: how many members it has. */
export const GroupSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** the email of the user who made it, the only one who may change it */
  owner: z.string(),
  size: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type GroupSummary = z.infer<typeof GroupSummarySchema>

/**
 * GET /api/groups[?mine=1][&members=a@x,b@y]: every group on the instance (or the caller's own),
 * by slug. With `members`, only the groups whose members are exactly those addresses.
 */
export const GroupListSchema = z.object({ groups: z.array(GroupSummarySchema) })

/** GET /api/groups/:slug: the group with its members; `canManage` when the caller owns it. */
export const GroupDetailSchema = GroupSummarySchema.extend({
  members: z.array(AudienceEmailSchema),
  canManage: z.boolean(),
})
export type GroupDetail = z.infer<typeof GroupDetailSchema>

/**
 * POST /api/groups { slug, name, members? } → GroupDetailSchema (201). A slug in use is a 409
 * `group_taken`; a member the instance wouldn't let sign in is a 400 `email_not_allowed`.
 */
export const CreateGroupRequestSchema = z.object({
  slug: GroupSlugSchema,
  name: GroupNameSchema,
  members: memberEmails.optional(),
})
export type CreateGroupRequest = z.input<typeof CreateGroupRequestSchema>

/** PATCH /api/groups/:slug { name } → GroupDetailSchema. The owner only (else 403). */
export const UpdateGroupRequestSchema = z.object({ name: GroupNameSchema })

/**
 * POST /api/groups/:slug/members { add?, remove? } → GroupDetailSchema: adds, then removes. The
 * owner only (else 403); DELETE /api/groups/:slug (204) likewise, and takes the group out of every
 * audience that names it.
 */
export const GroupMembersRequestSchema = z.object({
  add: memberEmails.optional(),
  remove: memberEmails.optional(),
})
export type GroupMembersRequest = z.input<typeof GroupMembersRequestSchema>

/** `a, b` (or several such values) → the group slugs, normalised. */
export function splitGroups(values: string | readonly string[]): string[] {
  const all = typeof values === 'string' ? [values] : values
  return all
    .flatMap(v => v.split(/[\s,;]+/))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/** One line per group, for the CLI and both MCP servers. */
export function describeGroups(groups: readonly GroupSummary[], me?: string): string {
  if (groups.length === 0) return 'No groups yet.'
  return groups
    .map(g => `- ${groupLabel(g)}, owned by ${g.owner === me ? 'you' : g.owner}`)
    .join('\n')
}

/** A group and its members, for the CLI and both MCP servers. */
export function describeGroup(group: GroupDetail): string {
  const members: readonly AudienceEmail[] = group.members
  const who = group.canManage
    ? 'you (you can change it)'
    : `${group.owner} (only they can change it)`
  return [
    `${groupLabel(group)}, owned by ${who}.`,
    members.length ? `Members: ${audienceList(members)}.` : 'No members yet.',
  ].join('\n')
}
