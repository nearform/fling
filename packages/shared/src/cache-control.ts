/**
 * Cache-Control for site files, set when they are uploaded (presigned PUTs and server-side puts).
 *
 * CloudFront's cache key is the rewritten, versioned object path (`/sites/<id>/<versionId>/<path>`),
 * so the CDN can never serve a stale version: `s-maxage` lets it keep every object for a year (the
 * sites distribution uses the managed CachingOptimized policy, whose max TTL is one year, so it
 * honours `s-maxage` up to that). Browsers, though, cache by the public URL, which stays the same
 * across versions — so they must revalidate (a cheap 304 via ETag) unless the file name itself
 * changes with its content.
 */

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
export const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate, s-maxage=31536000'

/** Letter↔digit switches in a token: random hashes have many, words-with-a-year have one. */
function transitions(token: string): number {
  let n = 0
  for (let i = 1; i < token.length; i++) {
    const a = /\d/.test(token[i - 1] as string)
    const b = /\d/.test(token[i] as string)
    if (a !== b) n++
  }
  return n
}

/**
 * Is the file name content-hashed (a bundler output like `index-Bk3x9a2Q.js`,
 * `main.3f9a2c1b.css`)? The last path segment must contain a token of 8+ letters/digits that
 * mixes both (switching between them at least 3 times), set off by `-` or `.` before and
 * followed by a `.` (the extension). Conservative: when in doubt it's not hashed — the cost of a
 * false "no" is only a 304.
 */
export function isHashedFileName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  for (const m of name.matchAll(/[-.]([A-Za-z0-9]{8,})(?=\.[A-Za-z0-9]+)/g)) {
    const token = m[1] as string
    if (/[A-Za-z]/.test(token) && /\d/.test(token) && transitions(token) >= 3) return true
  }
  return false
}

/** Hashed names are immutable; everything else (HTML included) revalidates in the browser. */
export function cacheControlFor(path: string): string {
  return isHashedFileName(path) ? CACHE_IMMUTABLE : CACHE_REVALIDATE
}
