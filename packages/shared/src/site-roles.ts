// A site's roles: its owners and its publishers, each people (addresses) and groups, shaped like
// its audience (audience.ts). Owners are equal: they publish, roll back, change its access and
// settings, its owners and publishers, archive and delete it. Publishers publish and roll back,
// and read the site and its versions, nothing more. A site always keeps at least one person as an
// owner (400 `last_owner`), and only members hold a role (400 `email_not_allowed` for anyone else;
// a guest never holds one, even through a group). Someone in both lists is an owner. The contract,
// the edits every client makes and the words the CLI and both MCP servers describe them with.
// Browser-safe (zod only).

import { z } from 'zod'
import {
  type AudienceChange,
  AudienceEmailSchema,
  AudienceGroupSchema,
  editAudienceInput,
  groupLabel,
} from './audience.ts'

/** The most addresses a site's owners hold. */
export const OWNER_EMAILS_MAX = 20
/** The most groups a site's owners name. */
export const OWNER_GROUPS_MAX = 5
/** The most addresses a site's publishers hold. */
export const PUBLISHER_EMAILS_MAX = 50
/** The most groups a site's publishers name. */
export const PUBLISHER_GROUPS_MAX = 10

/**
 * The caller's role on a site: an owner, a publisher, or an admin administering it (`admin`: none
 * of the others, but an admin of the instance).
 */
export const SiteRoleSchema = z.enum(['owner', 'publisher', 'admin'])
export type SiteRole = z.infer<typeof SiteRoleSchema>

/** A site's owners or publishers as the API reports them (like an audience: groups by slug). */
export const SiteRoleMembersSchema = z.object({
  emails: z.array(AudienceEmailSchema),
  groups: z.array(AudienceGroupSchema).default([]),
})
export type SiteRoleMembers = z.infer<typeof SiteRoleMembersSchema>

const roleInput = (what: string, emailsMax: number, groupsMax: number) =>
  z.object({
    emails: z
      .array(z.string().trim().toLowerCase().min(3).max(254))
      .max(emailsMax, `A site has at most ${emailsMax} ${what} addresses`),
    groups: z
      .array(z.string().trim().toLowerCase().min(1).max(100))
      .max(groupsMax, `A site names at most ${groupsMax} ${what} groups`)
      .default([]),
  })

/**
 * PATCH /api/sites/:name { owners }: the whole new list. Each address must be a member of the
 * instance, each group (by slug) must exist, and at least one address must stay.
 */
export const OwnersInputSchema = roleInput('owner', OWNER_EMAILS_MAX, OWNER_GROUPS_MAX)
/** PATCH /api/sites/:name { publishers }: the whole new list, checked like the owners. */
export const PublishersInputSchema = roleInput(
  'publisher',
  PUBLISHER_EMAILS_MAX,
  PUBLISHER_GROUPS_MAX
)
export type SiteRoleInput = z.input<typeof OwnersInputSchema>

/** The whole new owners or publishers after `change`, as PATCH takes them (groups by slug). */
export const editRoleInput = (current: SiteRoleMembers, change: AudienceChange) =>
  editAudienceInput(current, change)

/** `a@x.test, the group design (Design team, 4 people)`, or `nobody`. */
function whoHolds(members: SiteRoleMembers | undefined): string {
  const parts = [
    ...(members?.emails ?? []).map(e => (e.guest ? `${e.email} (guest)` : e.email)),
    ...(members?.groups ?? []).map(g => `the group ${groupLabel(g)}`),
  ]
  return parts.length ? parts.join(', ') : 'nobody'
}

/**
 * Who owns and who publishes the site, and the caller's role, for the CLI and both MCP servers.
 * Servers before site roles omit them: nothing to say.
 */
export function describeRoles(site: {
  role?: SiteRole
  owners?: SiteRoleMembers
  publishers?: SiteRoleMembers
}): string {
  if (!site.owners) return ''
  const you = site.role ? ` You are ${site.role === 'admin' ? 'an admin' : `a ${site.role}`}.` : ''
  return `Owners: ${whoHolds(site.owners)}. Publishers: ${whoHolds(site.publishers)}.${you}`
}
