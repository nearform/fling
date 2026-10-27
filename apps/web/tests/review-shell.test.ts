import { CommentAnchorSchema } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  anchorFor,
  buildSelector,
  framedPath,
  leavesSite,
  locateQuote,
  resolveAnchor,
  type SelectorNode,
} from '../src/lib/review-shell'

/** A tiny element tree: enough of the DOM for buildSelector. */
function el(
  tagName: string,
  attrs: Record<string, string> = {},
  children: SelectorNode[] = []
): SelectorNode {
  const node: SelectorNode = {
    tagName: tagName.toUpperCase(),
    id: attrs.id ?? '',
    getAttribute: name => attrs[name] ?? null,
    parentElement: null,
    previousElementSibling: null,
  }
  let prev: SelectorNode | null = null
  for (const child of children) {
    child.parentElement = node
    child.previousElementSibling = prev
    prev = child
  }
  return node
}

const always = () => true

describe('buildSelector', () => {
  it('stops at the nearest unique id, with an nth-of-type chain below it', () => {
    const target = el('span')
    el('html', {}, [
      el('body', {}, [el('main', { id: 'content' }, [el('p'), el('p', {}, [el('em'), target])])]),
    ])
    expect(buildSelector(target, always)).toBe('#content > p:nth-of-type(2) > span:nth-of-type(1)')
  })

  it('skips an id that is not unique, and quotes one that is not a plain identifier', () => {
    const dup = el('b')
    el('html', {}, [el('body', {}, [el('div', { id: 'x' }, [dup])])])
    expect(buildSelector(dup, s => s !== '#x')).toBe('body > div:nth-of-type(1) > b:nth-of-type(1)')

    const odd = el('i', { id: '1 "a"' })
    el('html', {}, [el('body', {}, [odd])])
    expect(buildSelector(odd, always)).toBe('[id="1 \\"a\\""]')
  })

  it('uses a unique data-testid when there is no id', () => {
    const btn = el('button')
    el('html', {}, [el('body', {}, [el('section', { 'data-testid': 'hero' }, [btn])])])
    expect(buildSelector(btn, always)).toBe('section[data-testid="hero"] > button:nth-of-type(1)')
  })

  it('gives up on a selector longer than an anchor holds', () => {
    const leaf = el('div')
    let root = leaf
    for (let i = 0; i < 40; i++) root = el('div', {}, [root])
    el('html', {}, [el('body', {}, [root])])
    expect(buildSelector(leaf, always)).toBeUndefined()
  })
})

describe('anchors', () => {
  const view = { width: 1000, height: 500, scrollX: 0, scrollY: 1200 }

  it('records the element, the point inside it, the document point, scroll, viewport and hash', () => {
    const anchor = anchorFor({ clientX: 250, clientY: 100 }, view, '#/settings', {
      selector: '#card',
      box: { left: 200, top: 50, width: 200, height: 100 },
    })
    expect(anchor).toEqual({
      x: 25,
      y: 20,
      docX: 250,
      docY: 1300,
      scrollX: 0,
      scrollY: 1200,
      vw: 1000,
      vh: 500,
      hash: '#/settings',
      selector: '#card',
      ex: 25,
      ey: 50,
    })
    expect(CommentAnchorSchema.parse(anchor)).toEqual(anchor)
  })

  it('resolves through the element first, wherever it now is', () => {
    const anchor = anchorFor({ clientX: 250, clientY: 100 }, view, '', {
      selector: '#card',
      box: { left: 200, top: 50, width: 200, height: 100 },
    })
    // a narrower screen, scrolled elsewhere: the card moved and grew
    const now = { width: 400, height: 800, scrollX: 0, scrollY: 0 }
    expect(
      resolveAnchor(anchor, now, () => ({ left: 10, top: 600, width: 380, height: 200 }))
    ).toEqual({ x: 105, y: 700, inDocument: true })
  })

  it('falls back to the document point when the element is gone or has no box', () => {
    const anchor = anchorFor({ clientX: 250, clientY: 100 }, view, '', {
      selector: '#gone',
      box: { left: 0, top: 0, width: 1, height: 1 },
    })
    const now = { width: 1000, height: 500, scrollX: 0, scrollY: 1000 }
    expect(resolveAnchor(anchor, now, () => null)).toEqual({ x: 250, y: 300, inDocument: true })
    expect(resolveAnchor(anchor, now, () => ({ left: 0, top: 0, width: 0, height: 0 }))).toEqual({
      x: 250,
      y: 300,
      inDocument: true,
    })
  })

  it('records an area as its top-left spot and its size, in the element and the document', () => {
    const anchor = anchorFor(
      { clientX: 250, clientY: 100, width: 100, height: 25 },
      view,
      '',
      { selector: '#card', box: { left: 200, top: 50, width: 200, height: 100 } },
      '  The   heading\n is too big '
    )
    expect(anchor).toMatchObject({
      ex: 25,
      ey: 50,
      ew: 50,
      eh: 25,
      docX: 250,
      docY: 1300,
      docW: 100,
      docH: 25,
      quote: 'The heading is too big',
    })
    expect(CommentAnchorSchema.parse(anchor)).toEqual(anchor)
    expect(
      anchorFor({ clientX: 1, clientY: 1 }, view, '', null, 'x'.repeat(900)).quote
    ).toHaveLength(500)
  })

  it('resolves an area through the element, scaling with it, then the document', () => {
    const anchor = anchorFor({ clientX: 250, clientY: 100, width: 100, height: 25 }, view, '', {
      selector: '#card',
      box: { left: 200, top: 50, width: 200, height: 100 },
    })
    const now = { width: 400, height: 800, scrollX: 0, scrollY: 0 }
    expect(
      resolveAnchor(anchor, now, () => ({ left: 0, top: 600, width: 400, height: 200 }))
    ).toEqual({
      x: 100,
      y: 700,
      inDocument: true,
      rects: [{ left: 100, top: 700, width: 200, height: 50 }],
    })
    expect(resolveAnchor(anchor, { ...now, scrollY: 1000 }, () => null)).toEqual({
      x: 250,
      y: 300,
      inDocument: true,
      rects: [{ left: 250, top: 300, width: 100, height: 25 }],
    })
  })

  it('resolves quoted text to its lines first, and to the area when the text has changed', () => {
    const anchor = anchorFor(
      { clientX: 250, clientY: 100, width: 100, height: 25 },
      view,
      '',
      { selector: '#card', box: { left: 200, top: 50, width: 200, height: 100 } },
      'is too big'
    )
    const card = () => ({ left: 200, top: 50, width: 200, height: 100 })
    const lines = [
      { left: 210, top: 60, width: 80, height: 16 },
      { left: 200, top: 76, width: 30, height: 16 },
    ]
    expect(resolveAnchor(anchor, view, card, () => lines)).toEqual({
      x: 210,
      y: 60,
      inDocument: true,
      rects: lines,
    })
    expect(resolveAnchor(anchor, view, card, () => null).rects).toEqual([
      { left: 250, top: 100, width: 100, height: 25 },
    ])
  })

  it('places an x/y-only anchor in the viewport', () => {
    expect(resolveAnchor({ x: 50, y: 10 }, view, () => null)).toEqual({
      x: 500,
      y: 50,
      inDocument: false,
    })
  })
})

describe('locateQuote', () => {
  it('finds a quote across text nodes, ignoring how whitespace differs', () => {
    // <p>The <em>quick</em></p><p>brown fox</p>: the selection reads "quick\n\nbrown"
    const texts = ['The ', 'quick', 'brown fox']
    expect(locateQuote(texts, 'quick\n\nbrown')).toEqual({ start: [1, 0], end: [2, 5] })
    expect(locateQuote(texts, 'fox')).toEqual({ start: [2, 6], end: [2, 9] })
  })

  it('is null for text that is not there, or only whitespace', () => {
    expect(locateQuote(['The quick'], 'slow')).toBeNull()
    expect(locateQuote(['The quick'], ' \n ')).toBeNull()
  })
})

describe('framedPath', () => {
  const origin = 'https://deck.sites.example.test'

  it('keeps a path on this origin, with its query and hash', () => {
    expect(framedPath('/docs/?a=1#/b', origin)).toBe('/docs/?a=1#/b')
    expect(framedPath('/', origin)).toBe('/')
  })

  it('never leaves the origin or frames the shell itself', () => {
    for (const raw of [
      null,
      '',
      'docs/',
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      'javascript:alert(1)',
      '/_fling/review.html?path=/',
    ]) {
      expect(framedPath(raw, origin)).toBe('/')
    }
  })
})

describe('leavesSite', () => {
  const origin = 'https://deck.sites.example.test'
  it('is true only for http(s) on another origin', () => {
    expect(leavesSite('https://fling.example.test/', origin)).toBe(true)
    expect(leavesSite('http://deck.sites.example.test/', origin)).toBe(true)
    expect(leavesSite('/next.html', origin)).toBe(false)
    expect(leavesSite(`${origin}/a`, origin)).toBe(false)
    expect(leavesSite('mailto:a@example.test', origin)).toBe(false)
  })
})
