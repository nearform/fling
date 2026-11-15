/**
 * How a site's server is named on AWS: its Web Function (`<prefix><siteId>`, the prefix
 * Terraform's IAM fence names), its log groups, and the label each revision carries (the version
 * it runs and a hash of what it runs with), which is how a revision is found again without any
 * state of Fling's own.
 */

/** The endpoint CloudFront reaches the live revision at (the route value's `t`). */
export const LIVE_ENDPOINT = 'live'
/** The endpoint the start probe reaches a revision at before it is live: only the API may call it. */
export const PROBE_ENDPOINT = 'probe'

/** Tags on every site's function: the instance (the IAM fence's condition) and the site. */
export const TAG_INSTANCE = 'fling:instance'
export const TAG_SITE = 'fling:site'
/** The rate the live endpoint runs at when it isn't stopped (setEnabled(true) restores it). */
export const TAG_RATE = 'fling:rate'
/** Present while the site's server is stopped: its live endpoint's rate is 0. */
export const TAG_STOPPED = 'fling:stopped'

export const functionName = (prefix: string, siteId: string) => `${prefix}${siteId}`

export const siteIdOf = (prefix: string, fn: string) =>
  fn.startsWith(prefix) ? fn.slice(prefix.length) : null

/** Where Lambda writes a function's log: the home Region's group, and the `.local` one. */
export const logGroupsOf = (fn: string) => [`/aws/lambda/web/${fn}`, `/aws/lambda/web/${fn}.local`]

/** The group server-logs.ts reads. */
export const logGroupOf = (fn: string) => `/aws/lambda/web/${fn}`

export const LOG_GROUP_PREFIX = '/aws/lambda/web/'

/** A revision's description: `<versionId> <hash>`. */
export const revisionLabel = (versionId: string, hash: string) => `${versionId} ${hash}`

export function parseRevisionLabel(label: string): { versionId: string; hash: string } | null {
  const [versionId, hash, ...rest] = label.split(' ')
  if (!versionId || !hash || rest.length > 0) return null
  return { versionId, hash }
}

/** The revision a log stream belongs to: streams are `YYYY/MM/DD/<fn>[<revisionId>]<instance>`. */
export const revisionOfStream = (stream: string) => /\[([^\]]+)\]/.exec(stream)?.[1] ?? null
