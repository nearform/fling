/**
 * A private site's audience in the web UI: turning what the owner types or pastes into addresses
 * (lowercase, trimmed, each once, at most AUDIENCE_EMAILS_MAX), and the words for it. The API
 * still checks every address against the instance's email policy.
 */
import { AUDIENCE_EMAILS_MAX, splitEmails } from '@fling/shared'

/** The same shape check the API makes before the email policy. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/

export interface AudienceAddition {
  /** the whole new list: the current addresses, then the new ones */
  emails: string[]
  /** what was typed that isn't an address, to leave in the input */
  invalid: string[]
  /** addresses that didn't fit under the cap */
  overflow: string[]
}

/** `current` plus the addresses in `text` (separated by commas, semicolons or spaces). */
export function addToAudience(current: readonly string[], text: string): AudienceAddition {
  const typed = splitEmails(text)
  const invalid = typed.filter(e => !EMAIL_RE.test(e))
  const emails = [...current]
  const overflow: string[] = []
  for (const email of typed) {
    if (!EMAIL_RE.test(email) || emails.includes(email)) continue
    if (emails.length >= AUDIENCE_EMAILS_MAX) overflow.push(email)
    else emails.push(email)
  }
  return { emails, invalid, overflow }
}

/** `1 person`, `3 people`. */
export const peopleLabel = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** The list badge of a restricted site. */
export const restrictedLabel = (n: number) => `Restricted · ${peopleLabel(n)}`
