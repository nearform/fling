/**
 * Which version of a site the preview shell's frame shows (review-shell-main.ts in preview mode),
 * so a Thumbnail is only ever kept as the version it is a picture of.
 *
 * The sites host picks the version from a route table that reaches the edge eventually, so for a
 * while after a publish it can serve the previous version while the API reports the new one. A
 * page doesn't say which version it is of (on AWS no header reaches the browser with the files),
 * but the host answers `/_fling-version` (SITE_VERSION_PATH) with the version it serves now. The
 * shell asks before it loads the home page and again once it has loaded: when both answers agree,
 * the page in between was served at that version (the route only moves forward).
 */
import { SITE_VERSION_HEADER, SITE_VERSION_PATH } from '@fling/shared/route-keys'

/** The version the sites host serves now, null when it doesn't say (signed out, gone, offline). */
export async function servedVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(SITE_VERSION_PATH, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    })
    return res.status === 204 ? res.headers.get(SITE_VERSION_HEADER) : null
  } catch {
    return null
  }
}

/** A load of the frame, and the version it shows when the host said the same before and after. */
export interface Loaded<W> {
  win: W
  version: string | null
}

/** Load the frame between two looks at the version the host serves. */
export async function loadAtVersion<W>(
  probe: () => Promise<string | null>,
  load: () => Promise<W>
): Promise<Loaded<W>> {
  const before = await probe()
  const win = await load()
  const after = before === null ? null : await probe()
  return { win, version: before !== null && before === after ? before : null }
}

export type FrameAt<W> = { win: W } | { stale: string | null }

/**
 * The frame showing `expected`: as loaded already when that load was of it; else, when the host
 * serves `expected` now, a fresh load of it. `stale` (with what the host serves) when the host
 * doesn't serve `expected` yet, or the fresh load can't be told to be of it.
 */
export async function frameAt<W>(
  expected: string,
  current: Loaded<W>,
  probe: () => Promise<string | null>,
  reload: () => Promise<Loaded<W>>
): Promise<FrameAt<W>> {
  if (current.version === expected) return { win: current.win }
  const now = await probe()
  if (now !== expected) return { stale: now }
  const fresh = await reload()
  return fresh.version === expected ? { win: fresh.win } : { stale: fresh.version }
}
