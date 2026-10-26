/**
 * The live room on the review page, the parts that need no React: where to connect, how long to
 * wait before reconnecting, how the room's messages change who is here and where their pointers
 * are, and which pointers the review shell draws. The protocol is @fling/shared/review-live.
 */
import type {
  BridgeCursor,
  CommentAnchor,
  LivePeer,
  LiveServerMessage,
  LiveTicket,
} from '@fling/shared'
import type { FrameLocation } from './review'

/**
 * The socket URL for a ticket: its URL (resolved against `base`, the page's URL, with http(s) made
 * ws(s)) plus the ticket.
 */
export function liveSocketUrl(ticket: LiveTicket, base: string): string {
  const url = new URL(ticket.url, base)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  url.searchParams.set('ticket', ticket.ticket)
  return url.toString()
}

/** Milliseconds before reconnect attempt `n` (0-based): 1 s doubling to 30 s, with some jitter. */
export function reconnectDelay(n: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(n, 5))
  return Math.round(base * (0.75 + random() * 0.5))
}

/** Someone else in the room: where their pointer is (null: not on a page) and the last page it was on. */
export interface LivePresence extends LivePeer {
  cursor: (FrameLocation & { anchor: CommentAnchor }) | null
  page: string | null
}

export interface LiveState {
  you: LivePeer | null
  /** the others, in the order they arrived */
  peers: LivePresence[]
}

export const EMPTY_LIVE: LiveState = { you: null, peers: [] }

const present = (p: LivePeer): LivePresence => ({ ...p, cursor: null, page: null })

/**
 * The room after a message. A `join` may arrive before this connection's `welcome`; the welcome
 * keeps it. `comments` and `pong` change nothing here.
 */
export function applyLiveMessage(state: LiveState, m: LiveServerMessage): LiveState {
  switch (m.type) {
    case 'welcome': {
      const peers = m.peers.filter(p => p.id !== m.you.id).map(present)
      for (const early of state.peers) {
        if (early.id !== m.you.id && !peers.some(p => p.id === early.id)) peers.push(early)
      }
      return { you: m.you, peers }
    }
    case 'join':
      if (m.peer.id === state.you?.id || state.peers.some(p => p.id === m.peer.id)) return state
      return { ...state, peers: [...state.peers, present(m.peer)] }
    case 'leave':
      return { ...state, peers: state.peers.filter(p => p.id !== m.peerId) }
    case 'cursor':
      return {
        ...state,
        peers: state.peers.map(p =>
          p.id === m.peerId
            ? {
                ...p,
                cursor: m.anchor ? { path: m.path, hash: m.hash, anchor: m.anchor } : null,
                page: m.path,
              }
            : p
        ),
      }
    default:
      return state
  }
}

/** The pointers to draw: peers on the same page and hash route as the frame. */
export function cursorsAt(peers: readonly LivePresence[], at: FrameLocation): BridgeCursor[] {
  const out: BridgeCursor[] = []
  for (const p of peers) {
    if (p.cursor && p.cursor.path === at.path && p.cursor.hash === at.hash) {
      out.push({ id: p.id, name: p.name, colour: p.colour, anchor: p.cursor.anchor })
    }
  }
  return out
}

/**
 * An avatar's letters: the first letters of the name's first and last words, or of its only word.
 * Words split on spaces, dots, underscores and hyphens, since a name without a profile is the
 * email's local part ("clifton.cunningham" → "CC").
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

/** One person in the header: their peers (one per tab) grouped by name and colour. */
export interface PresenceCircle {
  key: string
  name: string
  colour: string
  picture?: string
  you: boolean
  /** the page their pointer was last on, when known */
  page: string | null
  /** on the page the frame is on (you always are) */
  here: boolean
}

/** Circles shown before the rest fold into "+N". */
export const PRESENCE_SHOWN = 5

/**
 * The header's circles: you first, then everyone else in the order they arrived, one circle per
 * person however many tabs they have open; after PRESENCE_SHOWN, the rest are `more`.
 */
export function presenceCircles(
  state: LiveState,
  at: FrameLocation
): { shown: PresenceCircle[]; more: PresenceCircle[] } {
  const circles: PresenceCircle[] = []
  const byKey = new Map<string, PresenceCircle>()
  const add = (p: LivePeer, you: boolean, page: string | null) => {
    const key = `${p.name}\u0000${p.colour}`
    const known = byKey.get(key)
    if (known) {
      known.you ||= you
      known.here ||= you || page === at.path
      known.page ??= page
      known.picture ??= p.picture
      return
    }
    const circle: PresenceCircle = {
      key,
      name: p.name,
      colour: p.colour,
      ...(p.picture ? { picture: p.picture } : {}),
      you,
      page: you ? at.path : page,
      here: you || page === at.path,
    }
    byKey.set(key, circle)
    circles.push(circle)
  }
  if (state.you) add(state.you, true, at.path)
  for (const p of state.peers) add(p, false, p.page)
  return { shown: circles.slice(0, PRESENCE_SHOWN), more: circles.slice(PRESENCE_SHOWN) }
}

/** A circle as drawn: arriving (after `delay` ms), staying, or on its way out. */
export interface ShownCircle {
  circle: PresenceCircle
  phase: 'enter' | 'stay' | 'exit'
  delay: number
}

/** Milliseconds between circles emerging together (yours, then the room's on a welcome). */
export const EMERGE_STAGGER_MS = 90

/**
 * The circles to draw after a change: drawn ones stay where they are (with their latest details)
 * or, gone from `next`, leave there until their exit animation ends (`dropExited`); one that comes
 * back while leaving enters again; new ones enter at the end, staggered in `next`'s order.
 */
export function reconcileCircles(
  drawn: readonly ShownCircle[],
  next: readonly PresenceCircle[]
): ShownCircle[] {
  const byKey = new Map(next.map(c => [c.key, c]))
  let entering = 0
  const enter = (circle: PresenceCircle): ShownCircle => ({
    circle,
    phase: 'enter',
    delay: EMERGE_STAGGER_MS * entering++,
  })
  const out = drawn.map((d): ShownCircle => {
    const circle = byKey.get(d.circle.key)
    if (!circle) return d.phase === 'exit' ? d : { ...d, phase: 'exit', delay: 0 }
    return d.phase === 'exit' ? enter(circle) : { ...d, circle }
  })
  const known = new Set(drawn.map(d => d.circle.key))
  for (const c of next) if (!known.has(c.key)) out.push(enter(c))
  return out
}

/** The circles once `key`'s exit animation has ended. */
export function dropExited(drawn: readonly ShownCircle[], key: string): ShownCircle[] {
  return drawn.filter(d => !(d.circle.key === key && d.phase === 'exit'))
}

/**
 * What to announce for a room message (a toast, and to screen readers), given the room before it:
 * your welcome, or someone new arriving. A second tab of someone already here, and joins before
 * your welcome (the welcome covers them), say nothing.
 */
export function liveAnnouncement(
  before: LiveState,
  m: LiveServerMessage
): { text: string; colour: string } | null {
  if (m.type === 'welcome') {
    const after = presenceCircles(applyLiveMessage(before, m), { path: '', hash: '' })
    const others = after.shown.length + after.more.length - 1
    return {
      text:
        others === 0
          ? "You're the first here"
          : `You're live — ${others} ${others === 1 ? 'other' : 'others'} here`,
      colour: m.you.colour,
    }
  }
  if (m.type === 'join') {
    if (!before.you || m.peer.id === before.you.id) return null
    const same = (p: LivePeer) => p.name === m.peer.name && p.colour === m.peer.colour
    if (same(before.you) || before.peers.some(same)) return null
    return { text: `${m.peer.name} joined`, colour: m.peer.colour }
  }
  return null
}
