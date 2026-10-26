/**
 * Live rooms: review mode's realtime, one room per site (protocol in @fling/shared/review-live).
 * Everything here is written once and used by every platform's hub:
 *
 * - `issueLiveTicket` (POST /api/sites/:name/live): policy decides (`comment.read`, as for the
 *   comments the room is about; a refusal is the same 404 as a site nobody holds), then a ticket
 *   the socket presents. The ticket is HMAC-signed with SESSION_SECRET and good for
 *   LIVE_TICKET_TTL_SECONDS: it names the room (the site's id) and the peer's display name,
 *   colour and profile picture, never an email, because it travels in the socket URL.
 * - `admitTicket`: the hub's check when a socket connects. Nothing else is asked then: the
 *   ticket is the whole authorisation, so it is short-lived.
 * - `joinRoom`, `receive`, `leaveRoom`, `broadcast`: what a room does, over `LiveRoom` (however
 *   a hub keeps its connections: in memory, as Durable Object sockets, as stored records).
 * - `LiveHub`: the port the core publishes through (comments.ts: `comments` after every change).
 *   The default hub does nothing, so an instance without live rooms just has none.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  isValidSiteName,
  LIVE_MESSAGE_MAX_BYTES,
  LiveClientMessageSchema,
  type LivePeer,
  type LiveServerMessage,
  type LiveTicket,
  peerColour,
  peerName,
  peerPicture,
} from '@fling/shared'
import { notFound } from './lib/errors.ts'
import { type Actor, can } from './policy.ts'
import type { Deps } from './types.ts'

/** How long a ticket admits a socket: connect straight after asking for one. */
export const LIVE_TICKET_TTL_SECONDS = 60

/** How long a hub that stores connections keeps one (API Gateway's own limit is 2 hours). */
export const LIVE_CONNECTION_TTL_SECONDS = 2 * 60 * 60

/** The port: tell everyone in a site's room something (no-op when nobody is there). */
export interface LiveHub {
  publish(siteId: string, message: LiveServerMessage): Promise<void>
}

/** The hub of an instance without live rooms. */
export const noLiveHub: LiveHub = { publish: async () => {} }

/** What a valid ticket admits: a person (as a peer, less the per-connection id) to a room. */
export interface Admission {
  /** the room: the site's id */
  siteId: string
  siteName: string
  name: string
  colour: string
  picture?: string
}

interface TicketPayload {
  s: string
  n: string
  nm: string
  c: string
  p?: string
  /** expiry, epoch seconds */
  x: number
}

// Keeps a ticket's MAC apart from anything else signed with the session secret.
const sign = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(`fling-live-ticket:${payload}`).digest('base64url')

/** A signed ticket for an admission, valid until `expiresAt`. */
export function signTicket(secret: string, admission: Admission, expiresAt: Date): string {
  const payload: TicketPayload = {
    s: admission.siteId,
    n: admission.siteName,
    nm: admission.name,
    c: admission.colour,
    ...(admission.picture && { p: admission.picture }),
    x: Math.floor(expiresAt.getTime() / 1000),
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/** The admission a ticket carries, or null when it is malformed, tampered with or expired. */
export function admitTicket(
  secret: string,
  ticket: string | null | undefined,
  now: Date
): Admission | null {
  if (!ticket || ticket.length > 4096) return null
  const [body, mac, ...rest] = ticket.split('.')
  if (!body || !mac || rest.length) return null
  const want = Buffer.from(sign(secret, body))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let p: Partial<TicketPayload>
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof p.x !== 'number' || p.x * 1000 <= now.getTime()) return null
  if (![p.s, p.n, p.nm, p.c].every(v => typeof v === 'string')) return null
  const picture = typeof p.p === 'string' ? peerPicture(p.p) : undefined
  return {
    siteId: p.s as string,
    siteName: p.n as string,
    name: p.nm as string,
    colour: p.c as string,
    ...(picture && { picture }),
  }
}

/** The peer a connection is: the admitted person, with an id of its own. */
export const newPeer = (admission: Admission, id: string = randomUUID()): LivePeer => ({
  id,
  name: admission.name,
  colour: admission.colour,
  ...(admission.picture && { picture: admission.picture }),
})

/** 404 unless the instance has live rooms. */
function requireLive(deps: Deps) {
  if (!deps.config.comments || !deps.config.live || !deps.config.liveUrl) {
    throw notFound('Live review is turned off on this instance')
  }
}

/** A ticket into the site's room, for someone who may read its comments; else 404. */
export async function issueLiveTicket(deps: Deps, actor: Actor, name: string): Promise<LiveTicket> {
  requireLive(deps)
  const site = isValidSiteName(name) ? await deps.store.findSite(name) : null
  if (!site || !can(actor, 'comment.read', site) || actor.kind !== 'user') {
    throw notFound(`No site named "${name}"`)
  }
  const user = await deps.store.getUser(actor.email)
  const now = deps.clock.now()
  const ticket = signTicket(
    deps.config.secrets.sessionSecret,
    {
      siteId: site.id,
      siteName: site.name,
      name: peerName(actor.email, user?.name),
      colour: peerColour(actor.email),
      picture: peerPicture(user?.picture),
    },
    new Date(now.getTime() + LIVE_TICKET_TTL_SECONDS * 1000)
  )
  return { url: deps.config.liveUrl as string, ticket, expiresIn: LIVE_TICKET_TTL_SECONDS }
}

// --- what a room does ---

/** What a client's message asks of the room; null: ignore it. */
export type Relayed =
  /** answer the sender */
  | { to: 'sender'; message: LiveServerMessage }
  /** tell everyone else */
  | { to: 'others'; message: LiveServerMessage }
  /** answer the sender with `welcome` (only the hub knows who is in the room) */
  | { to: 'welcome' }

/** Bytes of a message as received. */
function sizeOf(raw: string | ArrayBuffer | Uint8Array): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw)
  return raw.byteLength
}

/**
 * A client message, checked: too large, not JSON, or not in the protocol (an unknown type
 * included) → null, and the hub ignores it. A pointer is passed on stamped with the sender's
 * peer id, so nobody can move someone else's.
 */
export function relay(peer: LivePeer, raw: string | ArrayBuffer | Uint8Array): Relayed | null {
  if (sizeOf(raw) > LIVE_MESSAGE_MAX_BYTES) return null
  let data: unknown
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString())
  } catch {
    return null
  }
  const parsed = LiveClientMessageSchema.safeParse(data)
  if (!parsed.success) return null
  const msg = parsed.data
  switch (msg.type) {
    case 'hello':
      return { to: 'welcome' }
    case 'ping':
      return { to: 'sender', message: { type: 'pong' } }
    case 'cursor':
      return {
        to: 'others',
        message: {
          type: 'cursor',
          peerId: peer.id,
          path: msg.path,
          hash: msg.hash,
          anchor: msg.anchor,
        },
      }
  }
}

/**
 * A room's connections, however a hub keeps them. `C` is the hub's handle on a connection (a
 * socket, a connection id).
 */
export interface LiveRoom<C> {
  /** everyone connected now, with the peer each one is */
  members(): Promise<{ conn: C; peer: LivePeer }[]>
  /** deliver a message; a connection that has gone is the room's to forget, never an error */
  send(conn: C, message: LiveServerMessage): Promise<void>
}

/** Tell everyone in the room, except the peer `except`. */
export async function broadcast<C>(room: LiveRoom<C>, message: LiveServerMessage, except?: string) {
  const members = await room.members()
  await Promise.all(
    members.filter(m => m.peer.id !== except).map(m => room.send(m.conn, message).catch(() => {}))
  )
}

/** A peer arrived: the others hear `join` (the newcomer gets `welcome` when it says `hello`). */
export function joinRoom<C>(room: LiveRoom<C>, peer: LivePeer) {
  return broadcast(room, { type: 'join', peer }, peer.id)
}

/** A peer went: the others hear `leave`. */
export function leaveRoom<C>(room: LiveRoom<C>, peerId: string) {
  return broadcast(room, { type: 'leave', peerId }, peerId)
}

/** A message from `peer` (on connection `conn`): answer it, pass it on, or ignore it. */
export async function receive<C>(
  room: LiveRoom<C>,
  conn: C,
  peer: LivePeer,
  raw: string | ArrayBuffer | Uint8Array
) {
  const out = relay(peer, raw)
  if (!out) return
  if (out.to === 'sender') return room.send(conn, out.message)
  if (out.to === 'others') return broadcast(room, out.message, peer.id)
  const members = await room.members()
  await room.send(conn, {
    type: 'welcome',
    you: peer,
    peers: members.filter(m => m.peer.id !== peer.id).map(m => m.peer),
  })
}

/** Publish without failing the caller: a room that can't be told is not the request's problem. */
export async function publishQuietly(deps: Deps, siteId: string, message: LiveServerMessage) {
  try {
    await (deps.live ?? noLiveHub).publish(siteId, message)
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'warn', msg: 'live publish failed', siteId, error: String(err) })
    )
  }
}
