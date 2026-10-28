/**
 * Lists of people in the web UI, a site's audience and a group's members: turning what
 * someone types or pastes into addresses (lowercase, trimmed, each once, up to the list's cap),
 * and the words for an audience of people and groups. The API still checks every address against
 * the instance's email policy.
 */
import {
  ACCESS_LABELS,
  AUDIENCE_EMAILS_MAX,
  GROUP_MEMBERS_MAX,
  needsAudience,
  type SiteAccessFields,
  siteAccessLevel,
  splitEmails,
} from '@fling/shared'

/** The same shape check the API makes before the email policy. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/

export interface EmailAddition {
  /** the whole new list: the current addresses, then the new ones */
  emails: string[]
  /** what was typed that isn't an address, to leave in the input */
  invalid: string[]
  /** addresses that didn't fit under the cap */
  overflow: string[]
}

/** `current` plus the addresses in `text` (separated by commas, semicolons or spaces), up to `max`. */
export function addEmails(current: readonly string[], text: string, max: number): EmailAddition {
  const typed = splitEmails(text)
  const invalid = typed.filter(e => !EMAIL_RE.test(e))
  const emails = [...current]
  const overflow: string[] = []
  for (const email of typed) {
    if (!EMAIL_RE.test(email) || emails.includes(email)) continue
    if (emails.length >= max) overflow.push(email)
    else emails.push(email)
  }
  return { emails, invalid, overflow }
}

/** A site's audience addresses plus those in `text`, at most AUDIENCE_EMAILS_MAX. */
export const addToAudience = (current: readonly string[], text: string) =>
  addEmails(current, text, AUDIENCE_EMAILS_MAX)

/** A group's members plus those in `text`, at most GROUP_MEMBERS_MAX. */
export const addToGroup = (current: readonly string[], text: string) =>
  addEmails(current, text, GROUP_MEMBERS_MAX)

/** `1 person`, `3 people`. */
export const peopleLabel = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** `1 group`, `2 groups`. */
export const groupsLabel = (n: number) => `${n} ${n === 1 ? 'group' : 'groups'}`

/** `2 people`, `1 group`, `2 people and 1 group`: the parts that aren't zero. */
export function audienceWho(people: number, groups: number): string {
  const parts = [people ? peopleLabel(people) : '', groups ? groupsLabel(groups) : '']
  return parts.filter(Boolean).join(' and ') || peopleLabel(0)
}

/**
 * A site's access level for its badge: the level's label (`Only you`, `Everyone signed in`,
 * `Public`), and for a list of people and teams how many it names (`Specific people · 2 people ·
 * 1 group`).
 */
export function accessBadgeLabel(site: SiteAccessFields): string {
  const level = siteAccessLevel(site)
  if (!needsAudience(level)) return ACCESS_LABELS[level]
  const groups = site.audienceGroups ?? 0
  const people = Math.max(0, (site.audienceSize ?? 0) - groups)
  const parts = [people ? peopleLabel(people) : '', groups ? groupsLabel(groups) : '']
  return [ACCESS_LABELS[level], ...parts.filter(Boolean)].join(' · ')
}
