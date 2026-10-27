/**
 * The review shell's geometry, with no DOM of its own: which path it may frame, how a spot or an
 * area on a page becomes an anchor (a selector for the element, the spot and size inside that
 * element, the document point and size, the scroll and viewport, selected text) and how an anchor
 * becomes a point and area on screen again. The shell (review-shell-main.ts) feeds it the frame's
 * live elements; tests feed it plain objects.
 */
import { ANCHOR_QUOTE_MAX, ANCHOR_SELECTOR_MAX, type CommentAnchor } from '@fling/shared/comments'
import { REVIEW_SHELL } from '@fling/shared/route-keys'

/** The parts of an element a selector is built from. */
export interface SelectorNode {
  tagName: string
  id: string
  getAttribute(name: string): string | null
  parentElement: SelectorNode | null
  previousElementSibling: SelectorNode | null
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  /** the frame's viewport, CSS px */
  width: number
  height: number
  scrollX: number
  scrollY: number
}

const SIMPLE_IDENT = /^-?[A-Za-z_][\w-]*$/

const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`

function nthOfType(node: SelectorNode): string {
  const tag = node.tagName.toLowerCase()
  let n = 1
  for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.tagName === node.tagName) n++
  }
  return `${tag}:nth-of-type(${n})`
}

/**
 * A CSS selector for `node` that survives other reviewers' screens: the nearest ancestor (or the
 * node) with an id, else one with a `data-testid`, when it names one element in the document
 * (`unique`); below it, an `nth-of-type` chain. Undefined when it would be longer than an anchor
 * may hold.
 */
export function buildSelector(
  node: SelectorNode,
  unique: (selector: string) => boolean
): string | undefined {
  const parts: string[] = []
  for (let cur: SelectorNode | null = node; cur; cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase()
    if (tag === 'html') break
    if (tag === 'body') {
      parts.unshift('body')
      break
    }
    if (cur.id) {
      const byId = SIMPLE_IDENT.test(cur.id) ? `#${cur.id}` : `[id=${quoted(cur.id)}]`
      if (unique(byId)) {
        parts.unshift(byId)
        break
      }
    }
    const testId = cur.getAttribute('data-testid')
    if (testId) {
      const byTestId = `${tag}[data-testid=${quoted(testId)}]`
      if (unique(byTestId)) {
        parts.unshift(byTestId)
        break
      }
    }
    parts.unshift(nthOfType(cur))
  }
  const selector = parts.join(' > ')
  return selector && selector.length <= ANCHOR_SELECTOR_MAX ? selector : undefined
}

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (offset: number, size: number) =>
  size > 0 ? round1(Math.min(100, Math.max(0, (offset / size) * 100))) : 0

/**
 * The anchor for a spot at (`clientX`, `clientY`) in the frame's viewport, or an area with that
 * top-left corner (`width`, `height`), on `element` (its box in the same coordinates, found by
 * `selector`) when there is one. `quote` is the text selected there.
 */
export function anchorFor(
  point: { clientX: number; clientY: number; width?: number; height?: number },
  view: Viewport,
  hash: string,
  element?: { selector: string; box: Box } | null,
  quote?: string
): CommentAnchor {
  const anchor: CommentAnchor = {
    x: pct(point.clientX, view.width),
    y: pct(point.clientY, view.height),
    docX: Math.round(point.clientX + view.scrollX),
    docY: Math.round(point.clientY + view.scrollY),
    scrollX: Math.round(view.scrollX),
    scrollY: Math.round(view.scrollY),
    vw: Math.round(view.width),
    vh: Math.round(view.height),
  }
  if (hash) anchor.hash = hash.slice(0, 1024)
  const area = point.width !== undefined && point.height !== undefined
  if (area) {
    anchor.docW = Math.round(Math.max(0, point.width ?? 0))
    anchor.docH = Math.round(Math.max(0, point.height ?? 0))
  }
  if (element) {
    anchor.selector = element.selector
    anchor.ex = pct(point.clientX - element.box.left, element.box.width)
    anchor.ey = pct(point.clientY - element.box.top, element.box.height)
    if (area) {
      anchor.ew = pct(point.width ?? 0, element.box.width)
      anchor.eh = pct(point.height ?? 0, element.box.height)
    }
  }
  const text = quote?.replace(/\s+/g, ' ').trim().slice(0, ANCHOR_QUOTE_MAX).trim()
  if (text) anchor.quote = text
  return anchor
}

/** Where an anchor is on screen: its spot, and its area when it has one. */
export interface Resolved {
  x: number
  y: number
  /** a point in the document (it scrolls with the page), not only in the viewport */
  inDocument: boolean
  /** the area's boxes: one for a drawn box, one per line of quoted text */
  rects?: Box[]
}

/**
 * Where an anchor is now, in the frame's viewport (CSS px), with its area when it has one. Tries,
 * in order: its quote inside the element its selector finds (`findQuote`, the boxes of the text's
 * lines), the element (`find`, a box in viewport coordinates; an element with no box counts as
 * missing), the document point, the viewport percentages (a point only in the viewport).
 */
export function resolveAnchor(
  anchor: CommentAnchor,
  view: Viewport,
  find: (selector: string) => Box | null,
  findQuote?: (selector: string, quote: string) => Box[] | null
): Resolved {
  if (anchor.selector && anchor.quote && findQuote) {
    const rects = findQuote(anchor.selector, anchor.quote)
    const first = rects?.[0]
    if (rects && first) return { x: first.left, y: first.top, inDocument: true, rects }
  }
  if (anchor.selector) {
    const box = find(anchor.selector)
    if (box && (box.width > 0 || box.height > 0)) {
      const x = box.left + ((anchor.ex ?? 50) / 100) * box.width
      const y = box.top + ((anchor.ey ?? 50) / 100) * box.height
      if (anchor.ew === undefined || anchor.eh === undefined) return { x, y, inDocument: true }
      const width = (anchor.ew / 100) * box.width
      const height = (anchor.eh / 100) * box.height
      return { x, y, inDocument: true, rects: [{ left: x, top: y, width, height }] }
    }
  }
  if (anchor.docX !== undefined && anchor.docY !== undefined) {
    const x = anchor.docX - view.scrollX
    const y = anchor.docY - view.scrollY
    if (anchor.docW === undefined || anchor.docH === undefined) return { x, y, inDocument: true }
    return {
      x,
      y,
      inDocument: true,
      rects: [{ left: x, top: y, width: anchor.docW, height: anchor.docH }],
    }
  }
  return {
    x: (anchor.x / 100) * view.width,
    y: (anchor.y / 100) * view.height,
    inDocument: false,
  }
}

/** A position in a list of text nodes: the node's index and the offset in its text. */
export type TextPoint = [node: number, offset: number]

/**
 * Where `quote` is in a run of text nodes (an element's, in document order), from the start of its
 * first character to the end of its last. Whitespace is ignored on both sides: a selection's text
 * and the nodes' text space blocks and line breaks differently. Null when it isn't there.
 */
export function locateQuote(
  texts: readonly string[],
  quote: string
): { start: TextPoint; end: TextPoint } | null {
  const wanted = quote.replace(/\s+/g, '')
  if (!wanted) return null
  let flat = ''
  const at: TextPoint[] = []
  texts.forEach((text, node) => {
    for (let offset = 0; offset < text.length; offset++) {
      const ch = text.charAt(offset)
      if (/\s/.test(ch)) continue
      flat += ch
      at.push([node, offset])
    }
  })
  const i = flat.indexOf(wanted)
  if (i < 0) return null
  const start = at[i]
  const last = at[i + wanted.length - 1]
  if (!start || !last) return null
  return { start, end: [last[0], last[1] + 1] }
}

/**
 * The site-relative URL the shell may frame, from its `?path=`: a path on this origin (query and
 * hash kept), never the shell itself; anything else is the home page.
 */
export function framedPath(raw: string | null, origin: string): string {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  try {
    const url = new URL(raw, origin)
    if (url.origin !== origin || url.pathname === REVIEW_SHELL) return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

/** Whether a link or form target leaves the site: an http(s) URL on another origin. */
export function leavesSite(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin
  } catch {
    return false
  }
}
