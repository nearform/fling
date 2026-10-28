/**
 * Groups in the web UI: the slug a new group's name suggests, checking the create form before it
 * is sent (the API checks again, and decides whether the slug is free), and swapping a site's
 * listed addresses for a group that holds them.
 */
import {
  AUDIENCE_GROUPS_MAX,
  GROUP_MEMBERS_MAX,
  GROUP_SLUG_MAX,
  GROUP_SLUG_RULES,
  isValidGroupSlug,
} from '@fling/shared'
import { addToGroup } from './audience'

/** `Design Team!` → `design-team`: lowercase letters and digits, single hyphens between words. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, GROUP_SLUG_MAX)
    .replace(/^-+|-+$/g, '')
}

export type NewGroupCheck =
  | { ok: true; slug: string; name: string; members: string[] }
  | { ok: false; problem: string }

/** The create form's fields, as POST /api/groups takes them, or what to fix first. */
export function checkNewGroup(fields: {
  slug: string
  name: string
  members: string
}): NewGroupCheck {
  const slug = fields.slug.trim().toLowerCase()
  const name = fields.name.trim()
  if (!name) return { ok: false, problem: 'Give the group a name.' }
  if (!isValidGroupSlug(slug)) return { ok: false, problem: `A slug is ${GROUP_SLUG_RULES}.` }
  const { emails, invalid, overflow } = addToGroup([], fields.members)
  if (invalid.length) return { ok: false, problem: `Not an email address: ${invalid.join(', ')}` }
  if (overflow.length) {
    return { ok: false, problem: `A group holds at most ${GROUP_MEMBERS_MAX} people.` }
  }
  return { ok: true, slug, name, members: emails }
}

/** Whether two lists name the same people: each address once, in any order or case. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(e => e.trim().toLowerCase()))
  const right = new Set(b.map(e => e.trim().toLowerCase()))
  return left.size === right.size && [...left].every(e => right.has(e))
}

/** An audience as PATCH /api/sites/:name takes it: addresses, and groups by slug. */
export interface AudienceEdit {
  emails: string[]
  groups: string[]
}

/**
 * The audience with the group named in it and, of its addresses, those the group holds taken out:
 * they still get in, through the group, so who can open the site is unchanged when the group holds
 * exactly the addresses taken out. Null when the group doesn't fit (AUDIENCE_GROUPS_MAX).
 */
export function swapEmailsForGroup(
  audience: { emails: readonly string[]; groups: readonly string[] },
  group: { slug: string; members: readonly string[] }
): AudienceEdit | null {
  const named = audience.groups.includes(group.slug)
  if (!named && audience.groups.length >= AUDIENCE_GROUPS_MAX) return null
  const held = new Set(group.members.map(e => e.toLowerCase()))
  return {
    emails: audience.emails.filter(e => !held.has(e.toLowerCase())),
    groups: named ? [...audience.groups] : [...audience.groups, group.slug],
  }
}

/** `ann.lee@example.com` → `ann.lee` and `@example.com`; no `@`: all of it is the local part. */
export function splitEmail(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@')
  return at <= 0
    ? { local: email, domain: '' }
    : { local: email.slice(0, at), domain: email.slice(at) }
}
