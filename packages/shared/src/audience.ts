// A site's audience: who, besides its owner, may see it while it is private and restricted (its
// access level, access.ts, is `groups` or `people`; a restricted site with an empty audience is
// `only_me`). Editing the audience alone restricts the site when it names someone and opens it to
// every member when it is emptied. The contract, the edits every
// client makes (`fling access`, both servers' `fling_set_audience`, the web's Access section) and
// the words the CLI and both MCP servers describe it (and the sites shared with someone) with.
// Browser-safe (zod only).

import { z } from 'zod'

/** The most addresses an audience holds. */
export const AUDIENCE_EMAILS_MAX = 100
/** The most groups an audience names. */
export const AUDIENCE_GROUPS_MAX = 10

/**
 * An address in an audience or a group; `known` once it has signed in to the instance; `guest`
 * when it is a guest (invited from outside by a share or a group, reviewing only what is shared
 * with them).
 */
export const AudienceEmailSchema = z.object({
  email: z.string(),
  known: z.boolean(),
  guest: z.boolean().optional(),
})
export type AudienceEmail = z.infer<typeof AudienceEmailSchema>

/**
 * A group in an audience (groups.ts), by its slug; `size`: how many members it has. A group that
 * has been deleted while it was the audience's only entry stays in it, letting nobody in, so the
 * site stays restricted to its owner: it is `deleted`, and its `slug` is a reference
 * (`deletedGroupRef`) the owner passes back to keep it, or leaves out to remove it.
 */
export const AudienceGroupSchema = z.object({
  slug: z.string(),
  name: z.string(),
  size: z.number(),
  deleted: z.boolean().optional(),
})
export type AudienceGroup = z.infer<typeof AudienceGroupSchema>

/** How an audience names a deleted group (`#<id>`): never a slug, which has no `#`. */
export const deletedGroupRef = (id: string) => `#${id}`
/** The id in a deleted group's reference, or null for a slug. */
export const deletedGroupId = (ref: string) => (ref.startsWith('#') ? ref.slice(1) : null)

/** As the API reports it to the owner. */
export const AudienceSchema = z.object({
  emails: z.array(AudienceEmailSchema),
  groups: z.array(AudienceGroupSchema).default([]),
})
export type Audience = z.infer<typeof AudienceSchema>

/**
 * PATCH /api/sites/:name { audience }: the whole new audience. Each address must be one the
 * instance lets sign in, or, with outside invitations on (the `invites` capability), one from
 * outside, invited as a guest (a reviewer); each group (by slug) must exist (else a 400 naming it).
 */
export const AudienceInputSchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase().min(3).max(254))
    .max(AUDIENCE_EMAILS_MAX, `An audience holds at most ${AUDIENCE_EMAILS_MAX} addresses`),
  groups: z
    .array(z.string().trim().toLowerCase().min(1).max(100))
    .max(AUDIENCE_GROUPS_MAX, `An audience names at most ${AUDIENCE_GROUPS_MAX} groups`)
    .default([]),
})
export type AudienceInput = z.input<typeof AudienceInputSchema>

/**
 * A change to an audience: its addresses (`set`, `add`, `remove`) and its groups by slug
 * (`setGroups`, `addGroups`, `removeGroups`), each cleared or replaced first, then added to, then
 * removed from. `clear` empties both.
 */
export interface AudienceChange {
  set?: readonly string[]
  add?: readonly string[]
  remove?: readonly string[]
  setGroups?: readonly string[]
  addGroups?: readonly string[]
  removeGroups?: readonly string[]
  clear?: boolean
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase()

/** `a@x.test, b@x.test` (or several such values) → the addresses, normalised. */
export function splitEmails(values: string | readonly string[]): string[] {
  const all = typeof values === 'string' ? [values] : values
  return all
    .flatMap(v => v.split(/[\s,;]+/))
    .map(normaliseEmail)
    .filter(Boolean)
}

/** The addresses after `change`, normalised, each once, in the order they were first given. */
export function editAudience(current: readonly string[], change: AudienceChange): string[] {
  let emails = change.clear ? [] : change.set ? [...change.set] : [...current]
  emails = [...emails, ...(change.add ?? [])].map(normaliseEmail)
  const removed = new Set((change.remove ?? []).map(normaliseEmail))
  return [...new Set(emails)].filter(e => e && !removed.has(e))
}

/** The group slugs after `change`, normalised, each once, in the order they were first given. */
export function editAudienceGroups(current: readonly string[], change: AudienceChange): string[] {
  const norm = (s: string) => s.trim().toLowerCase()
  let groups = change.clear ? [] : change.setGroups ? [...change.setGroups] : [...current]
  groups = [...groups, ...(change.addGroups ?? [])].map(norm)
  const removed = new Set((change.removeGroups ?? []).map(norm))
  return [...new Set(groups)].filter(g => g && !removed.has(g))
}

/** The whole new audience after `change`, as PATCH takes it (groups by slug). */
export function editAudienceInput(
  current: { emails: readonly AudienceEmail[]; groups: readonly AudienceGroup[] },
  change: AudienceChange
): { emails: string[]; groups: string[] } {
  return {
    emails: editAudience(
      current.emails.map(e => e.email),
      change
    ),
    groups: editAudienceGroups(
      current.groups.map(g => g.slug),
      change
    ),
  }
}

/** Whether a change edits anything. */
export const changesAudience = (change: AudienceChange) =>
  Boolean(
    change.clear ||
      change.set ||
      change.add?.length ||
      change.remove?.length ||
      change.setGroups ||
      change.addGroups?.length ||
      change.removeGroups?.length
  )

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** `design (Design team, 4 people)`; a deleted one: `a deleted group (#<id>)`. */
export const groupLabel = (g: Pick<AudienceGroup, 'slug' | 'name' | 'size' | 'deleted'>) =>
  g.deleted
    ? `a deleted group (${g.slug})`
    : `${g.slug} (${g.name !== g.slug ? `${g.name}, ` : ''}${people(g.size)})`

/**
 * `3 people`, `the group design (…)`, `a deleted group (#…)`: who an audience names, as parts of a
 * sentence.
 */
function whoIn(emails: readonly AudienceEmail[], groups: readonly AudienceGroup[]): string[] {
  const live = groups.filter(g => !g.deleted)
  return [
    emails.length ? people(emails.length) : '',
    live.length
      ? `${live.length === 1 ? 'the group' : 'the groups'} ${live.map(groupLabel).join(', ')}`
      : '',
    ...groups.filter(g => g.deleted).map(groupLabel),
  ].filter(Boolean)
}

/** `a`, `a and b`, `a, b and c`. */
const and = (parts: readonly string[]) =>
  parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')

/** `a@x.test, b@x.test (hasn't signed in yet), c@y.test (guest)`. */
export const audienceList = (emails: readonly AudienceEmail[]) =>
  emails
    .map(e => {
      const notes = [e.guest ? 'guest' : '', e.known ? '' : "hasn't signed in yet"].filter(Boolean)
      return notes.length ? `${e.email} (${notes.join(', ')})` : e.email
    })
    .join(', ')

/**
 * Who can open the site, for the CLI and both MCP servers: public, every member
 * (`privateAudience`), only the owner, or the listed people; plus a warning when a share link
 * still opens a restricted site to anyone. `restricted` (servers before access levels omit it):
 * private and limited to the owner and the audience.
 */
export function describeAudience(
  site: {
    visibility: 'public' | 'private'
    audience?: Audience
    shareUrl: string | null
    restricted?: boolean
  },
  privateAudience: string
): string {
  const emails = site.audience?.emails ?? []
  const groups = site.audience?.groups ?? []
  const empty = emails.length + groups.length === 0
  const list = emails.length ? `: ${audienceList(emails)}` : ''
  if (site.visibility === 'public') {
    const kept = empty
      ? ''
      : ` Its audience (${and(whoIn(emails, groups))}${list}) applies when it is private again.`
    return `Public: anyone can open the site; reviewing it still needs sign-in.${kept}`
  }
  const share = site.shareUrl
    ? ` A share link is active: anyone with it can still open the site (${site.shareUrl}).`
    : ''
  if (empty) {
    return site.restricted
      ? `Only you: nobody else can open it.${share}`
      : `Private: ${privateAudience} can open it.`
  }
  if (emails.length === 0 && groups.every(g => g.deleted)) {
    const refs = groups.map(g => g.slug).join(', ')
    return `Restricted: only you can open it. Its audience names only ${groups.length === 1 ? 'a deleted group' : 'deleted groups'} (${refs}), which let nobody in: add people or groups, or clear it.${share}`
  }
  return `Restricted: only ${and(['you', ...whoIn(emails, groups)])} can open it${list}.${share}`
}

/** What says how a shared site reached someone (`SharedSite`, api.ts). */
interface SharedVia {
  via: { direct: boolean; groups: readonly string[] }
}

/** `your address`, `group design`, `your address and groups design, ops`: how a site was shared. */
export function sharedVia(site: SharedVia): string {
  const { direct, groups } = site.via
  return and([
    ...(direct ? ['your address'] : []),
    ...(groups.length ? [`${groups.length === 1 ? 'group' : 'groups'} ${groups.join(', ')}`] : []),
  ])
}

/**
 * One site shared with the user, for the CLI and both MCP servers:
 * `- q3-report: https://… (shared by ann@x.test, through group design; review: https://…)`.
 */
export const describeSharedSite = (
  site: SharedVia & { name: string; url: string; owner: string; reviewUrl?: string }
) =>
  `- ${site.name}: ${site.url} (shared by ${site.owner}, through ${sharedVia(site)}` +
  `${site.reviewUrl ? `; review: ${site.reviewUrl}` : ''})`
