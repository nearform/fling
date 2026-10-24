// Which first labels of a sites host are sites (`<name>`) or share links (`s--<token>`).
// Dependency-free and in the CloudFront Functions syntax subset (see site-routing.ts): the edge
// bundles it.

export const SITE_NAME_MAX = 50
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

export function isValidSiteName(name: string): boolean {
  return (
    name.length <= SITE_NAME_MAX &&
    SLUG_RE.test(name) &&
    !name.includes('--') &&
    !RESERVED_SITE_NAMES.includes(name)
  )
}

export type ParsedLabel = { kind: 'site'; name: string } | { kind: 'share'; token: string }

/** Parse the first DNS label of a sites-domain host. Returns null for anything malformed. */
export function parseLabel(label: string): ParsedLabel | null {
  const parts = label.split('--')
  if (parts.length === 1) return isValidSiteName(label) ? { kind: 'site', name: label } : null
  if (parts.length === 2 && parts[0] === 's' && SHARE_TOKEN_RE.test(parts[1] || '')) {
    return { kind: 'share', token: parts[1] as string }
  }
  return null
}
