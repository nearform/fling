// Route table keys and the edge's special paths. Dependency-free: the CloudFront Function bundles
// this (see site-routing.ts for the syntax it may use).

/** `site:<name>` → routing for a live (non-archived) site. */
export const siteKvsKey = (label: string) => `site:${label}`
/** `share:<token>` → routing for a share link; served without auth. */
export const shareKvsKey = (token: string) => `share:${token}`
/** HMAC key the edge uses to verify the `fling_site` cookie. */
export const SITE_HMAC_KVS_KEY = 'cfg:site-hmac'

/** Object key that never exists; the edge rewrites unknown hosts here so S3 404s into the error page. */
export const MISSING_KEY = '/_fling/missing'
export const NOT_FOUND_PAGE = '/_fling/404.html'
/** The review shell (review-bridge.ts): a static page on every sites host that frames the site. */
export const REVIEW_SHELL = '/_fling/review.html'
/**
 * Where a restricted site's host turns a pass handoff into a site pass:
 * `/_fling-pass?t=<handoff>&r=<path>` (site-cookie.ts, site-routing.ts). Not under `/_fling/`:
 * on AWS that path is served from the bucket without the site router (the error page's behaviour).
 */
export const SITE_PASS_PATH = '/_fling-pass'
/** The site pass cookie (host-only, on a restricted site's host). */
export const SITE_PASS_COOKIE_NAME = 'fling_pass'
/** How long a site pass lasts: the most a removed viewer keeps seeing the site. */
export const SITE_PASS_TTL_SECONDS = 5 * 60
/**
 * How long a `fling_pass` that says the site refused this browser lasts: the site answers 404
 * until then, and someone added to its audience waits at most this long to get in.
 */
export const SITE_DENIED_TTL_SECONDS = 10
