/**
 * Review mode, the parts that need no React: the frame's URL, where a pin lands, which threads
 * a page shows. The review page iframes the site, another origin, so it never learns the frame's
 * path or scroll position: the page owns the path (its path bar), and a pin is a point in the
 * frame's viewport, not in the document.
 */
import { type CommentAnchor, type CommentThread, normalizeCommentPath } from '@fling/shared'

/** The app route of a site's review page. */
export function reviewHref(name: string, path?: string): string {
  const base = `/review/${encodeURIComponent(name)}`
  return path && path !== '/' ? `${base}?path=${encodeURIComponent(path)}` : base
}

/** The page path from the `?path=` of a review URL (anything unusable → the home page). */
export function reviewPath(raw: string | null): string {
  return normalizeCommentPath(raw) ?? '/'
}

/** The URL the frame loads for a page of the site. */
export function frameUrl(siteUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), siteUrl).toString()
}

/** A click in the pin layer as percentages of the frame's viewport, to one decimal. */
export function anchorAt(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): CommentAnchor {
  const pct = (offset: number, size: number) =>
    size > 0 ? Math.round(Math.min(100, Math.max(0, (offset / size) * 100)) * 10) / 10 : 0
  return { x: pct(clientX - rect.left, rect.width), y: pct(clientY - rect.top, rect.height) }
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
