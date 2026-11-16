/**
 * Whether the sites' 404 page is standing in for a site that was just published and hasn't
 * reached the edge yet (routes get there eventually, usually within seconds). Only the root page
 * of a host the edge doesn't know asks: `/_fling-version` answers 404 only then, so a missing file
 * on a site that is there never asks. The API (`GET /api/sites/:name/arrival`, with the visitor's
 * session) says whether it is live, theirs to open and changed in the last 30 s. Waiting only
 * probes the edge, never the API, and stops after ARRIVAL_WAIT_MS.
 */
import { SITE_VERSION_PATH } from '@fling/shared/route-keys'

export const ARRIVAL_WAIT_MS = 30_000
export const ARRIVAL_POLL_MS = 2_000

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Whether the edge has this host's site yet: anything but a 404 (a redirect to sign in too). */
export async function atTheEdge(fetchImpl: Fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(SITE_VERSION_PATH, { cache: 'no-store', redirect: 'manual' })
  return res.type === 'opaqueredirect' || res.status !== 404
}

/** Whether to hold, rather than say 404: at `/` of a host the edge lacks, for a site arriving. */
export async function shouldHold(
  appOrigin: string,
  location: Pick<Location, 'pathname' | 'hostname'>,
  fetchImpl: Fetch = fetch
): Promise<boolean> {
  if (location.pathname !== '/') return false
  try {
    if (await atTheEdge(fetchImpl)) return false
    const name = location.hostname.split('.')[0] ?? ''
    const res = await fetchImpl(`${appOrigin}/api/sites/${encodeURIComponent(name)}/arrival`, {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!res.ok) return false
    return (await res.json()).arriving === true
  } catch {
    return false
  }
}

/** Probe the edge until the site is there (true) or ARRIVAL_WAIT_MS has passed (false). */
export async function waitForArrival(
  fetchImpl: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  now: () => number = Date.now
): Promise<boolean> {
  const until = now() + ARRIVAL_WAIT_MS
  while (now() < until) {
    await sleep(ARRIVAL_POLL_MS)
    try {
      if (await atTheEdge(fetchImpl)) return true
    } catch {}
  }
  return false
}
