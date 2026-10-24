/**
 * Who may do what to a site: one pure function, `can(actor, action, site)`. Every route and MCP
 * tool that touches a site asks it (through `requireSite` in sites.ts); nothing else decides
 * access, and no key layout implies it.
 *
 * Actors are resolved against the site into a role:
 * - `owner`: the signed-in user who holds the site (`site.email`).
 * - `member`: any other signed-in user. Signing in already applied the instance's email policy
 *   (`admit…` in auth/), so every user the API knows is admitted.
 * - `share`: whoever holds the site's current share link (`s--<token>`). A revoked or rotated
 *   token is `anonymous`.
 * - `anonymous`: nobody we know.
 * - (`collaborator`, later: a user the owner invited; between owner and member.)
 *
 * The edge enforces `site.view` on its own (it serves sites without calling the API), from the
 * visibility in the route table: tests/policy.test.ts runs the real site router against this table
 * so the two cannot drift.
 */
import type { CommentAuthor, Visibility } from '@fling/shared'
import type { SiteRecord } from './store/types.ts'

export type Actor =
  | { kind: 'user'; email: string }
  | { kind: 'share'; token: string }
  | { kind: 'anonymous' }

export type Role = 'owner' | 'member' | 'share' | 'anonymous'

export const ROLES: readonly Role[] = ['owner', 'member', 'share', 'anonymous']

/** What policy needs to know about a site. */
export type PolicySite = Pick<SiteRecord, 'email' | 'visibility' | 'shareToken'>

/**
 * Every action on a site. API routes and MCP tools map onto them:
 *
 *   site.view        open the served site (edge; `/auth/login` refreshes the cookie for it)
 *   site.read        GET /api/sites/:name, fling_info, fling_check_name "yours"
 *   version.list     the versions in GET /api/sites/:name and fling_info
 *   version.read     GET …/versions/:id/files, fling_files
 *   site.deploy      POST …/deploys, …/finalize, fling_publish, fling_upload_*; also what makes a
 *                    claimed name "yours" rather than "taken"
 *   site.rollback    POST …/current, fling_rollback
 *   site.settings    PATCH { spa }
 *   site.visibility  PATCH { visibility }, fling_set_visibility
 *   site.archive     POST …/archive, …/unarchive, fling_archive
 *   site.delete      DELETE /api/sites/:name, fling_delete
 *   share.read       fling_share returning the existing link
 *   share.create     POST …/share (create or rotate), fling_share (refresh)
 *   share.revoke     DELETE …/share, fling_share (revoke)
 *   comment.read        GET …/comments, fling_comments_list (and the review page)
 *   comment.create      POST …/comments, fling_comment_add (a thread or a reply)
 *   comment.resolve     PATCH …/comments/:id { resolved }, fling_comment_resolve (any thread)
 *   comment.delete      DELETE …/comments/:id, fling_comment_delete: anyone's comment
 *   comment.delete.own  the same, for a comment the actor wrote (`canDeleteComment`)
 *
 * Comments are the conversation around a site, so everyone who can see a site by signing in
 * takes part: members read, write and resolve (resolving is reversible, and review threads are
 * closed by whoever addressed them), and delete what they wrote; only the owner deletes anyone's.
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
/** Signed in: the owner or any member (both can view the site, whatever its visibility). */
const signedIn = (role: Role) => role === 'owner' || role === 'member'

const RULES: Record<Action, (role: Role, visibility: Visibility) => boolean> = {
  // Public: anyone. Private: any signed-in user, or anyone with the share link.
  'site.view': (role, visibility) => visibility === 'public' || role !== 'anonymous',
  'site.read': ownerOnly,
  'version.list': ownerOnly,
  'version.read': ownerOnly,
  'site.deploy': ownerOnly,
  'site.rollback': ownerOnly,
  'site.settings': ownerOnly,
  'site.visibility': ownerOnly,
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
    case 'user':
      return actor.email === site.email ? 'owner' : 'member'
    case 'share':
      return site.shareToken !== null && actor.token === site.shareToken ? 'share' : 'anonymous'
    case 'anonymous':
      return 'anonymous'
  }
}

export function can(actor: Actor, action: Action, site: PolicySite): boolean {
  return RULES[action](roleOf(actor, site), site.visibility)
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
