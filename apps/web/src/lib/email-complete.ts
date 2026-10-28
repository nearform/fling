/**
 * Completing addresses from the instance's allowed email domains (`auth.emailDomains` in the
 * metadata, which never lists addresses): what the email input suggests for the entry being typed,
 * and how it fills in the domain of a pasted list. Only a suggestion: any address can still be
 * typed in full, and the API's email policy decides which ones are let in.
 */

/** What separates the addresses in one input, as `splitEmails` reads them. */
const SEPARATOR = /[\s,;]/

/** The draft split into what comes before the entry being typed (separators included) and it. */
export function currentEntry(draft: string): { head: string; entry: string } {
  let i = draft.length
  while (i > 0 && !SEPARATOR.test(draft[i - 1] as string)) i--
  return { head: draft.slice(0, i), entry: draft.slice(i) }
}

/**
 * The addresses the entry could be: `ann` → `ann@<each domain>`, `ann@ex` → those whose domain
 * starts with `ex`. None for an empty name, or once the domain is typed in full.
 */
export function domainSuggestions(entry: string, domains: readonly string[]): string[] {
  const at = entry.indexOf('@')
  const local = at === -1 ? entry : entry.slice(0, at)
  if (!local || entry.indexOf('@', at + 1) !== -1) return []
  const partial = at === -1 ? '' : entry.slice(at + 1).toLowerCase()
  if (domains.includes(partial)) return []
  return domains.filter(d => d.startsWith(partial)).map(d => `${local}@${d}`)
}

/**
 * With exactly one allowed domain, the rest of the address the entry at the end of the draft is
 * heading for (`ann` → `@example.com`), shown as ghost text; else null.
 */
export function inlineCompletion(draft: string, domains: readonly string[]): string | null {
  if (domains.length !== 1) return null
  const { entry } = currentEntry(draft)
  const [address] = domainSuggestions(entry, domains)
  return address ? address.slice(entry.length) : null
}

/** The draft with its last entry replaced by `address`. */
export function acceptSuggestion(draft: string, address: string): string {
  return `${currentEntry(draft).head}${address}`
}

/**
 * With exactly one allowed domain, each entry without one (`ann`, `ann@`) completed with it, the
 * entries comma-separated; anything else is left as it is, for the caller to check.
 */
export function completeEntries(text: string, domains: readonly string[]): string {
  if (domains.length !== 1) return text
  const domain = domains[0] as string
  return text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(e => (e.endsWith('@') && e.indexOf('@') === e.length - 1 ? `${e}${domain}` : e))
    .map(e => (e.includes('@') ? e : `${e}@${domain}`))
    .join(', ')
}
