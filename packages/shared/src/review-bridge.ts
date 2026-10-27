// The review bridge: the postMessage protocol between the review page (app origin) and the review
// shell (`/_fling/review.html` on the site's own origin). The shell frames the site same-origin,
// so it sees what the review page can't: the page and hash route the frame is on, its scroll, the
// element under a click, the text the reviewer selects. It keeps the frame on the site, places and draws pins and cursors, and
// reports to the page. The page owns the data (comments, the live room) and tells the shell what
// to draw. Browser-safe (zod only).
//
// Each side accepts a message only from the other's origin (the shell: the app origin its meta
// names; the page: the site URL's origin) and parses it with these schemas; anything else is
// ignored. Messages carry `fling: 'review'` so other postMessage traffic is told apart.

import { z } from 'zod'
import { COMMENT_PATH_MAX, CommentAnchorSchema } from './comments.ts'
import { REVIEW_SHELL } from './route-keys.ts'

/** Where the shell serves itself on every site host. */
export const REVIEW_SHELL_PATH = REVIEW_SHELL

const tag = { fling: z.literal('review') }
const path = z.string().max(COMMENT_PATH_MAX)
const hash = z.string().max(COMMENT_PATH_MAX)

/** A pin as the shell draws it: the thread's number in the list and where it is. */
export const BridgePinSchema = z.object({
  id: z.string(),
  n: z.number().int().min(1),
  anchor: CommentAnchorSchema,
  selected: z.boolean(),
  resolved: z.boolean(),
})
export type BridgePin = z.infer<typeof BridgePinSchema>

/** Another reviewer's pointer on the same page. */
export const BridgeCursorSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  colour: z.string().max(32),
  anchor: CommentAnchorSchema,
})
export type BridgeCursor = z.infer<typeof BridgeCursorSchema>

/** shell → page */
export const ShellMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...tag, type: z.literal('ready') }),
  /** the frame is on `path` (normalised, see normalizeCommentPath) with fragment `hash` ('' or '#…') */
  z.object({ ...tag, type: z.literal('location'), path, hash, title: z.string().max(300) }),
  /** a pin placed while placing: a click (a spot) or a drag (a box) */
  z.object({ ...tag, type: z.literal('pinPlaced'), anchor: CommentAnchorSchema }),
  /** the reviewer selected text in the page: an anchor on it, with its quote */
  z.object({ ...tag, type: z.literal('textSelected'), anchor: CommentAnchorSchema }),
  z.object({ ...tag, type: z.literal('pinCancelled') }),
  z.object({ ...tag, type: z.literal('pinClicked'), id: z.string() }),
  /** this reviewer's pointer on the page; null when it left the frame */
  z.object({ ...tag, type: z.literal('cursor'), anchor: CommentAnchorSchema.nullable() }),
  /** a link or form to another origin, stopped: the frame stays on the site */
  z.object({ ...tag, type: z.literal('blocked'), href: z.string().max(2048) }),
  z.object({ ...tag, type: z.literal('escape') }),
])
export type ShellMessage = z.infer<typeof ShellMessageSchema>

/** page → shell */
export const PageMessageSchema = z.discriminatedUnion('type', [
  /** load `path` (site-relative, may carry `?query` and `#hash`) in the frame */
  z.object({ ...tag, type: z.literal('navigate'), path: z.string().max(COMMENT_PATH_MAX * 2) }),
  z.object({ ...tag, type: z.literal('reload') }),
  z.object({ ...tag, type: z.literal('placing'), on: z.boolean() }),
  /** the pins on the frame's current page */
  z.object({ ...tag, type: z.literal('pins'), pins: z.array(BridgePinSchema) }),
  /** scroll the pin into view and draw attention to it */
  z.object({ ...tag, type: z.literal('focusPin'), id: z.string() }),
  z.object({ ...tag, type: z.literal('cursors'), cursors: z.array(BridgeCursorSchema) }),
])
export type PageMessage = z.infer<typeof PageMessageSchema>

type Untagged<T> = T extends unknown ? Omit<T, 'fling'> : never

export function shellMessage(m: Untagged<ShellMessage>): ShellMessage {
  return { fling: 'review', ...m } as ShellMessage
}

export function pageMessage(m: Untagged<PageMessage>): PageMessage {
  return { fling: 'review', ...m } as PageMessage
}

/** The shell's URL on a site, framing `path` (site-relative, may carry query and hash). */
export function reviewShellUrl(siteUrl: string, path = '/'): string {
  const url = new URL(REVIEW_SHELL_PATH, siteUrl)
  url.searchParams.set('path', path.startsWith('/') ? path : `/${path}`)
  return url.toString()
}
