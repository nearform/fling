/**
 * The sign-in link email (auth/sign-in-link.ts), sent at once through direct-mail.ts. It says which
 * instance and address the link signs in, how long it works, and that it works once.
 */
import type { Section } from './types.ts'

/** "15 minutes", "7 days": how long a link lasts, for the email. */
export function lifetimeInWords(seconds: number): string {
  const days = seconds / 86_400
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`
  const hours = seconds / 3_600
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function signInLinkSection(input: {
  instance: string
  to: string
  url: string
  ttlSeconds: number
}): Section {
  return {
    subject: 'Your sign-in link',
    lead: `Here is your link to sign in to ${input.instance} as ${input.to}.`,
    lines: [
      `It works once, within ${lifetimeInWords(input.ttlSeconds)}. If you didn't ask for it, ignore this email: nobody can sign in without the link.`,
    ],
    action: { label: `Sign in to ${input.instance}`, url: input.url },
    why: `someone asked ${input.instance} for a sign-in link for this address`,
  }
}
