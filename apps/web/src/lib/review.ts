/**
 * Review mode, the parts that need no React: the review page's URL, the page the frame is asked
 * for, which threads a page shows and which pins the review shell draws. The shell (on the site's
 * origin) reports where the frame is; these turn that into what the page shows.
 */
import { type BridgePin, type CommentThread, normalizeCommentPath } from '@fling/shared'

/** The app route of a site's review page. */
export function reviewHref(name: string, path?: string): string {
  const base = `/review/${encodeURIComponent(name)}`
  return path && path !== '/' ? `${base}?path=${encodeURIComponent(path)}` : base
}

/** The page path from the `?path=` of a review URL (anything unusable → the home page). */
export function reviewPath(raw: string | null): string {
  return normalizeCommentPath(raw) ?? '/'
}

/** The URL of a page of the site on its own (the "Open" link): `target` may carry a hash. */
export function frameUrl(siteUrl: string, target: string): string {
  return new URL(target.replace(/^\/+/, ''), siteUrl).toString()
}

/** Where the frame is: a comment path (normalised) and the fragment, '' or `#…`. */
export interface FrameLocation {
  path: string
  hash: string
}

/**
 * The page a `?path=` (or the path bar) asks for: its comment path, plus its `#…` fragment so a
 * hash-routed single-page app reopens on the same view. Anything unusable is the home page.
 */
export function reviewTarget(raw: string | null): FrameLocation {
  const value = (raw ?? '').trim()
  const i = value.indexOf('#')
  const hash = i >= 0 ? value.slice(i, i + 1024) : ''
  return { path: reviewPath(i >= 0 ? value.slice(0, i) : value), hash: hash === '#' ? '' : hash }
}

/** A location as the path bar and `?path=` show it. */
export const targetString = (loc: FrameLocation) => `${loc.path}${loc.hash}`

/**
 * The pins the shell draws on the page the frame is on: threads with an anchor on that path and
 * hash route (an anchor without a hash is on the page's plain view), open ones, and resolved ones
 * when they are shown; numbered as in the list.
 */
export function pinsFor(
  threads: readonly CommentThread[],
  at: FrameLocation,
  opts: { showResolved: boolean; selectedId: string | null }
): BridgePin[] {
  const pins: BridgePin[] = []
  threads.forEach((t, i) => {
    const { anchor, path, resolvedAt, id } = t.comment
    if (!anchor || path !== at.path || (anchor.hash ?? '') !== at.hash) return
    if (resolvedAt !== null && !opts.showResolved) return
    pins.push({
      id,
      n: i + 1,
      anchor,
      selected: id === opts.selectedId,
      resolved: resolvedAt !== null,
    })
  })
  return pins
}

/** The threads to show: one page's (or every page's, `path` null), resolved ones on request. */
export function visibleThreads(
  threads: readonly CommentThread[],
  opts: { path: string | null; showResolved: boolean }
): CommentThread[] {
  return threads.filter(
    t =>
      (opts.path === null || t.comment.path === opts.path) &&
      (opts.showResolved || t.comment.resolvedAt === null)
  )
}

/** Open threads per page path, for the "All pages" counts. */
export function openCountsByPath(threads: readonly CommentThread[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of threads) {
    if (t.comment.resolvedAt === null) {
      counts.set(t.comment.path, (counts.get(t.comment.path) ?? 0) + 1)
    }
  }
  return counts
}

/** Where a link the shell stopped goes, for a toast: its host, or the link itself if unparsable. */
export function linkHost(href: string): string {
  try {
    return new URL(href).host || href
  } catch {
    return href
  }
}

/** How many threads are open, on every page: the count on the comments toggle. */
export function openThreadCount(threads: readonly CommentThread[]): number {
  return threads.reduce((n, t) => (t.comment.resolvedAt === null ? n + 1 : n), 0)
}

/**
 * The comments panel as the reviewer last left it in this browser: `open`, `closed`, or `auto`
 * until they choose (shown beside a wide frame, hidden as a sheet over a narrow one).
 */
export type PanelChoice = 'open' | 'closed' | 'auto'

/** The localStorage key of the reviewer's panel choice. */
export const PANEL_CHOICE_KEY = 'reviewCommentsPanel'

/** A stored panel choice; anything else is `auto`. */
export function panelChoice(raw: string | null): PanelChoice {
  return raw === 'open' || raw === 'closed' ? raw : 'auto'
}

/**
 * Whether the comments panel shows. Something that points at a thread (a `?thread=` link, a pin
 * clicked in the page) reveals it for this visit without changing the stored choice. With no
 * choice, it shows beside the frame and starts hidden when it would be a sheet over the site.
 */
export function panelOpen(opts: {
  choice: PanelChoice
  revealed: boolean
  sheet: boolean
}): boolean {
  if (opts.revealed) return true
  return opts.choice === 'auto' ? !opts.sheet : opts.choice === 'open'
}
