// A site's access level: who can open it, as one choice of five, from narrowest to widest. The
// contract every client shares (the API's `access`, `fling deploy --access`, `fling access`, both
// servers' `access` and `fling_set_access`, the web's Access section): the names, labels and
// descriptions, how a level maps onto the stored visibility, restriction and audience, and the
// words the CLI and both MCP servers use. Browser-safe (zod only).
//
//   only_me  private and restricted, with an empty audience: the owner alone
//   members  private, not restricted: every signed-in member of the instance
//   groups   private and restricted to an audience naming groups (and perhaps people)
//   people   private and restricted to an audience naming people (and perhaps groups)
//   public   anyone; the private settings (restriction and audience) are kept for when it is
//            private again
//
// `groups` and `people` are one stored state, an audience, which may hold both: the level of a
// site with an audience is `people` when it names any address, else `groups`. The web offers them
// as one option, "Specific people and teams".

import { z } from 'zod'
import type { AudienceInput } from './audience.ts'

export const ACCESS_LEVELS = ['only_me', 'members', 'groups', 'people', 'public'] as const
export const AccessLevelSchema = z.enum(ACCESS_LEVELS)
export type AccessLevel = z.infer<typeof AccessLevelSchema>

/** The levels an instance may give new sites (`SITE_DEFAULT_ACCESS`); `only_me` unless it says. */
export const DEFAULT_ACCESS_LEVELS = ['only_me', 'members'] as const
export const DefaultAccessLevelSchema = z.enum(DEFAULT_ACCESS_LEVELS)
export type DefaultAccessLevel = z.infer<typeof DefaultAccessLevelSchema>

/** What a server that does not publish its default gives new sites: every member sees them. */
export const LEGACY_DEFAULT_ACCESS: DefaultAccessLevel = 'members'

/** The levels that need an audience naming someone. */
export const needsAudience = (level: AccessLevel) => level === 'groups' || level === 'people'

/** A level's short label, for menus and tables. */
export const ACCESS_LABELS: Record<AccessLevel, string> = {
  only_me: 'Only you',
  members: 'Everyone signed in',
  groups: 'Teams',
  people: 'Specific people',
  public: 'Public',
}

/**
 * A level's one-line description. `members`: who a private site is open to on this instance
 * (`privateAudience` in instance.ts, e.g. "anyone signed in to Fling (@example.test accounts)").
 */
export function accessDescription(level: AccessLevel, members: string): string {
  switch (level) {
    case 'only_me':
      return 'Only you can open it.'
    case 'members':
      return `${capitalise(members)} can open it.`
    case 'groups':
      return 'Only you and the members of the groups you name can open it.'
    case 'people':
      return 'Only you and the people you name can open it.'
    case 'public':
      return 'Anyone with the address can open it, without signing in; its review page and comments still need sign-in.'
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** What a site says about its access (`Site` in api.ts). */
export interface SiteAccessFields {
  /** set by servers that know access levels */
  access?: AccessLevel
  visibility: 'public' | 'private'
  restricted?: boolean
  audienceSize?: number
  audienceGroups?: number
}

/**
 * The level of a private site from what is stored: not restricted → `members`; restricted with an
 * empty audience → `only_me`; else `people` when the audience names an address, `groups` when it
 * names only groups.
 */
export function accessLevelOf(site: {
  visibility: 'public' | 'private'
  restricted: boolean
  emails: number
  groups: number
}): AccessLevel {
  if (site.visibility === 'public') return 'public'
  if (!site.restricted) return 'members'
  if (site.emails > 0) return 'people'
  return site.groups > 0 ? 'groups' : 'only_me'
}

/** A site's level as the API reports it (servers before access levels: derived from the rest). */
export const siteAccessLevel = (site: SiteAccessFields): AccessLevel =>
  site.access ??
  accessLevelOf({
    visibility: site.visibility,
    restricted: site.restricted ?? false,
    emails: (site.audienceSize ?? 0) - (site.audienceGroups ?? 0),
    groups: site.audienceGroups ?? 0,
  })

/**
 * Why `audience` can't go with `level` (a 400's message), or null. `groups` and `people` need an
 * audience naming someone; the other levels take none (`only_me` and `members` empty it, `public`
 * keeps it).
 */
export function accessProblem(level: AccessLevel, audience?: AudienceInput): string | null {
  const size = (audience?.emails.length ?? 0) + (audience?.groups?.length ?? 0)
  if (needsAudience(level)) {
    return size > 0 ? null : `Access "${level}" needs at least one address or group in \`audience\``
  }
  return audience === undefined ? null : `Access "${level}" takes no \`audience\``
}

/** `only_me`, `only-me`, `Only me`, `me` → the level, or null. What the CLI and MCP accept. */
export function parseAccessLevel(value: string): AccessLevel | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  const aliases: Record<string, AccessLevel> = {
    me: 'only_me',
    only_you: 'only_me',
    owner: 'only_me',
    private: 'members',
    member: 'members',
    everyone: 'members',
    group: 'groups',
    teams: 'groups',
    team: 'groups',
    person: 'people',
    emails: 'people',
  }
  return (ACCESS_LEVELS as readonly string[]).includes(v)
    ? (v as AccessLevel)
    : (aliases[v] ?? null)
}

/**
 * How to change who can see a site, for the CLI (`fling access …`) and both MCP servers
 * (`fling_set_access`). `invites`: the instance invites people from outside by sharing (the
 * `invites` capability), which the hint mentions.
 */
export function accessChangeHint(
  client: 'cli' | 'mcp',
  name: string,
  opts: { bin?: string; invites?: boolean } = {}
): string {
  const bin = opts.bin ?? 'fling'
  const how =
    client === 'cli'
      ? `Change who can open it with \`${bin} access ${name} --only-me | --members | --add <email> | --group <slug> | --public\`.`
      : `To change who can open it, call fling_set_access (only_me, members, groups, people or public).`
  return opts.invites
    ? `${how} An address from outside is invited as a reviewer, who sees only what is shared with them.`
    : how
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Who can open a site, from what every site response carries (no audience needed), for the CLI
 * and both MCP servers after a publish: `Only you can open it.`, `Only you, 2 people and 1 group
 * can open it.`, and so on, plus a note when a share link opens a restricted one to anyone.
 */
export function describeSiteAccess(
  site: SiteAccessFields & { shareUrl?: string | null },
  members: string
): string {
  const level = siteAccessLevel(site)
  const share =
    site.shareUrl && level !== 'public' && level !== 'members'
      ? ' A share link is active: anyone with it can still open the site.'
      : ''
  if (!needsAudience(level)) return `${accessDescription(level, members)}${share}`
  const groups = site.audienceGroups ?? 0
  const people = (site.audienceSize ?? 0) - groups
  const who = [
    people ? count(people, 'person', 'people') : '',
    groups ? count(groups, 'group', 'groups') : '',
  ].filter(Boolean)
  return `Only you and ${who.join(' and ')} can open it.${share}`
}
