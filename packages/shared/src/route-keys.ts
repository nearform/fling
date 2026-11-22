// Route table keys and the edge's special paths. Dependency-free: the CloudFront Function bundles
// this (see site-routing.ts for the syntax it may use).

/** `site:<name>` → routing for a live (non-archived) site. */
export const siteKvsKey = (label: string) => `site:${label}`
/** `share:<token>` → routing for a share link; served without auth. */
export const shareKvsKey = (token: string) => `share:${token}`
/**
 * `path:<siteId>/<folder>` → where a Path of a site is served from (`{id, v}`, KvsPathValueSchema
 * in kvs.ts). Keyed by the site's id, so a share host and a renamed site find the same Paths.
 */
export const pathKvsKey = (siteId: string, folder: string) => `path:${siteId}/${folder}`
/** HMAC key the edge uses to verify the `fling_site` cookie. */
export const SITE_HMAC_KVS_KEY = 'cfg:site-hmac'
/**
 * `revoked:<mac>` → an expiry, in epoch seconds: the revocation list. A member's `fling_site` for
 * that email expiring no later than it (so issued by the revocation's second) no longer opens a site. `mac` is
 * the base64url HMAC of the email under the site cookie key (site-cookie.ts, `revocationMac`), so
 * no address is stored at the edge; an email has an `@`, so it is never a token body.
 */
export const revokedKvsKey = (mac: string) => `revoked:${mac}`

/** Object key that never exists; the edge rewrites unknown hosts here so S3 404s into the error page. */
export const MISSING_KEY = '/_fling/missing'
export const NOT_FOUND_PAGE = '/_fling/404.html'
/** The review shell (review-bridge.ts): a static page on every sites host that frames the site. */
export const REVIEW_SHELL = '/_fling/review.html'
/** Every sites host's `/robots.txt` (site-routing.ts): `Disallow: /`, so no site is indexed. */
export const ROBOTS_TXT = '/_fling/robots.txt'
/**
 * Where a restricted site's host turns a pass handoff into a site pass:
 * `/_fling-pass?t=<handoff>&r=<path>` (site-cookie.ts, site-routing.ts). Not under `/_fling/`:
 * on AWS that path is served from the bucket without the site router (the error page's behaviour).
 */
export const SITE_PASS_PATH = '/_fling-pass'
/**
 * Where a sites host says which version of the site it serves now: a 204 with SITE_VERSION_HEADER
 * (site-routing.ts), after the same access checks as the site's pages. An answer, not a rewrite, so
 * the header reaches the browser on every runtime (a CloudFront viewer-request function cannot add
 * headers to what S3 serves). Not under `/_fling/`, for the same reason as SITE_PASS_PATH.
 */
export const SITE_VERSION_PATH = '/_fling-version'
/**
 * Where a page's view beacon (view-beacon.ts) says the page was viewed: a POST on the site's own
 * host, after the same access checks as its pages. The routing decision makes it an invoke with no
 * target, which the platform counts (views.ts) and answers with a 204; nothing is stored about who
 * viewed. Not under `/_fling/`, for the same reason as SITE_PASS_PATH.
 */
export const SITE_SEEN_PATH = '/_fling-seen'
/**
 * Where a version whose pages count views keeps each HTML page's copy with the beacon (route
 * value `c`): `<COUNTED_DIR><path>` beside its files, a dot segment, so never a site path.
 */
export const COUNTED_DIR = '.counted/'
/**
 * A site with Paths: its live Paths as JSON, the data its home page's Paths block lists
 * (paths-index.ts). Rewritten to the rendered listing, only while the route value names one (`i`).
 */
export const PATHS_JSON_PATH = '/_fling-paths.json'
/** The object key of a site's rendered home page (`html`) or Paths listing (`json`). */
export const renderedObjectKey = (siteId: string, sha: string, ext: 'html' | 'json') =>
  `sites/${siteId}/_rendered/${sha}.${ext}`
/** The version a sites host serves (`x-fling-version: <versionId>`). */
export const SITE_VERSION_HEADER = 'x-fling-version'
/** The site pass cookie (host-only, on a restricted site's host). */
export const SITE_PASS_COOKIE_NAME = 'fling_pass'
/** How long a site pass lasts: the most a removed viewer keeps seeing the site. */
export const SITE_PASS_TTL_SECONDS = 5 * 60
/**
 * How long a `fling_pass` that says the site refused this browser lasts: the site answers 404
 * until then, and someone added to its audience waits at most this long to get in.
 */
export const SITE_DENIED_TTL_SECONDS = 10

/**
 * Requests under this prefix go to the site's server, when its current version has one (route
 * value `f`, site-routing.ts): any method, after every access check. Elsewhere, and on a site
 * without a server, `/api/` is an ordinary folder.
 */
export const SERVER_PREFIX = '/api/'
/** A version's server: one bundled ES module, a file of the version that is never served. */
export const SERVER_BUNDLE = '_fling/server.mjs'
/** Who is calling, as the server reads it: `{"id","email","guest"}`, set by Fling, never the browser. */
export const VIEWER_HEADER = 'x-fling-viewer'
/** The site and version an invoke runs, on the request the server's runtime receives. */
export const SERVER_SITE_HEADER = 'x-fling-site'
/** Every path under it is Fling's: a site's own files there are never served. */
export const FLING_DIR = '/_fling/'

/**
 * A server's own 403 or 404 on AWS. The sites distribution's custom error responses turn every
 * 403 and 404 from an origin into the sites' 404 page, and a viewer-response function never runs
 * on an answer of 400 or more, so the Web Function entry sends a server's 403 or 404 as
 * SERVER_STAND_IN_STATUS with SERVER_STATUS_HEADER naming the real one, and the /api/* behaviour's
 * viewer-response function (edge/src/server-status.js) puts it back (`restoredServerStatus`).
 *
 * 300 Multiple Choices: below 400, so CloudFront has no custom error response for it and runs the
 * viewer-response function; not a redirect status in Fetch, so with no Location nothing follows it;
 * it may carry a body; and should the restore ever be skipped, a client still sees a status that
 * is neither a success nor a redirect. Servers rarely send it, and one that does without the
 * header gets it through unchanged.
 */
export const SERVER_STAND_IN_STATUS = 300
/** The status a server really answered, on a SERVER_STAND_IN_STATUS answer (see above). */
export const SERVER_STATUS_HEADER = 'x-fling-status'
/** The statuses that would meet the sites' error page, and so travel as SERVER_STAND_IN_STATUS. */
export const isStoodInStatus = (status: number) => status === 403 || status === 404

/**
 * The status a server answered: `header` (SERVER_STATUS_HEADER) on a SERVER_STAND_IN_STATUS
 * answer, when it names one the stand-in is for; else `status` as it is.
 */
export function restoredServerStatus(status: number, header: string | null | undefined): number {
  if (status !== SERVER_STAND_IN_STATUS || !header) return status
  const real = Number(header)
  return isStoodInStatus(real) ? real : status
}

/**
 * How long CloudFront waits on a site server's answer (an invoke's `readTimeout`, between the
 * request and the first byte and between any two packets): 120 s, the most CloudFront allows
 * without a quota increase. On AWS this is the ceiling of SERVER_TIMEOUT_SECONDS (the adapter
 * advertises it as `maxTimeoutSeconds`); the Web Function entry enforces the exact limit below it.
 */
export const EDGE_SERVER_READ_TIMEOUT_SECONDS = 120
