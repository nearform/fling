// Naming rules for sites and the hostnames they are served on.
//
// Site names are one global namespace (first come, first served): a site lives at
// `<name>.<sitesDomain>`. A share link lives at `s--<token>.<sitesDomain>`. Site
// names may not contain `--`, so the two can never collide.

export const SITE_NAME_MAX = 50
export const USER_SLUG_MAX = 20
export const SHARE_TOKEN_LENGTH = 20

/** Names that would be confusing or that we may want for ourselves. */
export const RESERVED_SITE_NAMES: readonly string[] = [
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'cdn',
  'docs-fling',
  'fling',
  'help',
  'login',
  'mail',
  'static',
  'status',
  'www',
]

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const SHARE_TOKEN_RE = new RegExp(`^[a-z0-9]{${SHARE_TOKEN_LENGTH}}$`)

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

export function isValidSiteName(name: string): boolean {
  return (
    name.length <= SITE_NAME_MAX &&
    SLUG_RE.test(name) &&
    !name.includes('--') &&
    !RESERVED_SITE_NAMES.includes(name)
  )
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

export type ParsedLabel = { kind: 'site'; name: string } | { kind: 'share'; token: string }

/** Parse the first DNS label of a sites-domain host. Returns null for anything malformed. */
export function parseLabel(label: string): ParsedLabel | null {
  const parts = label.split('--')
  if (parts.length === 1) return isValidSiteName(label) ? { kind: 'site', name: label } : null
  if (parts.length === 2 && parts[0] === 's' && SHARE_TOKEN_RE.test(parts[1] ?? '')) {
    return { kind: 'share', token: parts[1] as string }
  }
  return null
}

export function siteUrl(label: string, sitesDomain: string, protocol = 'https:'): string {
  return `${protocol}//${label}.${sitesDomain}/`
}
