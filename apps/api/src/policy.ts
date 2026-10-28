/**
 * Who may do what to a site: one pure function, `can(actor, action, site)`. Every route and MCP
 * tool that touches a site asks it (through `requireSite` in sites.ts); nothing else decides
 * access, and no key layout implies it. What is not about a site (the admins' actions, and what
 * an impersonating admin may not do to the user's account) is `canInstance`, at the end.
 *
 * Actors are resolved against the site into a role:
 * - `owner`: the signed-in user who holds the site (`site.email`).
 * - `viewer`: a signed-in user in the site's audience (`site.audience`), by email or through one
 *   of their groups (`groups` on the actor, which requireSite loads only for a restricted site).
 * - `member`: any other signed-in user. Signing in already applied the instance's email policy
 *   (`admit…` in auth/), so every user the API knows is admitted.
 * - `share`: whoever holds the site's current share link (`s--<token>`). A revoked or rotated
 *   token is `anonymous`.
 * - `anonymous`: nobody we know.
 *
 * What a role may do depends on the site's access (`accessOf`): `public`, `private` (signed-in
 * members), or `restricted` (private and limited to the owner and the viewers; with an empty
 * audience, the owner alone: the `only_me` access level). The audience is kept while a site is
 * public, and ignored.
 *
 * The edge enforces `site.view` on its own (it serves sites without calling the API), from the
 * visibility in the route table and, for a restricted site, a site pass the edge mints from the
 * API's say-so (`/auth/login` asks `can(…, 'site.view', …)` here): tests/policy.test.ts runs the
 * real site router against this table so the two cannot drift.
 *
 * Groups (a named list of people an audience can name) are `canGroup`: any signed-in user lists
 * them, sees their members and uses them in an audience; only the group's owner, who made it,
 * changes or deletes it.
 */
import type { CommentAuthor } from '@fling/shared'
import type { GroupRecord, SiteRecord } from './store/types.ts'

export type Actor =
  /** `groups`: the ids of the user's groups, when policy needs them (a restricted site) */
  | { kind: 'user'; email: string; groups?: readonly string[] }
  | { kind: 'share'; token: string }
  | { kind: 'anonymous' }

export type Role = 'owner' | 'viewer' | 'member' | 'share' | 'anonymous'

export const ROLES: readonly Role[] = ['owner', 'viewer', 'member', 'share', 'anonymous']

/** What policy needs to know about a site. */
export type PolicySite = Pick<
  SiteRecord,
  'email' | 'visibility' | 'shareToken' | 'audience' | 'restricted'
>

/** Who may see a site: anyone, signed-in members, or (restricted) the owner and its audience. */
export type Access = 'public' | 'private' | 'restricted'

export const ACCESSES: readonly Access[] = ['public', 'private', 'restricted']

type AccessFields = Pick<SiteRecord, 'visibility' | 'audience' | 'restricted'>

/**
 * Whether the site, while private, is limited to its owner and audience. A record from before
 * access levels has no `restricted`: it is, exactly when its audience names someone.
 */
export const restrictsToAudience = (site: Omit<AccessFields, 'visibility'>): boolean =>
  site.restricted ?? site.audience.emails.length + site.audience.groups.length > 0

/** Private and restricted: only the owner and the people in its audience (if any) see the site. */
export const isRestricted = (site: AccessFields): boolean =>
  site.visibility === 'private' && restrictsToAudience(site)

export const accessOf = (site: AccessFields): Access =>
  site.visibility === 'public' ? 'public' : isRestricted(site) ? 'restricted' : 'private'

/**
 * Every action on a site. API routes and MCP tools map onto them:
 *
 *   site.view        open the served site (edge; `/auth/login` refreshes the cookie for it, and
 *                    hands a restricted site's viewers a site pass)
 *   site.read        GET /api/sites/:name, fling_info, fling_check_name "yours"
 *   version.list     the versions in GET /api/sites/:name and fling_info
 *   version.read     GET …/versions/:id/files, fling_files
 *   site.deploy      POST …/deploys, …/finalize, fling_publish, fling_upload_*; also what makes a
 *                    claimed name "yours" rather than "taken"
 *   site.rollback    POST …/current, fling_rollback
 *   site.settings    PATCH { spa }
 *   site.visibility  PATCH { visibility }, fling_set_visibility; with site.audience, PATCH
 *                    { access } and fling_set_access (a new site's `access` is its creator's)
 *   site.audience    PATCH { audience }, fling_set_audience (and seeing the audience)
 *   site.archive     POST …/archive, …/unarchive, fling_archive
 *   site.delete      DELETE /api/sites/:name, fling_delete
 *   share.read       fling_share returning the existing link
 *   share.create     POST …/share (create or rotate), fling_share (refresh)
 *   share.revoke     DELETE …/share, fling_share (revoke)
 *   comment.read        GET …/comments, fling_comments_list (and the review page); POST …/live,
 *                       a ticket into the site's live room (live.ts)
 *   comment.create      POST …/comments, fling_comment_add (a thread or a reply)
 *   comment.resolve     PATCH …/comments/:id { resolved }, fling_comment_resolve (any thread)
 *   comment.delete      DELETE …/comments/:id, fling_comment_delete: anyone's comment
 *   comment.delete.own  the same, for a comment the actor wrote (`canDeleteComment`)
 *
 * Comments are the conversation around a site, so everyone who can see a site by signing in
 * takes part: members (on a restricted site, only its viewers) read, write and resolve (resolving
 * is reversible, and review threads are closed by whoever addressed them), and delete what they
 * wrote; only the owner deletes anyone's.
 * Share-link holders get nothing yet. Guest commenting (a name, kept in a signed per-site
 * cookie, as a `{ kind: 'guest' }` author) will turn on `comment.read` and `comment.create`
 * for `share`, and `comment.delete.own` once a guest can be recognised again.
 */
export const ACTIONS = [
  'site.view',
  'site.read',
  'version.list',
  'version.read',
  'site.deploy',
  'site.rollback',
  'site.settings',
  'site.visibility',
  'site.audience',
  'site.archive',
  'site.delete',
  'share.read',
  'share.create',
  'share.revoke',
  'comment.read',
  'comment.create',
  'comment.resolve',
  'comment.delete',
  'comment.delete.own',
] as const

export type Action = (typeof ACTIONS)[number]

const ownerOnly = (role: Role) => role === 'owner'
/**
 * Signed in and able to see the site: the owner and its viewers, and on a site that isn't
 * restricted any member.
 */
const signedIn = (role: Role, access: Access) =>
  role === 'owner' || role === 'viewer' || (role === 'member' && access !== 'restricted')

const RULES: Record<Action, (role: Role, access: Access) => boolean> = {
  // Public: anyone. Private: any signed-in user, or anyone with the share link. Restricted: the
  // owner, its viewers, or anyone with the share link.
  'site.view': (role, access) => access === 'public' || role === 'share' || signedIn(role, access),
  'site.read': ownerOnly,
  'version.list': ownerOnly,
  'version.read': ownerOnly,
  'site.deploy': ownerOnly,
  'site.rollback': ownerOnly,
  'site.settings': ownerOnly,
  'site.visibility': ownerOnly,
  'site.audience': ownerOnly,
  'site.archive': ownerOnly,
  'site.delete': ownerOnly,
  'share.read': ownerOnly,
  'share.create': ownerOnly,
  'share.revoke': ownerOnly,
  'comment.read': signedIn,
  'comment.create': signedIn,
  'comment.resolve': signedIn,
  'comment.delete': ownerOnly,
  'comment.delete.own': signedIn,
}

/** The actor's role on this site. */
export function roleOf(actor: Actor, site: PolicySite): Role {
  switch (actor.kind) {
    case 'user': {
      if (actor.email === site.email) return 'owner'
      const groups = actor.groups ?? []
      const inAudience =
        site.audience.emails.includes(actor.email) ||
        site.audience.groups.some(g => groups.includes(g))
      return inAudience ? 'viewer' : 'member'
    }
    case 'share':
      return site.shareToken !== null && actor.token === site.shareToken ? 'share' : 'anonymous'
    case 'anonymous':
      return 'anonymous'
  }
}

export function can(actor: Actor, action: Action, site: PolicySite): boolean {
  return RULES[action](roleOf(actor, site), accessOf(site))
}

/** A signed-in user as an actor. */
export const userActor = (user: { email: string }): Actor => ({ kind: 'user', email: user.email })

/** Whether the actor wrote a comment. Guests can't be recognised yet (no guest identity). */
export function isAuthor(actor: Actor, author: CommentAuthor): boolean {
  return actor.kind === 'user' && author.kind === 'user' && author.email === actor.email
}

/** May the actor delete this comment: anyone's (`comment.delete`), or their own. */
export function canDeleteComment(
  actor: Actor,
  site: PolicySite,
  comment: { author: CommentAuthor }
): boolean {
  return (
    can(actor, 'comment.delete', site) ||
    (isAuthor(actor, comment.author) && can(actor, 'comment.delete.own', site))
  )
}

// --- groups ---

/**
 * Every action on a group. Groups are not secret: every member of the instance may know them, so
 * a refusal is a 403, not a 404.
 *
 *   group.read    GET /api/groups[?members=…], GET /api/groups/:slug (members included),
 *                 fling_groups, fling_group_show; naming the group in a site's audience
 *   group.manage  PATCH /api/groups/:slug { name }, POST …/members, fling_group_rename,
 *                 fling_group_members
 *   group.delete  DELETE /api/groups/:slug, fling_group_delete
 *
 * Making a group needs only a signed-in user (its maker becomes the owner). There are no
 * co-managers, and admins get no rights over groups, as over sites: they act only by
 * impersonating.
 */
export const GROUP_ACTIONS = ['group.read', 'group.manage', 'group.delete'] as const

export type GroupAction = (typeof GROUP_ACTIONS)[number]

/** What policy needs to know about a group. */
export type PolicyGroup = Pick<GroupRecord, 'owner'>

export function canGroup(actor: Actor, action: GroupAction, group: PolicyGroup): boolean {
  if (actor.kind !== 'user') return false
  return action === 'group.read' || actor.email === group.owner
}

// --- the instance: admins, and what an impersonating admin may not do ---

/**
 * Who is asking, for actions that are about the instance or the caller's own account rather than
 * a site. `email` is the effective user: while an admin impersonates someone, it is that someone,
 * and `impersonator` is the admin.
 */
export interface Principal {
  email: string
  /** the effective user is in ADMIN_EMAILS (never true while impersonating: admins can't be) */
  admin: boolean
  /** how the request authenticated */
  via: 'session' | 'api_key' | 'oauth'
  /** the admin acting as `email` (a browser session only) */
  impersonator?: string
}

/**
 * - `admin`: an admin in their own browser session.
 * - `admin-token`: an admin through an API key or OAuth token (the CLI, MCP, the smoke test).
 * - `impersonating`: an admin acting as another user (always a browser session).
 * - `user`: anyone else.
 */
export type PrincipalRole = 'admin' | 'admin-token' | 'impersonating' | 'user'

export const PRINCIPAL_ROLES: readonly PrincipalRole[] = [
  'admin',
  'admin-token',
  'impersonating',
  'user',
]

/**
 * Actions on the instance and on the caller's own account:
 *
 *   admin.users.list         GET /api/admin/users (and site counts)
 *   admin.sites.list         GET /api/admin/sites: every site's listing (the site directory)
 *   admin.audit.read         GET /api/admin/audit
 *   admin.mail.read          GET /api/admin/mail: the mail settings and the sending health
 *   admin.mail.test          POST /api/admin/mail/test: send a test email (browser session only)
 *   admin.impersonate        POST /api/admin/impersonate (then `impersonationRefusal` on the target)
 *   admin.impersonate.stop   POST /api/admin/impersonate/stop
 *   account.key.create       GET /auth/cli: mint an API key (`fling login`)
 *   account.oauth.approve    /oauth/authorize and /api/oauth/requests/…: approve (or deny) an app
 *   account.revoke           DELETE /api/keys/:id, /api/connections/:id
 *   account.notifications.change  PUT /api/me/notifications (and fling_notifications_set)
 *   account.notifications.sent    GET /api/me/notifications/sent: the mail sent to them
 *
 * Admins have no extra rights over sites: they see every site's listing (`admin.sites.list`:
 * its name, owner, dates, state and access level) but no more. `can` never asks whether someone
 * is an admin, so an admin is a member of other people's sites like anyone else, and opens a
 * restricted one, or changes anyone's, only by impersonating. Impersonation is for seeing and
 * doing what the user sees and does with their sites, never for creating anything that outlives
 * it in their name: no API keys, no app approvals, no other impersonation; and not for undoing
 * what they set up either (revoking their keys or apps), nor changing what they hear about
 * (preferences are their consent), nor reading the mail sent to them (admins never read other
 * people's mail). Starting one needs the admin's browser session: a key or token that leaked must
 * not be able to become someone else.
 */
export const INSTANCE_ACTIONS = [
  'admin.users.list',
  'admin.sites.list',
  'admin.audit.read',
  'admin.mail.read',
  'admin.mail.test',
  'admin.impersonate',
  'admin.impersonate.stop',
  'account.key.create',
  'account.oauth.approve',
  'account.revoke',
  'account.notifications.change',
  'account.notifications.sent',
] as const

export type InstanceAction = (typeof INSTANCE_ACTIONS)[number]

const isAdminRole = (role: PrincipalRole) => role === 'admin' || role === 'admin-token'
const notImpersonating = (role: PrincipalRole) => role !== 'impersonating'

const INSTANCE_RULES: Record<InstanceAction, (role: PrincipalRole) => boolean> = {
  'admin.users.list': isAdminRole,
  'admin.sites.list': isAdminRole,
  'admin.audit.read': isAdminRole,
  'admin.mail.read': isAdminRole,
  // Sending is never automatic: a leaked key or token must not be able to send mail.
  'admin.mail.test': role => role === 'admin',
  'admin.impersonate': role => role === 'admin',
  'admin.impersonate.stop': role => role === 'impersonating',
  'account.key.create': notImpersonating,
  'account.oauth.approve': notImpersonating,
  'account.revoke': notImpersonating,
  'account.notifications.change': notImpersonating,
  'account.notifications.sent': notImpersonating,
}

export function principalRole(p: Principal): PrincipalRole {
  if (p.impersonator !== undefined) return 'impersonating'
  if (!p.admin) return 'user'
  return p.via === 'session' ? 'admin' : 'admin-token'
}

export function canInstance(p: Principal, action: InstanceAction): boolean {
  return INSTANCE_RULES[action](principalRole(p))
}

export type ImpersonationRefusal = 'no_such_user' | 'self' | 'admin'

/**
 * Whom an admin (`admin.impersonate`) may not become: someone who isn't a user, themselves, or
 * another admin (whose session would be an admin's again). null: allowed.
 */
export function impersonationRefusal(
  p: Principal,
  target: { email: string; admin: boolean } | null
): ImpersonationRefusal | null {
  if (!target) return 'no_such_user'
  if (target.email === p.email) return 'self'
  if (target.admin) return 'admin'
  return null
}
