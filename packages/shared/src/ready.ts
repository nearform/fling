/**
 * Readiness wait after a site (or share link) goes live. A new site reaches CloudFront's
 * KeyValueStore at every edge within seconds, not instantly; a browser that opens the link in that
 * window sees the 404 page. So after a deploy that went live (`live`/`repointed`) or a new/rotated
 * share link, the CLI and both MCP servers poll the URL until the edge routes it.
 *
 * Used by apps/cli (CLI commands + local MCP) and apps/api (remote MCP). Browser-safe: `fetch`,
 * `sleep` and `now` are injectable so tests never touch the network or the clock.
 */

export interface ReachableResult {
  /** the edge routes the URL (2xx, 3xx — e.g. the sign-in redirect of a private site — 401, 403) */
  ready: boolean
  waitedMs: number
}

export interface WaitOptions {
  timeoutMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** first delay between polls (default 750 ms); grows by 1.25× up to 2 s */
  intervalMs?: number
  /** called once, when the first poll says "not yet" (the CLI starts its spinner) */
  onWaiting?: () => void
}

export const READY_TIMEOUT_MS = 15_000
/** The remote MCP runs in a Lambda behind a ~10 s connector timeout. */
export const READY_TIMEOUT_LAMBDA_MS = 8_000

/** Shown when the wait timed out (CLI line and MCP result text). */
export const NOT_READY_NOTE =
  'it can take a few more seconds to appear everywhere; reload if you see a 404'

export const isReachableStatus = (status: number) =>
  (status >= 200 && status < 400) || status === 401 || status === 403

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function waitUntilReachable(
  url: string,
  opts: WaitOptions = {}
): Promise<ReachableResult> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS
  const doFetch = opts.fetch ?? ((u: string, init: RequestInit) => fetch(u, init))
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())
  const start = now()
  let interval = opts.intervalMs ?? 750
  let announced = false

  for (;;) {
    const remaining = timeoutMs - (now() - start)
    try {
      const res = await doFetch(url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(250, Math.min(remaining, 5_000))),
      })
      await res.body?.cancel().catch(() => {})
      if (isReachableStatus(res.status)) return { ready: true, waitedMs: now() - start }
    } catch {
      // network hiccup or per-request timeout: treat as "not yet"
    }
    if (!announced) {
      announced = true
      opts.onWaiting?.()
    }
    const left = timeoutMs - (now() - start)
    if (left <= 0) return { ready: false, waitedMs: now() - start }
    await sleep(Math.min(interval, left))
    interval = Math.min(interval * 1.25, 2_000)
  }
}

/**
 * Which URL to poll for a site served at `siteUrl` with these files: the root when there is an
 * index.html, else one of its files (the root of a site without index.html 404s for good, which
 * would look like "not routed yet").
 */
export function probeUrl(siteUrl: string, paths: readonly string[]): string {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`
  if (paths.length === 0 || paths.includes('index.html')) return base
  const pick = paths.find(p => /\.html?$/i.test(p)) ?? paths[0]
  return base + (pick as string).split('/').map(encodeURIComponent).join('/')
}

/** `FLING_NO_WAIT=1` skips the wait; so do test runs (VITEST / NODE_ENV=test) by default. */
export function readinessWaitDisabled(env: Record<string, string | undefined>): boolean {
  return env.FLING_NO_WAIT === '1' || env.VITEST === 'true' || env.NODE_ENV === 'test'
}
