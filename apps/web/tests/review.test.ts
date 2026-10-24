import type { Comment, CommentThread } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  anchorAt,
  frameUrl,
  openCountsByPath,
  reviewHref,
  reviewPath,
  visibleThreads,
} from '../src/lib/review'

describe('review helpers', () => {
  it('links to a review page, with the page path when it is not the home page', () => {
    expect(reviewHref('deck')).toBe('/review/deck')
    expect(reviewHref('deck', '/')).toBe('/review/deck')
    expect(reviewHref('deck', '/docs/')).toBe('/review/deck?path=%2Fdocs%2F')
  })

  it('reads the page path from the URL, normalized; junk is the home page', () => {
    expect(reviewPath(null)).toBe('/')
    expect(reviewPath('docs/index.html')).toBe('/docs/')
    expect(reviewPath('/a b')).toBe('/')
  })

  it('loads a page of the site in the frame', () => {
    const site = 'https://deck.sites.example.test/'
    expect(frameUrl(site, '/')).toBe(site)
    expect(frameUrl(site, '/docs/a.html')).toBe(`${site}docs/a.html`)
    expect(frameUrl('http://deck.fling.lvh.me:47102/', '/x/')).toBe(
      'http://deck.fling.lvh.me:47102/x/'
    )
  })

  it('turns a click into a pin: percent of the frame, one decimal, clamped', () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 }
    expect(anchorAt(rect, 500, 350)).toEqual({ x: 50, y: 50 })
    expect(anchorAt(rect, 101, 51)).toEqual({ x: 0.1, y: 0.2 })
    expect(anchorAt(rect, 0, 9999)).toEqual({ x: 0, y: 100 })
    expect(anchorAt({ ...rect, width: 0, height: 0 }, 1, 1)).toEqual({ x: 0, y: 0 })
  })

  const thread = (id: string, path: string, resolved = false): CommentThread => ({
    comment: {
      id,
      parentId: null,
      path,
      versionId: null,
      anchor: null,
      body: id,
      author: { kind: 'user', email: 'a@example.test' },
      createdAt: '2026-01-01T00:00:00.000Z',
      resolvedAt: resolved ? '2026-01-02T00:00:00.000Z' : null,
      resolvedBy: null,
      canDelete: false,
    } satisfies Comment,
    replies: [],
  })

  it("shows one page's threads or every page's, resolved ones on request", () => {
    const threads = [thread('a', '/'), thread('b', '/docs/'), thread('c', '/', true)]
    const ids = (ts: CommentThread[]) => ts.map(t => t.comment.id)
    expect(ids(visibleThreads(threads, { path: '/', showResolved: false }))).toEqual(['a'])
    expect(ids(visibleThreads(threads, { path: '/', showResolved: true }))).toEqual(['a', 'c'])
    expect(ids(visibleThreads(threads, { path: null, showResolved: false }))).toEqual(['a', 'b'])
    expect([...openCountsByPath(threads)]).toEqual([
      ['/', 1],
      ['/docs/', 1],
    ])
  })
})
