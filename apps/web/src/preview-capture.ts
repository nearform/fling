/**
 * The preview shell's thumbnail (review-shell-main.ts in preview mode; thumbnails.ts in shared):
 * once the framed home page has loaded, its fonts are ready, the images in view have decoded and
 * it has had a moment to settle, draw what the frame's viewport shows and scale it down to a PNG of
 * at most THUMBNAIL_SIZE, smaller if that is too heavy to upload.
 *
 * It draws the page's DOM with modern-screenshot (an SVG foreignObject of a styled clone, painted
 * on a canvas), which works because the shell is on the site's own origin: it reads the page's
 * styles, fonts and images as the page does. What it cannot read it leaves blank: images and
 * fonts from other origins that don't allow CORS, cross-origin frames, video frames. The library
 * is only in the shell's bundle, never the app's.
 */
import { THUMBNAIL_MAX_BYTES, THUMBNAIL_MIN_SIDE, THUMBNAIL_SIZE } from '@fling/shared/thumbnails'
import { domToCanvas } from 'modern-screenshot'

/** How long the page settles after it has loaded (animations, late layout) before it is drawn. */
const SETTLE_MS = 1200
/** How long fonts and images may take before the page is drawn as it is. */
const WAIT_MS = 5000
/** How long drawing may take altogether. */
const CAPTURE_MS = 20_000

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p, sleep(ms)])

/** Whether the frame holds one of Fling's own pages (the 404 page): nothing to take a picture of. */
export const isFlingPage = (doc: Document) =>
  doc.querySelector('meta[name="fling-app-origin"]') !== null

/** The page's background as the browser paints its canvas: the root's, else the body's, else white. */
function backgroundOf(win: Window): string {
  const doc = win.document
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue
    const bg = win.getComputedStyle(el).backgroundColor
    if (bg && bg !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg
  }
  return '#fff'
}

async function loaded(win: Window) {
  const doc = win.document
  if (doc.readyState !== 'complete') {
    await new Promise(resolve => win.addEventListener('load', resolve, { once: true }))
  }
  const inView = [...doc.images].filter(img => {
    const r = img.getBoundingClientRect()
    return r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth
  })
  await within(
    WAIT_MS,
    Promise.all([doc.fonts?.ready, ...inView.map(img => img.decode().catch(() => undefined))])
  )
  await sleep(SETTLE_MS)
}

function scaled(source: HTMLCanvasElement, width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas to draw on')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

const pngOf = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('The page could not be encoded'))),
      'image/png'
    )
  )

async function draw(win: Window): Promise<Blob> {
  await loaded(win)
  if (isFlingPage(win.document)) throw new Error('The site has no home page')
  const { innerWidth: width, innerHeight: height } = win
  const ratio = Math.min(THUMBNAIL_SIZE.width / width, THUMBNAIL_SIZE.height / height)
  const full = await domToCanvas(win.document.documentElement, {
    width,
    height,
    scale: ratio,
    backgroundColor: backgroundOf(win),
    timeout: WAIT_MS,
  })
  // A busy page (photos) can make a heavy PNG: draw it smaller until it fits.
  for (let factor = 1; ; factor *= 0.75) {
    const w = Math.round(full.width * factor)
    const h = Math.round(full.height * factor)
    if (Math.min(w, h) < THUMBNAIL_MIN_SIDE) throw new Error('The page is too busy to keep small')
    const png = await pngOf(factor === 1 ? full : scaled(full, w, h))
    if (png.size <= THUMBNAIL_MAX_BYTES) return png
  }
}

/** A PNG thumbnail of what the framed page's viewport shows. */
export async function captureThumbnail(win: Window): Promise<Blob> {
  const png = await within(CAPTURE_MS, draw(win))
  if (!png) throw new Error('Drawing the page took too long')
  return png
}
