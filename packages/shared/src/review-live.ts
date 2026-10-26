// The live room: one per site, where everyone with the site's review page open sees each other's
// pointers and hears that comments changed. The protocol is plain JSON over one WebSocket, the
// same on every platform (a Durable Object on Cloudflare, API Gateway WebSockets on AWS, an
// in-process hub locally); clients learn the socket URL from `POST /api/sites/:name/live`, never
// from which cloud they are on. Browser-safe (zod only).
//
// A comment change carries no comment: clients refetch the list, which applies policy.

import { z } from 'zod'
import { COMMENT_PATH_MAX, CommentAnchorSchema } from './comments.ts'

/** Bytes in one client message; larger ones are dropped. */
export const LIVE_MESSAGE_MAX_BYTES = 4096
/** How often a client sends its pointer, at most. */
export const LIVE_CURSOR_INTERVAL_MS = 80

/** Characters in a peer's picture URL; a longer one is left out. */
export const LIVE_PICTURE_MAX = 1024

/** Someone in the room. `id` is per connection: the same person in two tabs is two peers. */
export const LivePeerSchema = z.object({
  id: z.string(),
  name: z.string().max(100),
  colour: z.string().max(32),
  /** their profile picture (https), when sign-in gave one; else clients show initials */
  picture: z.string().max(LIVE_PICTURE_MAX).optional(),
})
export type LivePeer = z.infer<typeof LivePeerSchema>

/** POST /api/sites/:name/live → where to connect: `${url}?ticket=${ticket}`. */
export const LiveTicketSchema = z.object({
  url: z.string(),
  ticket: z.string(),
  /** seconds the ticket is good for: connect before then */
  expiresIn: z.number().int(),
})
export type LiveTicket = z.infer<typeof LiveTicketSchema>

const path = z.string().max(COMMENT_PATH_MAX)
const hash = z.string().max(COMMENT_PATH_MAX)

/**
 * client → room. A client sends `hello` as soon as the socket opens and the room answers with
 * `welcome`: a room on API Gateway cannot send anything while the connection is being accepted,
 * so on every platform the welcome is the answer to `hello`, never sent unasked.
 */
export const LiveClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello') }),
  /** where this peer's pointer is; `anchor` null when it left the page */
  z.object({
    type: z.literal('cursor'),
    path,
    hash,
    anchor: CommentAnchorSchema.nullable(),
  }),
  z.object({ type: z.literal('ping') }),
])
export type LiveClientMessage = z.infer<typeof LiveClientMessageSchema>

/** room → client */
export const LiveServerMessageSchema = z.discriminatedUnion('type', [
  /** the answer to `hello`: who this connection is, and who else is in the room */
  z.object({ type: z.literal('welcome'), you: LivePeerSchema, peers: z.array(LivePeerSchema) }),
  z.object({ type: z.literal('join'), peer: LivePeerSchema }),
  z.object({ type: z.literal('leave'), peerId: z.string() }),
  z.object({
    type: z.literal('cursor'),
    peerId: z.string(),
    path,
    hash,
    anchor: CommentAnchorSchema.nullable(),
  }),
  /** the site's comments changed: refetch them */
  z.object({ type: z.literal('comments') }),
  z.object({ type: z.literal('pong') }),
])
export type LiveServerMessage = z.infer<typeof LiveServerMessageSchema>

/** A stable colour for a person, from their email. */
export function peerColour(email: string): string {
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 75% 45%)`
}

/** A person's display name: their profile name, else their email's local part. */
export function peerName(email: string, name?: string | null): string {
  const n = name?.trim()
  return (n || email.split('@')[0] || email).slice(0, 100)
}

/** A profile picture a peer may show: an https URL of at most LIVE_PICTURE_MAX characters. */
export function peerPicture(picture?: string | null): string | undefined {
  if (!picture || picture.length > LIVE_PICTURE_MAX) return undefined
  try {
    return new URL(picture).protocol === 'https:' ? picture : undefined
  } catch {
    return undefined
  }
}
