// A site's audience: who, besides its owner, may see it while it is private. Empty means every
// signed-in member; a private site with an audience is restricted. The contract, the edits every
// client makes (`fling access`, both servers' `fling_set_audience`, the web's Access section) and
// the words the CLI and both MCP servers describe it with. Browser-safe (zod only).

import { z } from 'zod'

/** The most addresses an audience holds. */
export const AUDIENCE_EMAILS_MAX = 100

/** An address in an audience; `known` once it has signed in to the instance. */
export const AudienceEmailSchema = z.object({ email: z.string(), known: z.boolean() })
export type AudienceEmail = z.infer<typeof AudienceEmailSchema>

/** As the API reports it to the owner. `groups` are group ids (none until groups arrive). */
export const AudienceSchema = z.object({
  emails: z.array(AudienceEmailSchema),
  groups: z.array(z.string()).default([]),
})
export type Audience = z.infer<typeof AudienceSchema>

/**
 * PATCH /api/sites/:name { audience }: the whole new audience. Each address must be one the
 * instance lets sign in. Groups are refused until the instance has them (the `groups` capability).
 */
export const AudienceInputSchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase().min(3).max(254))
    .max(AUDIENCE_EMAILS_MAX, `An audience holds at most ${AUDIENCE_EMAILS_MAX} addresses`),
  groups: z.array(z.string()).max(0, 'Groups are not available on this instance').default([]),
})
export type AudienceInput = z.input<typeof AudienceInputSchema>

/** A change to an audience's addresses: cleared or replaced first, then added to, then removed from. */
export interface AudienceChange {
  set?: readonly string[]
  add?: readonly string[]
  remove?: readonly string[]
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

/** Whether a change edits anything. */
export const changesAudience = (change: AudienceChange) =>
  Boolean(change.clear || change.set || change.add?.length || change.remove?.length)

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`

/** `a@x.test, b@x.test (hasn't signed in yet)`. */
export const audienceList = (emails: readonly AudienceEmail[]) =>
  emails.map(e => (e.known ? e.email : `${e.email} (hasn't signed in yet)`)).join(', ')

/**
 * Who can open the site, for the CLI and both MCP servers: public, every member
 * (`privateAudience`), or the listed people; plus a warning when a share link still opens a
 * restricted site to anyone.
 */
export function describeAudience(
  site: {
    visibility: 'public' | 'private'
    audience?: Audience
    shareUrl: string | null
  },
  privateAudience: string
): string {
  const emails = site.audience?.emails ?? []
  if (site.visibility === 'public') {
    return emails.length
      ? `Public: anyone can open it. Its audience (${people(emails.length)}: ${audienceList(emails)}) applies when it is private again.`
      : 'Public: anyone can open it.'
  }
  if (emails.length === 0) return `Private: ${privateAudience} can open it.`
  const share = site.shareUrl
    ? ` A share link is active: anyone with it can still open the site (${site.shareUrl}).`
    : ''
  return `Restricted: only you and ${people(emails.length)} can open it: ${audienceList(emails)}.${share}`
}
