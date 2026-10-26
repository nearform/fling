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
