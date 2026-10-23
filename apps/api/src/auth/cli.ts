/** CLI loopback login helpers (from rocketpod `routes/auth/cli.ts`, tenants removed). */

/**
 * `http://127.0.0.1:<port>/callback` | `http://localhost:<port>/callback`, nothing else — that
 * allowlist is what makes handing the key over in a query string acceptable.
 */
export function validateCliRedirectUri(value: string | undefined): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  if (!url.port) return null
  if (url.pathname !== '/callback') return null
  if (url.search || url.hash || url.username || url.password) return null
  return url
}

export function cliKeyName(hostname: string | undefined): string {
  const clean = (hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64)
  return `cli:${clean || 'cli'}`
}
