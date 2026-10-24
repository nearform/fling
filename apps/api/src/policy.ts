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
import type { Visibility } from '@fling/shared'
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
 *
 * Reserved for comments (Phase 7; not actions yet): comment.read, comment.create,
 * comment.resolve, comment.delete. Share-link viewers will be able to read and create.
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
] as const

export type Action = (typeof ACTIONS)[number]

const ownerOnly = (role: Role) => role === 'owner'

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
