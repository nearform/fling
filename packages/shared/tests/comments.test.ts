import { describe, expect, it } from 'vitest'
import {
  ANCHOR_SELECTOR_MAX,
  authorLabel,
  type Comment,
  CommentAnchorSchema,
  commentThreads,
  normalizeCommentPath,
} from '../src/comments.ts'

describe('normalizeCommentPath', () => {
  it('writes every spelling of a page one way', () => {
    const cases: [string | undefined, string][] = [
      [undefined, '/'],
      ['', '/'],
      ['/', '/'],
      ['index.html', '/'],
      ['/index.html', '/'],
      ['about.html', '/about.html'],
      ['/docs/index.html', '/docs/'],
      ['/docs/', '/docs/'],
      ['/docs', '/docs'],
      ['//docs//a.html', '/docs/a.html'],
      ['/a.html?x=1#top', '/a.html'],
      ['https://hello.sites.example.test/docs/index.html?q=1', '/docs/'],
      ['  /a.html  ', '/a.html'],
    ]
    for (const [input, path] of cases)
      expect({ input, path: normalizeCommentPath(input) }).toEqual({ input, path })
  })

  it('refuses what is not a page path', () => {
    for (const input of ['/a b', '/../x', '/a/./b', `/${'a'.repeat(1024)}`]) {
      expect(normalizeCommentPath(input)).toBeNull()
    }
  })
})

const c = (id: string, parentId: string | null = null): Comment => ({
  id,
  parentId,
  path: '/',
  versionId: null,
  anchor: null,
  body: id,
  author: { kind: 'user', email: 'a@example.test' },
  createdAt: '2026-01-01T00:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  canDelete: false,
})

describe('commentThreads', () => {
  it('groups replies under their thread, in order, and drops orphans', () => {
    const threads = commentThreads([
      c('a'),
      c('b'),
      c('r1', 'a'),
      c('r2', 'b'),
      c('r3', 'a'),
      c('x', 'gone'),
    ])
    expect(threads.map(t => [t.comment.id, t.replies.map(r => r.id)])).toEqual([
      ['a', ['r1', 'r3']],
      ['b', ['r2']],
    ])
  })
})

describe('authorLabel', () => {
  it('shows a user by email and marks guests', () => {
    expect(authorLabel({ kind: 'user', email: 'a@example.test' })).toBe('a@example.test')
    expect(authorLabel({ kind: 'guest', name: 'Pat' })).toBe('Pat (guest)')
  })
})

describe('CommentAnchorSchema', () => {
  it('accepts an x/y-only anchor and one with its full context', () => {
    expect(CommentAnchorSchema.parse({ x: 10, y: 90 })).toEqual({ x: 10, y: 90 })
    const full = {
      x: 25,
      y: 20,
      selector: '#card > p:nth-of-type(2)',
      ex: 25,
      ey: 50,
      docX: 250,
      docY: 1300,
      scrollX: 0,
      scrollY: 1200,
      vw: 1000,
      vh: 500,
      hash: '#/settings',
    }
    expect(CommentAnchorSchema.parse(full)).toEqual(full)
  })

  it('refuses anchors out of range or with an oversized selector', () => {
    for (const bad of [
      { x: 101, y: 0 },
      { y: 0 },
      { x: 0, y: 0, ex: -1 },
      { x: 0, y: 0, selector: '' },
      { x: 0, y: 0, selector: 'a'.repeat(ANCHOR_SELECTOR_MAX + 1) },
      { x: 0, y: 0, docY: Number.POSITIVE_INFINITY },
    ]) {
      expect(CommentAnchorSchema.safeParse(bad).success).toBe(false)
    }
  })
})
