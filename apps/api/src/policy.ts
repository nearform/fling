/**
 * Who may do what to a site: one pure function, `can(actor, action, site)`. Every route and MCP
 * tool that touches a site asks it (through `requireSite` in sites.ts); nothing else decides
 * access, and no key layout implies it. What is not about a site (the admins' actions, and what
 * an impersonating admin may not do to the user's account) is `canInstance`, at the end.
 *
 * Actors are resolved against the site into a set of roles (`rolesOf`), and may do what any of
 * them allows (one person can be an admin and a publisher, and then deploys and changes settings):
 * - `owner`: a signed-in member the site's owners name (`site.owners`), by email or through one of
 *   their groups. Owners are equal: whoever created the site (`site.email`) is an owner only while
 *   the owners name them.
 * - `publisher`: a signed-in member the site's publishers name (`site.publishers`), the same way.
 *   A guest is never an owner or a publisher, even through a group.
 * - `viewer`: a signed-in user in the site's audience (`site.audience`), by email or through one
 *   of their groups. The actor's `groups` are loaded (`actorOn` in sites.ts) only for a site
 *   whose owners or publishers name groups, or a restricted one whose audience does.
 * - `member`: any other signed-in user whose standing is `member` (auth/standing.ts: the email
 *   policy admits them, they are an admin, or they hold a member invitation).
 * - `guest`: any other signed-in user whose standing is `guest` (`guest` on the actor): someone
 *   from outside the email policy, invited to review what is shared with them. Standing is
 *   rechecked on every request, so whoever the API sees signed in is admitted now.
 * - `admin`, `admin-token`: an admin (ADMIN_EMAILS), through their browser session or through an
 *   API key or OAuth token (`admin` on the actor).
 * - `share`: whoever holds the site's current share link (`s--<token>`). A revoked or rotated
 *   token is `anonymous`.
 * - `anonymous`: nobody we know.
 * A user who holds none of owner, publisher, admin or viewer is a `member` or a `guest`.
 *
 * What a role may do depends on the site's access (`accessOf`): `public`, `private` (signed-in
 * members), or `restricted` (private and limited to its owners, publishers and viewers; with an
 * empty audience, its owners and publishers alone: the `only_me` access level). The audience is
 * kept while a site is public, and ignored.
 *
 * The edge enforces `site.view` on its own (it serves sites without calling the API), from the
 * visibility in the route table and, for a restricted site, a site pass the edge mints from the
 * API's say-so (`/auth/login` asks `can(…, 'site.view', …)` here): tests/policy.test.ts runs the
 * real site router against this table so the two cannot drift.
 *
 * Owners publish, roll back, and change everything about the site: its access and settings, its
 * owners and publishers, its share link; they archive and delete it. Publishers publish and roll
 * back, and read the site and its versions, but get no share link and change nothing else (a
 * deploy that would change the site's access or settings needs those actions too: publication.ts).
 *
 * Admins administer every site: with any credential they open, read and review any site,
 * restricted ones included; from their browser session they also change it as an owner would
 * (access, settings, owners and publishers, archive, roll back, share link, delete, anyone's
 * comment), so a key or token that leaked cannot. Nobody but an owner or a publisher deploys: a
 * version is never published in someone else's name. Whatever an admin may do only because they
 * are one is audited (`byAdminOnly`, used by
 * `resolveSite` and the site-pass handoff in sites.ts). Notifications ask policy with an actor
 * that carries no `admin`, so admins hear only about what they would without it.
 *
 * Groups (a named list of people an audience can name) are `canGroup`: any signed-in user lists
 * them, sees their members and uses them in an audience; only the group's owner, who made it,
 * changes or deletes it.
 */
import type { CommentAuthor } from '@fling/shared'
import type { GroupRecord, SiteRecord } from './store/types.ts'

/** How an admin is signed in: their browser session, or an API key or OAuth token. */
export type AdminVia = 'session' | 'token'

export type Actor =
  /** `groups`: the ids of the user's groups, when policy needs them (`actorOn` in sites.ts) */
  /** `guest`: their standing is `guest` (auth/standing.ts) */
  /** `admin`: they are an admin, and how they are signed in (never while impersonating) */
  | {
      kind: 'user'
      email: string
      groups?: readonly string[]
      guest?: true
      admin?: AdminVia
    }
  | { kind: 'share'; token: string }
  | { kind: 'anonymous' }

export type Role =
  | 'owner'
  | 'publisher'
  | 'admin'
  | 'admin-token'
  | 'viewer'
  | 'member'
  | 'guest'
  | 'share'
  | 'anonymous'

export const ROLES: readonly Role[] = [
  'owner',
  'publisher',
  'admin',
  'admin-token',
  'viewer',
  'member',
  'guest',
  'share',
  'anonymous',
]

/** What policy needs to know about a site. */
export type PolicySite = Pick<
  SiteRecord,
  'owners' | 'publishers' | 'visibility' | 'shareToken' | 'audience' | 'restricted'
>

/**
 * Who may see a site: anyone, signed-in members, or (restricted) its owners, publishers and
 * audience.
 */
export type Access = 'public' | 'private' | 'restricted'

export const ACCESSES: readonly Access[] = ['public', 'private', 'restricted']

type AccessFields = Pick<SiteRecord, 'visibility' | 'audience' | 'restricted'>

/**
 * Whether the site, while private, is limited to its owner and audience. A record from before
 * access levels has no `restricted`: it is, exactly when its audience names someone.
 */
export const restrictsToAudience = (site: Omit<AccessFields, 'visibility'>): boolean =>
  site.restricted ?? site.audience.emails.length + site.audience.groups.length > 0

/**
 * Private and restricted: only its owners and publishers and the people in its audience (if any)
 * see the site.
 */
export const isRestricted = (site: AccessFields): boolean =>
  site.visibility === 'private' && restrictsToAudience(site)

export const accessOf = (site: AccessFields): Access =>
  site.visibility === 'public' ? 'public' : isRestricted(site) ? 'restricted' : 'private'

/**
 * Every action on a site. API routes and MCP tools map onto them:
 *
 *   site.view        open the served site (edge; `/auth/login` refreshes the cookie for it, and
 *                    hands a restricted site's viewers a site pass)
 *   site.read        GET /api/sites/:name (its audience, owners and publishers included),
 *                    fling_info, fling_check_name "yours"
 *   version.list     the versions in GET /api/sites/:name and fling_info
 *   version.read     GET …/versions/:id/files, fling_files
 *   site.deploy      POST …/deploys, …/finalize, fling_publish, fling_upload_*; also what makes a
 *                    claimed name "yours" rather than "taken"
 *   site.rollback    POST …/current, fling_rollback
 *   site.settings    PATCH { spa }; a deploy that changes `spa`
 *   site.visibility  PATCH { visibility }, fling_set_visibility; with site.audience, PATCH
 *                    { access } and fling_set_access (a new site's `access` is its creator's); a
 *                    deploy that changes `visibility` or a never-live site's `access`
 *   site.audience    PATCH { audience }, fling_set_audience
 *   site.owners      PATCH { owners }
 *   site.publishers  PATCH { publishers }
 *   site.archive     POST …/archive, …/unarchive, fling_archive
 *   site.delete      DELETE /api/sites/:name, fling_delete
 *   site.thumbnail   PUT …/thumbnail: the home page's thumbnail, taken by the browser of an owner
 *                    or publisher who opens the site page (reading it is site.view)
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
 * takes part: owners, publishers and members (on a restricted site, only its owners, publishers
 * and viewers) read, write and resolve (resolving is reversible, and review threads are closed by
 * whoever addressed them), and delete what they wrote; only owners delete anyone's. Guests take part where they are viewers, and on public
 * sites; a private site that isn't restricted is the members', so a guest gets nothing there,
 * not even `site.view`.
 * Admins take part in every site's comments, and from their browser session delete anyone's.
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
  'site.owners',
  'site.publishers',
  'site.archive',
  'site.delete',
  'site.thumbnail',
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

const isAdmin = (role: Role) => role === 'admin' || role === 'admin-token'
/** An owner, or an admin with any credential: what only owners otherwise read. */
const ownerOrAdmin = (role: Role) => role === 'owner' || isAdmin(role)
/** An owner, a publisher, or an admin with any credential: reading the site and its versions. */
const onTheSite = (role: Role) => role === 'owner' || role === 'publisher' || isAdmin(role)
/** An owner, or an admin in their browser session: changing the site. */
const ownerOrAdminSession = (role: Role) => role === 'owner' || role === 'admin'
/**
 * Signed in and able to see the site: its owners and publishers, any admin and its viewers, on a
 * site that isn't restricted any member, and on a public one any guest.
 */
const signedIn = (role: Role, access: Access) =>
  role === 'owner' ||
  role === 'publisher' ||
  isAdmin(role) ||
  role === 'viewer' ||
  (role === 'member' && access !== 'restricted') ||
  (role === 'guest' && access === 'public')

const RULES: Record<Action, (role: Role, access: Access) => boolean> = {
  // Public: anyone. Private: any signed-in user, or anyone with the share link. Restricted: its
  // owners, publishers and viewers, or anyone with the share link.
  'site.view': (role, access) => access === 'public' || role === 'share' || signedIn(role, access),
  'site.read': onTheSite,
  'version.list': onTheSite,
  'version.read': onTheSite,
  'site.deploy': role => role === 'owner' || role === 'publisher',
  'site.rollback': role => role === 'publisher' || ownerOrAdminSession(role),
  'site.settings': ownerOrAdminSession,
  'site.visibility': ownerOrAdminSession,
  'site.audience': ownerOrAdminSession,
  'site.owners': ownerOrAdminSession,
  'site.publishers': ownerOrAdminSession,
  'site.archive': ownerOrAdminSession,
  'site.delete': ownerOrAdminSession,
  'site.thumbnail': role => role === 'publisher' || ownerOrAdminSession(role),
  'share.read': ownerOrAdmin,
  'share.create': ownerOrAdminSession,
  'share.revoke': ownerOrAdminSession,
  'comment.read': signedIn,
  'comment.create': signedIn,
  'comment.resolve': signedIn,
  'comment.delete': ownerOrAdminSession,
  'comment.delete.own': signedIn,
}

/** Whether a list of people and groups names the user, by address or through one of `groups`. */
const names = (
  list: { emails: readonly string[]; groups: readonly string[] },
  email: string,
  groups: readonly string[]
) => list.emails.includes(email) || list.groups.some(g => groups.includes(g))

/**
 * The actor's roles on this site, the strongest first: owner, publisher, admin (or admin-token),
 * viewer; a user who holds none of them is a member or a guest.
 */
export function rolesOf(actor: Actor, site: PolicySite): Role[] {
  switch (actor.kind) {
    case 'user': {
      const groups = actor.groups ?? []
      const roles: Role[] = []
      if (!actor.guest) {
        if (names(site.owners, actor.email, groups)) roles.push('owner')
        else if (names(site.publishers, actor.email, groups)) roles.push('publisher')
      }
      if (actor.admin) roles.push(actor.admin === 'session' ? 'admin' : 'admin-token')
      if (names(site.audience, actor.email, groups)) roles.push('viewer')
      if (roles.length === 0) roles.push(actor.guest ? 'guest' : 'member')
      return roles
    }
    case 'share':
      return [site.shareToken !== null && actor.token === site.shareToken ? 'share' : 'anonymous']
    case 'anonymous':
      return ['anonymous']
  }
}

/** The actor's strongest role on this site (`rolesOf`). */
export const roleOf = (actor: Actor, site: PolicySite): Role => rolesOf(actor, site)[0] as Role

export function can(actor: Actor, action: Action, site: PolicySite): boolean {
  const access = accessOf(site)
  return rolesOf(actor, site).some(role => RULES[action](role, access))
}

/**
 * The actions that change a site (or its comments): an admin does them to another user's site
 * only from their browser session, and `resolveSite` audits each one. The rest only read.
 */
export const SITE_CHANGES: ReadonlySet<Action> = new Set<Action>([
  'site.deploy',
  'site.rollback',
  'site.settings',
  'site.visibility',
  'site.audience',
  'site.owners',
  'site.publishers',
  'site.archive',
  'site.delete',
  'site.thumbnail',
  'share.create',
  'share.revoke',
  'comment.delete',
])

/**
 * True when the actor may do `action` to the site only because they are an admin: what is audited.
 */
export function byAdminOnly(actor: Actor, action: Action, site: PolicySite): boolean {
  if (actor.kind !== 'user' || !actor.admin) return false
  const { admin: _admin, ...plain } = actor
  return can(actor, action, site) && !can(plain, action, site)
}

/**
 * A signed-in user as an actor; a request's user carries `guest` when their standing is, and
 * `admin` when they are one.
 */
export const userActor = (user: {
  email: string
  guest?: true
  admin?: AdminVia
}): Extract<Actor, { kind: 'user' }> => ({
  kind: 'user',
  email: user.email,
  ...(user.guest ? { guest: true as const } : {}),
  ...(user.admin ? { admin: user.admin } : {}),
})

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
 * Making a group needs a signed-in user who isn't a guest (`account.group.create`; its maker
 * becomes the owner), and listing them `account.groups.read`. A guest may be a member of groups
 * but reads none: an audience naming one is all they see of it. There are no co-managers, and
 * admins get no rights over groups: they act on one only by impersonating its owner.
 */
export const GROUP_ACTIONS = ['group.read', 'group.manage', 'group.delete'] as const

export type GroupAction = (typeof GROUP_ACTIONS)[number]

/** What policy needs to know about a group. */
export type PolicyGroup = Pick<GroupRecord, 'owner'>

export function canGroup(actor: Actor, action: GroupAction, group: PolicyGroup): boolean {
  if (actor.kind !== 'user' || actor.guest) return false
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
  /** the effective user's standing is `guest` (auth/standing.ts; never an admin) */
  guest: boolean
}

/**
 * - `admin`: an admin in their own browser session.
 * - `admin-token`: an admin through an API key or OAuth token (the CLI, MCP, the smoke test).
 * - `impersonating`: an admin acting as another user (always a browser session). Acting as a
 *   guest, they are held to the guest's rules as well.
 * - `guest`: a user whose standing is `guest`.
 * - `user`: anyone else.
 */
export type PrincipalRole = 'admin' | 'admin-token' | 'impersonating' | 'guest' | 'user'

export const PRINCIPAL_ROLES: readonly PrincipalRole[] = [
  'admin',
  'admin-token',
  'impersonating',
  'guest',
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
 *   admin.settings.read      GET /api/admin/settings: the configuration, secrets by name only
 *   admin.impersonate        POST /api/admin/impersonate (then `impersonationRefusal` on the target)
 *   admin.impersonate.stop   POST /api/admin/impersonate/stop
 *   admin.invitations.read   GET /api/admin/invitations: the invitation directory
 *   admin.invitations.manage POST /api/admin/invitations (invite an address as a member) and
 *                            DELETE /api/admin/invitations/:email (revoke): browser session only,
 *                            an invitation lets someone in
 *   account.site.create      claim a new site name (a first deploy: publication.ts)
 *   account.group.create     POST /api/groups, fling_group_create
 *   account.groups.read      GET /api/groups[/:slug], fling_groups, fling_group_show
 *   account.invite           invite an outside address as a guest by naming it in an audience or
 *                            a group
 *   account.key.create       GET /auth/cli: mint an API key (`fling login`)
 *   account.oauth.approve    /oauth/authorize and /api/oauth/requests/…: approve (or deny) an app
 *   account.revoke           DELETE /api/keys/:id, /api/connections/:id
 *   account.notifications.change  PUT /api/me/notifications (and fling_notifications_set)
 *   account.notifications.sent    GET /api/me/notifications/sent: the mail sent to them
 *
 * Admins see every site's listing (`admin.sites.list`: its name, owner, dates, state and access
 * level), and administer the sites themselves through `can` (the `admin` and `admin-token`
 * roles, above). An impersonating admin is the user, with the user's rights. Impersonation is for seeing and
 * doing what the user sees and does with their sites, never for creating anything that outlives
 * it in their name: no API keys, no app approvals, no other impersonation; and not for undoing
 * what they set up either (revoking their keys or apps), nor changing what they hear about
 * (preferences are their consent), nor reading the mail sent to them (admins never read other
 * people's mail). Starting one needs the admin's browser session: a key or token that leaked must
 * not be able to become someone else. Nor may an impersonating admin invite anyone: an invitation
 * outlives the session.
 *
 * Guests review what is shared with them and nothing else: they create no sites or groups, list
 * no groups, invite no one, and hold no API keys or app connections (none that outlive what was
 * shared with them). They keep their own account's settings.
 */
export const INSTANCE_ACTIONS = [
  'admin.users.list',
  'admin.sites.list',
  'admin.audit.read',
  'admin.mail.read',
  'admin.mail.test',
  'admin.settings.read',
  'admin.impersonate',
  'admin.impersonate.stop',
  'admin.invitations.read',
  'admin.invitations.manage',
  'account.site.create',
  'account.group.create',
  'account.groups.read',
  'account.invite',
  'account.key.create',
  'account.oauth.approve',
  'account.revoke',
  'account.notifications.change',
  'account.notifications.sent',
] as const

export type InstanceAction = (typeof INSTANCE_ACTIONS)[number]

const isAdminRole = (role: PrincipalRole) => role === 'admin' || role === 'admin-token'
const notImpersonating = (role: PrincipalRole) => role !== 'impersonating'
const notGuest = (role: PrincipalRole) => role !== 'guest'
/** Their own, not a guest's: no impersonating, no guests. */
const ownMember = (role: PrincipalRole) => notImpersonating(role) && notGuest(role)

const INSTANCE_RULES: Record<InstanceAction, (role: PrincipalRole) => boolean> = {
  'admin.users.list': isAdminRole,
  'admin.sites.list': isAdminRole,
  'admin.audit.read': isAdminRole,
  'admin.mail.read': isAdminRole,
  // Sending is never automatic: a leaked key or token must not be able to send mail.
  'admin.mail.test': role => role === 'admin',
  'admin.settings.read': isAdminRole,
  'admin.impersonate': role => role === 'admin',
  'admin.impersonate.stop': role => role === 'impersonating',
  'admin.invitations.read': isAdminRole,
  'admin.invitations.manage': role => role === 'admin',
  'account.site.create': notGuest,
  'account.group.create': notGuest,
  'account.groups.read': notGuest,
  'account.invite': ownMember,
  'account.key.create': ownMember,
  'account.oauth.approve': ownMember,
  'account.revoke': notImpersonating,
  'account.notifications.change': notImpersonating,
  'account.notifications.sent': notImpersonating,
}

export function principalRole(p: Principal): PrincipalRole {
  if (p.impersonator !== undefined) return 'impersonating'
  if (p.admin) return p.via === 'session' ? 'admin' : 'admin-token'
  return p.guest ? 'guest' : 'user'
}

export function canInstance(p: Principal, action: InstanceAction): boolean {
  const rule = INSTANCE_RULES[action]
  const role = principalRole(p)
  // An admin acting as a guest may do only what both may.
  return rule(role) && (role !== 'impersonating' || !p.guest || rule('guest'))
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
