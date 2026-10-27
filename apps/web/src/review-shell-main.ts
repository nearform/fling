/**
 * The review shell (vite.review-shell.config.ts → dist-review/review-shell.html), served on every
 * sites host as /_fling/review.html. The review page (app origin) frames it; it frames the site,
 * on the site's own origin, so it can see what the review page can't and report it over the review
 * bridge (@fling/shared/review-bridge):
 *
 * - where the frame is: path, hash route and title, on every load, hash change, history step and
 *   SPA pushState/replaceState (wrapped again on every load, since each load is a new window);
 * - it keeps the frame on the site: a link or form to another origin does nothing and is reported
 *   (`blocked`; the page offers to open it in a new tab, on the reviewer's own click), same-origin
 *   `_top`/`_parent` links stay in the frame, and a load it cannot read (another origin) or of the
 *   shell itself is undone;
 * - pins: placed on a click (the element under it, as an anchor) or a drag (a box, on the
 *   element that holds it), drawn where their anchors resolve now, following scroll, resizes and
 *   DOM changes; the selected one also outlines its area or highlights its quoted text; clicking
 *   one tells the page;
 * - text the reviewer selects in the page, as an anchor with its quote (`textSelected`; the page
 *   decides whether it becomes the new comment's pin);
 * - this reviewer's pointer, as an anchor, and other reviewers' pointers, drawn like pins.
 *
 * It trusts only messages from the app origin its `fling-app-origin` meta names, and talks only to
 * that origin. It holds no data: everything it draws, the page sends. Opened on its own (not in a
 * frame) it goes to the page it was asked to frame.
 */
import { normalizeCommentPath } from '@fling/shared/comments'
import {
  type BridgeCursor,
  type BridgePin,
  PageMessageSchema,
  shellMessage,
} from '@fling/shared/review-bridge'
import { LIVE_CURSOR_INTERVAL_MS } from '@fling/shared/review-live'
import { notFoundAppOrigin } from './lib/app-origin'
import {
  anchorFor,
  type Box,
  buildSelector,
  framedPath,
  leavesSite,
  locateQuote,
  resolveAnchor,
  type Viewport,
} from './lib/review-shell'
import './review-shell.css'

const origin = window.location.origin
const appOrigin = notFoundAppOrigin(
  document.querySelector('meta[name="fling-app-origin"]')?.getAttribute('content'),
  window.location
)
const start = framedPath(new URLSearchParams(window.location.search).get('path'), origin)

const frame = document.getElementById('site') as HTMLIFrameElement
const overlay = document.getElementById('overlay') as HTMLDivElement
const placer = document.getElementById('placer') as HTMLButtonElement
const marquee = document.getElementById('marquee') as HTMLDivElement

let pins: BridgePin[] = []
let cursors: BridgeCursor[] = []
let placing = false
let lastGood = start
let undone = 0
let pendingFocus: string | null = null
const pinEls = new Map<string, HTMLButtonElement>()
const areaEls = new Map<string, HTMLDivElement>()
const cursorEls = new Map<string, HTMLDivElement>()

const post = (m: Parameters<typeof shellMessage>[0]) =>
  window.parent.postMessage(shellMessage(m), appOrigin)

/** The framed site's window, when it is on this origin and is not the shell; else null. */
function site(): Window | null {
  try {
    const win = frame.contentWindow
    if (!win || win.location.origin !== origin) return null
    if (win.location.pathname === window.location.pathname) return null
    return win.document ? win : null
  } catch {
    return null
  }
}

const viewOf = (win: Window): Viewport => ({
  width: win.innerWidth,
  height: win.innerHeight,
  scrollX: win.scrollX,
  scrollY: win.scrollY,
})

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function finder(doc: Document) {
  return (selector: string): Box | null => {
    try {
      const el = doc.querySelector(selector)
      return el ? boxOf(el) : null
    } catch {
      return null
    }
  }
}

function unique(doc: Document) {
  return (selector: string) => {
    try {
      return doc.querySelectorAll(selector).length === 1
    } catch {
      return false
    }
  }
}

/** The boxes of `quote`'s lines inside the element `selector` finds; null when it isn't there. */
function quoteFinder(doc: Document) {
  return (selector: string, quote: string): Box[] | null => {
    let root: Element | null
    try {
      root = doc.querySelector(selector)
    } catch {
      return null
    }
    if (!root) return null
    const nodes: Text[] = []
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    const found = locateQuote(
      nodes.map(n => n.data),
      quote
    )
    if (!found) return null
    const range = doc.createRange()
    const [startNode, endNode] = [nodes[found.start[0]], nodes[found.end[0]]]
    if (!startNode || !endNode) return null
    range.setStart(startNode, found.start[1])
    range.setEnd(endNode, found.end[1])
    const rects = [...range.getClientRects()]
      .filter(r => r.width > 0 && r.height > 0)
      .slice(0, 100)
      .map(r => ({ left: r.left, top: r.top, width: r.width, height: r.height }))
    return rects.length ? rects : null
  }
}

/** The element and selector an anchor records, unless it is the document itself. */
function described(doc: Document, el: Element | null) {
  const selector = el && el !== doc.documentElement ? buildSelector(el, unique(doc)) : undefined
  return el && selector ? { selector, box: boxOf(el) } : null
}

/** The anchor for a point in the frame's viewport: the element under it, its box and the view. */
function anchorAt(win: Window, clientX: number, clientY: number) {
  const doc = win.document
  return anchorFor(
    { clientX, clientY },
    viewOf(win),
    win.location.hash,
    described(doc, doc.elementFromPoint(clientX, clientY))
  )
}

const holds = (outer: Box, inner: Box) =>
  outer.left <= inner.left &&
  outer.top <= inner.top &&
  outer.left + outer.width >= inner.left + inner.width &&
  outer.top + outer.height >= inner.top + inner.height

/** The anchor for a box drawn in the frame's viewport: on the innermost element that holds it. */
function anchorForBox(win: Window, box: Box) {
  const doc = win.document
  let el = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  while (el && el !== doc.body && !holds(boxOf(el), box)) el = el.parentElement
  return anchorFor(
    { clientX: box.left, clientY: box.top, width: box.width, height: box.height },
    viewOf(win),
    win.location.hash,
    described(doc, el)
  )
}

/** The anchor for the text selected in the page, with its quote; null when nothing is. */
function selectionAnchor(win: Window) {
  const selection = win.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const quote = selection.toString()
  if (!quote.trim()) return null
  const range = selection.getRangeAt(0)
  const r = range.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  const common = range.commonAncestorContainer
  const el = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement
  return anchorFor(
    { clientX: r.left, clientY: r.top, width: r.width, height: r.height },
    viewOf(win),
    win.location.hash,
    described(win.document, el),
    quote
  )
}

// --- location and confinement ---------------------------------------------------------------

function report() {
  const win = site()
  if (!win) return
  const loc = win.location
  lastGood = `${loc.pathname}${loc.search}${loc.hash}`
  post({
    type: 'location',
    path: normalizeCommentPath(loc.pathname) ?? '/',
    hash: loc.hash.slice(0, 1024),
    title: win.document.title.slice(0, 300),
  })
  scheduleDraw()
}

function onClick(e: MouseEvent) {
  const target = e.target as Element | null
  const link = target?.closest?.('a[href], area[href]')
  if (!link || e.defaultPrevented) return
  let href: string
  try {
    href = new URL(link.getAttribute('href') ?? '', link.ownerDocument.baseURI).href
  } catch {
    return
  }
  if (leavesSite(href, origin)) {
    e.preventDefault()
    post({ type: 'blocked', href: href.slice(0, 2048) })
    return
  }
  const where = (link.getAttribute('target') ?? '').toLowerCase()
  if (where === '_top' || where === '_parent') {
    e.preventDefault()
    site()?.location.assign(href)
  }
}

function onSubmit(e: SubmitEvent) {
  const form = e.target as HTMLFormElement
  const action = e.submitter?.getAttribute('formaction') || form.action
  if (leavesSite(action, origin)) {
    e.preventDefault()
    post({ type: 'blocked', href: action.slice(0, 2048) })
  }
}

// --- selecting text -----------------------------------------------------------------------------

let lastQuote = ''
let selectionTimer: ReturnType<typeof setTimeout> | undefined

/** Report a finished text selection (after the pointer or a key lets go), once per selection. */
function checkSelection() {
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    const win = site()
    if (!win || placing) return
    const anchor = selectionAnchor(win)
    const key = anchor ? `${anchor.selector}|${anchor.quote}|${anchor.docX},${anchor.docY}` : ''
    if (key === lastQuote) return
    lastQuote = key
    if (anchor) post({ type: 'textSelected', anchor })
  }, 50)
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (placing) {
    setPlacing(false)
    post({ type: 'pinCancelled' })
  } else post({ type: 'escape' })
}

/** Hook into a freshly loaded page of the site. */
function attach(win: Window) {
  const doc = win.document
  const history = win.history
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method]
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      original.apply(this, args)
      report()
    }
  }
  win.addEventListener('hashchange', report)
  win.addEventListener('popstate', report)
  win.addEventListener('scroll', scheduleDraw, { passive: true })
  win.addEventListener('resize', scheduleDraw)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('submit', onSubmit, true)
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('pointerup', checkSelection)
  doc.addEventListener('keyup', checkSelection)
  doc.addEventListener('pointermove', e => trackCursor(e.clientX, e.clientY), { passive: true })
  doc.documentElement.addEventListener('pointerleave', () => trackCursor(null))
  const RO = (win as unknown as typeof globalThis).ResizeObserver
  const MO = (win as unknown as typeof globalThis).MutationObserver
  if (RO) new RO(scheduleDraw).observe(doc.documentElement)
  if (MO) {
    new MO(scheduleDraw).observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
  }
}

frame.addEventListener('load', () => {
  const win = site()
  if (!win) {
    // Another origin (or the shell itself) got into the frame: go back to the last page of the
    // site, and to the home page if that keeps failing.
    undone++
    frame.src = undone > 2 ? '/' : lastGood
    return
  }
  undone = 0
  attach(win)
  report()
})

// --- pins and cursors ---------------------------------------------------------------------------

let drawQueued = false
function scheduleDraw() {
  if (drawQueued) return
  drawQueued = true
  requestAnimationFrame(() => {
    drawQueued = false
    draw()
  })
}

function place(el: HTMLElement, x: number, y: number, view: Viewport) {
  const off = x < -32 || y < -32 || x > view.width + 32 || y > view.height + 32
  el.hidden = off
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

/** Outline a pin's area (a drawn box, or one box per line of quoted text); none: remove it. */
function drawArea(pin: BridgePin, rects: Box[] | undefined) {
  let el = areaEls.get(pin.id)
  if (!rects?.length) {
    el?.remove()
    areaEls.delete(pin.id)
    return
  }
  if (!el) {
    el = document.createElement('div')
    overlay.prepend(el)
    areaEls.set(pin.id, el)
  }
  el.className = `area ${pin.anchor.quote ? 'quote' : 'box'}`
  el.classList.toggle('resolved', pin.resolved)
  while (el.children.length > rects.length) el.lastElementChild?.remove()
  while (el.children.length < rects.length) el.append(document.createElement('i'))
  rects.forEach((r, i) => {
    const part = el.children[i] as HTMLElement
    part.style.transform = `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`
    part.style.width = `${Math.round(r.width)}px`
    part.style.height = `${Math.round(r.height)}px`
  })
}

function draw() {
  const win = site()
  if (!win) {
    for (const el of [...pinEls.values(), ...areaEls.values(), ...cursorEls.values()]) {
      el.hidden = true
    }
    return
  }
  const view = viewOf(win)
  const find = finder(win.document)
  const findQuote = quoteFinder(win.document)
  for (const el of areaEls.values()) el.hidden = false

  const seen = new Set<string>()
  for (const pin of pins) {
    seen.add(pin.id)
    let el = pinEls.get(pin.id)
    if (!el) {
      el = document.createElement('button')
      el.type = 'button'
      el.className = 'pin'
      const id = pin.id
      el.addEventListener('click', () => post({ type: 'pinClicked', id }))
      overlay.append(el)
      pinEls.set(pin.id, el)
    }
    el.textContent = String(pin.n)
    el.classList.toggle('selected', pin.selected)
    el.classList.toggle('resolved', pin.resolved)
    el.setAttribute('aria-label', `Comment ${pin.n}`)
    const at = resolveAnchor(pin.anchor, view, find, findQuote)
    place(el, at.x, at.y, view)
    // Only the selected pin shows its area: a page full of boxes and highlights hides the site.
    drawArea(pin, pin.selected ? at.rects : undefined)
  }
  for (const [id, el] of pinEls) {
    if (!seen.has(id)) {
      el.remove()
      pinEls.delete(id)
    }
  }
  for (const [id, el] of areaEls) {
    if (!seen.has(id)) {
      el.remove()
      areaEls.delete(id)
    }
  }

  seen.clear()
  for (const cursor of cursors) {
    seen.add(cursor.id)
    let el = cursorEls.get(cursor.id)
    const fresh = !el
    if (!el) {
      // A pointer that just appeared materialises: a ripple of their colour where it lands and
      // the name sliding in (styles: .cursor.enter).
      el = document.createElement('div')
      el.className = 'cursor enter'
      el.innerHTML =
        '<i class="ripple"></i><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 1l5.5 14 2-5.5 5.5-2z" fill="currentColor" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span></span>'
      cursorEls.set(cursor.id, el)
    }
    const label = el.querySelector('span')
    if (label) label.textContent = cursor.name
    if (/^[#\w(). %,/-]+$/.test(cursor.colour)) el.style.setProperty('--c', cursor.colour)
    const at = resolveAnchor(cursor.anchor, view, find)
    place(el, at.x, at.y, view)
    if (fresh) overlay.append(el)
  }
  for (const [id, el] of cursorEls) {
    if (!seen.has(id)) {
      // Gone (off the page, or out of the room): fade out, then go.
      cursorEls.delete(id)
      el.classList.remove('enter')
      el.classList.add('leaving')
      const remove = () => el.remove()
      el.addEventListener('animationend', remove, { once: true })
      setTimeout(remove, 500)
    }
  }
}

/** Scroll a pin into view and pulse it; false when it isn't drawn (yet). */
function focusPin(id: string): boolean {
  const win = site()
  const pin = pins.find(p => p.id === id)
  if (!win || !pin) return false
  const view = viewOf(win)
  const at = resolveAnchor(pin.anchor, view, finder(win.document), quoteFinder(win.document))
  if (at.inDocument && (at.y < 0 || at.y > view.height || at.x < 0 || at.x > view.width)) {
    win.scrollTo({
      left: Math.max(0, view.scrollX + at.x - view.width / 2),
      top: Math.max(0, view.scrollY + at.y - view.height / 2),
      behavior: 'smooth',
    })
  }
  draw()
  const el = pinEls.get(id)
  if (el) {
    el.classList.remove('pulse')
    void el.offsetWidth
    el.classList.add('pulse')
  }
  return true
}

overlay.addEventListener('animationend', e => (e.target as Element).classList.remove('pulse'))

// --- this reviewer's pointer -----------------------------------------------------------------

let lastSent = 0
let cursorTimer: ReturnType<typeof setTimeout> | undefined
let latest: { x: number; y: number } | null = null

function sendCursor() {
  cursorTimer = undefined
  lastSent = Date.now()
  const win = site()
  post({ type: 'cursor', anchor: win && latest ? anchorAt(win, latest.x, latest.y) : null })
}

function trackCursor(x: number | null, y?: number) {
  latest = x === null || y === undefined ? null : { x, y }
  if (cursorTimer) return
  const wait = LIVE_CURSOR_INTERVAL_MS - (Date.now() - lastSent)
  if (wait <= 0) sendCursor()
  else cursorTimer = setTimeout(sendCursor, wait)
}

// --- placing a pin ------------------------------------------------------------------------------

/** How far the pointer moves, in CSS px, before a click becomes a drawn box. */
const DRAG_MIN = 6

let dragFrom: { x: number; y: number } | null = null

function setPlacing(on: boolean) {
  placing = on
  placer.hidden = !on
  dragFrom = null
  marquee.hidden = true
  if (on) placer.focus()
}

function dragBox(e: PointerEvent): Box | null {
  if (!dragFrom) return null
  const box = {
    left: Math.min(dragFrom.x, e.clientX),
    top: Math.min(dragFrom.y, e.clientY),
    width: Math.abs(e.clientX - dragFrom.x),
    height: Math.abs(e.clientY - dragFrom.y),
  }
  return box.width < DRAG_MIN && box.height < DRAG_MIN ? null : box
}

// A click places a spot; a drag draws a box.
placer.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  dragFrom = { x: e.clientX, y: e.clientY }
  placer.setPointerCapture(e.pointerId)
})
placer.addEventListener(
  'pointermove',
  e => {
    trackCursor(e.clientX, e.clientY)
    const box = dragBox(e)
    marquee.hidden = !box
    if (box) {
      marquee.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`
      marquee.style.width = `${Math.round(box.width)}px`
      marquee.style.height = `${Math.round(box.height)}px`
    }
  },
  { passive: true }
)
placer.addEventListener('pointerup', e => {
  if (!dragFrom) return
  const box = dragBox(e)
  const win = site()
  setPlacing(false)
  if (!win) return
  const anchor = box ? anchorForBox(win, box) : anchorAt(win, e.clientX, e.clientY)
  post({ type: 'pinPlaced', anchor })
})
placer.addEventListener('pointercancel', () => {
  dragFrom = null
  marquee.hidden = true
})
document.addEventListener('keydown', onKey)

// --- the page's messages ------------------------------------------------------------------------

window.addEventListener('message', e => {
  if (e.origin !== appOrigin || e.source !== window.parent) return
  const parsed = PageMessageSchema.safeParse(e.data)
  if (!parsed.success) return
  const m = parsed.data
  switch (m.type) {
    case 'navigate': {
      undone = 0
      const win = site()
      const to = framedPath(m.path, origin)
      if (win) win.location.assign(to)
      else frame.src = to
      break
    }
    case 'reload':
      site()?.location.reload()
      break
    case 'placing':
      setPlacing(m.on)
      break
    case 'pins':
      pins = m.pins
      draw()
      if (pendingFocus && focusPin(pendingFocus)) pendingFocus = null
      break
    case 'focusPin':
      pendingFocus = focusPin(m.id) ? null : m.id
      break
    case 'cursors':
      cursors = m.cursors
      scheduleDraw()
      break
  }
})

if (window.parent === window) {
  window.location.replace(start)
} else {
  frame.src = start
  post({ type: 'ready' })
}
