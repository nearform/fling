import type { Comment, CommentThread } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  frameUrl,
  linkHost,
  openCountsByPath,
  pinsFor,
  reviewHref,
  reviewPath,
  reviewTarget,
  targetString,
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

  it('reads the page and its hash route from ?path=', () => {
    expect(reviewTarget(null)).toEqual({ path: '/', hash: '' })
    expect(reviewTarget('/app/index.html#/settings?tab=2')).toEqual({
      path: '/app/',
      hash: '#/settings?tab=2',
    })
    expect(reviewTarget('/docs/#')).toEqual({ path: '/docs/', hash: '' })
    expect(targetString(reviewTarget('/a/#x'))).toBe('/a/#x')
  })

  const thread = (
    id: string,
    path: string,
    resolved = false,
    anchor: Comment['anchor'] = null
  ): CommentThread => ({
    comment: {
      id,
      parentId: null,
      path,
      versionId: null,
      anchor,
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

  it("pins the threads on the frame's page and hash route, numbered as listed", () => {
    const threads = [
      thread('a', '/', false, { x: 1, y: 2 }),
      thread('b', '/', false, { x: 3, y: 4, hash: '#/x' }),
      thread('c', '/', true, { x: 5, y: 6 }),
      thread('d', '/docs/', false, { x: 7, y: 8 }),
      thread('e', '/'),
    ]
    const at = (path: string, hash: string, showResolved = false) =>
      pinsFor(threads, { path, hash }, { showResolved, selectedId: 'c' }).map(p => [
        p.id,
        p.n,
        p.selected,
        p.resolved,
      ])
    expect(at('/', '')).toEqual([['a', 1, false, false]])
    expect(at('/', '', true)).toEqual([
      ['a', 1, false, false],
      ['c', 3, true, true],
    ])
    expect(at('/', '#/x')).toEqual([['b', 2, false, false]])
    expect(at('/docs/', '')).toEqual([['d', 4, false, false]])
  })

  it('names where a stopped link goes by its host', () => {
    expect(linkHost('https://example.com/a?b')).toBe('example.com')
    expect(linkHost('http://fling.lvh.me:47100/')).toBe('fling.lvh.me:47100')
    expect(linkHost('not a url')).toBe('not a url')
  })
})
