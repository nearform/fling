import { describe, expect, it } from 'vitest'
import {
  PageMessageSchema,
  pageMessage,
  REVIEW_SHELL_PATH,
  reviewShellUrl,
  ShellMessageSchema,
  shellMessage,
} from '../src/review-bridge.ts'
import { REVIEW_SHELL } from '../src/route-keys.ts'

describe('review bridge', () => {
  it('serves the shell where the routing passes it through', () => {
    expect(REVIEW_SHELL_PATH).toBe(REVIEW_SHELL)
  })

  it("puts the framed path in the shell's URL on the site", () => {
    expect(reviewShellUrl('https://deck.sites.example.test/', '/docs/#/x')).toBe(
      'https://deck.sites.example.test/_fling/review.html?path=%2Fdocs%2F%23%2Fx'
    )
    expect(reviewShellUrl('https://deck.sites.example.test/')).toBe(
      'https://deck.sites.example.test/_fling/review.html?path=%2F'
    )
  })

  it('round-trips tagged messages both ways, old and new anchors alike', () => {
    const shell = [
      shellMessage({ type: 'ready' }),
      shellMessage({ type: 'location', path: '/a/', hash: '#b', title: 'A' }),
      shellMessage({ type: 'pinPlaced', anchor: { x: 1, y: 2, selector: '#a', ex: 3, ey: 4 } }),
      shellMessage({ type: 'cursor', anchor: null }),
      shellMessage({ type: 'blocked', href: 'https://elsewhere.example/' }),
    ]
    for (const m of shell) expect(ShellMessageSchema.parse(m)).toEqual(m)
    const page = [
      pageMessage({ type: 'navigate', path: '/a/#b' }),
      pageMessage({
        type: 'pins',
        pins: [
          { id: 'c1', n: 1, anchor: { x: 5, y: 5 }, selected: false, resolved: false },
          {
            id: 'c2',
            n: 2,
            anchor: { x: 5, y: 5, docY: 900, hash: '#b' },
            selected: true,
            resolved: true,
          },
        ],
      }),
      pageMessage({
        type: 'cursors',
        cursors: [{ id: 'p', name: 'Ada', colour: 'hsl(1 75% 45%)', anchor: { x: 1, y: 1 } }],
      }),
    ]
    for (const m of page) expect(PageMessageSchema.parse(m)).toEqual(m)
  })

  it('ignores untagged, unknown or malformed messages', () => {
    expect(ShellMessageSchema.safeParse({ type: 'ready' }).success).toBe(false)
    expect(ShellMessageSchema.safeParse({ fling: 'review', type: 'nope' }).success).toBe(false)
    expect(
      PageMessageSchema.safeParse({ fling: 'review', type: 'placing', on: 'yes' }).success
    ).toBe(false)
    expect(
      PageMessageSchema.safeParse({
        fling: 'review',
        type: 'pins',
        pins: [{ id: 'x', n: 0, anchor: { x: 1, y: 1 }, selected: false, resolved: false }],
      }).success
    ).toBe(false)
  })
})
