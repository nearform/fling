// Naming rules for sites and the hostnames they are served on.
//
// Site names are one global namespace (first come, first served): a site lives at
// `<name>.<sitesDomain>`. A share link lives at `s--<token>.<sitesDomain>`. Site
// names may not contain `--`, so the two can never collide.

export {
  isValidSiteName,
  type ParsedLabel,
  parseLabel,
  RESERVED_SITE_NAMES,
  SHARE_TOKEN_LENGTH,
  SITE_NAME_MAX,
} from './site-labels.ts'

import { SITE_NAME_MAX } from './site-labels.ts'

export const USER_SLUG_MAX = 20

export function slugify(input: string, max = SITE_NAME_MAX): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
}

export function userSlugFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  return slugify(local, USER_SLUG_MAX) || 'user'
}

/** `clifton.cunningham@…` → `cc`; a single-word local part gives its first two letters. */
export function initialsFromEmail(email: string): string {
  const words = slugify(email.split('@')[0] ?? '', 64)
    .split('-')
    .filter(Boolean)
  if (words.length === 0) return 'x'
  if (words.length === 1) return (words[0] as string).slice(0, 2)
  return words
    .map(w => w[0])
    .join('')
    .slice(0, 4)
}

/**
 * Free-name candidates when `name` belongs to someone else: `<name>-<initials>`,
 * `<name>-<initials>2`, … (the base is trimmed so each stays within SITE_NAME_MAX).
 */
export function nameSuggestions(name: string, initials: string, count: number): string[] {
  const out: string[] = []
  for (let i = 1; out.length < count; i++) {
    const suffix = `-${initials}${i === 1 ? '' : i}`
    const base = name.slice(0, SITE_NAME_MAX - suffix.length).replace(/-+$/, '')
    out.push(`${base}${suffix}`)
  }
  return out
}

/** The DNS label a site is served on — just its name. */
export function siteLabel(name: string): string {
  return name
}

export function shareLabel(token: string): string {
  return `s--${token}`
}

export function siteUrl(label: string, sitesDomain: string, protocol = 'https:'): string {
  return `${protocol}//${label}.${sitesDomain}/`
}
