/**
 * Groups in the web UI: the slug a new group's name suggests, and checking the create form before
 * it is sent. The API checks again, and decides whether the slug is free.
 */
import {
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
