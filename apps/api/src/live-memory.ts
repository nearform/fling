/**
 * The in-process live hub: a room is the sockets connected to this process, kept in a map. Alone
 * it serves one process (dev, tests). Given a fan-out (`LiveFanout`), it serves a room spread over
 * several processes behind one load balancer (the Node host on Fly.io, DigitalOcean, self-host):
 *
 * - everything a room says (join, leave, pointers, `publish`) goes to this process's sockets at
 *   once, and to the fan-out, which carries it to every other process; each delivers it to its
 *   own sockets, less the peer it came from;
 * - each process learns the room's peers elsewhere from the joins and leaves it hears, so
 *   `welcome` lists everyone. A process that stops without a word leaves its peers listed until
 *   LIVE_CONNECTION_TTL_SECONDS pass (they no longer move; a reload clears them).
 *
 * What a message asks of the room is the core's (`relay`, live.ts); this keeps the sockets.
 * live-ws.ts accepts the WebSocket upgrades (`GET /api/live?ticket=`) and hands each socket here.
 */
import { randomUUID } from 'node:crypto'
import type { LivePeer, LiveServerMessage } from '@fling/shared'
import {
  type Admission,
  broadcast,
  LIVE_CONNECTION_TTL_SECONDS,
  type LiveHub,
  type LiveRoom,
  newPeer,
  relay,
} from './live.ts'

/** What the hub needs of a socket. */
export interface LiveSocket {
  send(data: string): void
}

/** One connection's handlers, for the server to call. */
export interface LiveConnection {
  peer: LivePeer
  message(raw: string | ArrayBuffer | Uint8Array): Promise<void>
  close(): Promise<void>
}

/** What one process tells the others about a room. */
export interface LiveEvent {
  /** the process it came from */
  origin: string
  siteId: string
  message: LiveServerMessage
  /** the peer not to tell (the one it came from) */
  except?: string
}

/**
 * Carries room events between the processes of one instance. `publish` reaches every
 * subscriber, the publisher's own included (the hub ignores its own). Delivery is best effort:
 * live rooms are presence and pointers, and comments are refetched on the next change anyway.
 */
export interface LiveFanout {
  publish(event: LiveEvent): Promise<void>
  subscribe(listener: (event: LiveEvent) => void): Promise<void>
  close?(): Promise<void>
}

/** A fan-out within one process: what tests use to stand for several. */
export class LocalFanout implements LiveFanout {
  private listeners: ((event: LiveEvent) => void)[] = []
  async publish(event: LiveEvent) {
    for (const l of this.listeners) l(structuredClone(event))
  }
  async subscribe(listener: (event: LiveEvent) => void) {
    this.listeners.push(listener)
  }
}

type Member = { socket: LiveSocket; peer: LivePeer }
type Remote = { peer: LivePeer; origin: string; until: number }

export class MemoryLiveHub implements LiveHub {
  private rooms = new Map<string, Map<string, Member>>()
  /** peers connected to other processes, by room */
  private remote = new Map<string, Map<string, Remote>>()
  private readonly origin = randomUUID()
  private fanout: LiveFanout | undefined
  private ready: Promise<void> | undefined
  private now: () => number

  constructor(opts: { fanout?: LiveFanout; now?: () => number } = {}) {
    this.fanout = opts.fanout
    this.now = opts.now ?? Date.now
    this.ready = this.fanout?.subscribe(event => this.hear(event))
  }

  /** This process's sockets in a room. */
  private room(siteId: string): LiveRoom<LiveSocket> {
    return {
      members: async () =>
        [...(this.rooms.get(siteId)?.values() ?? [])].map(m => ({ conn: m.socket, peer: m.peer })),
      send: async (socket, message) => {
        try {
          socket.send(JSON.stringify(message))
        } catch {
          // gone: forgotten now, as a hub that stores connections forgets one reported gone
          this.forget(siteId, socket)
        }
      },
    }
  }

  /** A socket whose send failed: out of the room, and the others hear it left. */
  private forget(siteId: string, socket: LiveSocket) {
    const members = this.rooms.get(siteId)
    for (const [id, m] of members ?? []) {
      if (m.socket !== socket) continue
      members?.delete(id)
      void this.tell(siteId, { type: 'leave', peerId: id }, id)
    }
    if (members?.size === 0) this.rooms.delete(siteId)
  }

  /** Tell the room, here and in every other process. */
  private async tell(siteId: string, message: LiveServerMessage, except?: string) {
    await broadcast(this.room(siteId), message, except)
    if (this.fanout) {
      await this.ready
      await this.fanout
        .publish({ origin: this.origin, siteId, message, ...(except ? { except } : {}) })
        .catch(err =>
          console.warn(
            JSON.stringify({ level: 'warn', msg: 'live fan-out failed', error: String(err) })
          )
        )
    }
  }

  /** Another process's event: note who joined or left, and tell this process's sockets. */
  private hear(event: LiveEvent) {
    if (event.origin === this.origin) return
    const { siteId, message } = event
    if (message.type === 'join') {
      const peers = this.remote.get(siteId) ?? new Map<string, Remote>()
      this.remote.set(siteId, peers)
      peers.set(message.peer.id, {
        peer: message.peer,
        origin: event.origin,
        until: this.now() + LIVE_CONNECTION_TTL_SECONDS * 1000,
      })
    } else if (message.type === 'leave') {
      const peers = this.remote.get(siteId)
      peers?.delete(message.peerId)
      if (peers?.size === 0) this.remote.delete(siteId)
    }
    void broadcast(this.room(siteId), message, event.except)
  }

  /** The room's peers in other processes, less the expired. */
  private remotePeers(siteId: string): LivePeer[] {
    const peers = this.remote.get(siteId)
    if (!peers) return []
    const now = this.now()
    for (const [id, r] of peers) if (r.until <= now) peers.delete(id)
    return [...peers.values()].map(r => r.peer)
  }

  /** An admitted socket joins its room. */
  async connect(admission: Admission, socket: LiveSocket): Promise<LiveConnection> {
    const peer = newPeer(admission)
    const { siteId } = admission
    const members = this.rooms.get(siteId) ?? new Map<string, Member>()
    this.rooms.set(siteId, members)
    members.set(peer.id, { socket, peer })
    await this.tell(siteId, { type: 'join', peer }, peer.id)
    const room = this.room(siteId)
    return {
      peer,
      message: async raw => {
        const out = relay(peer, raw)
        if (!out) return
        if (out.to === 'sender') return room.send(socket, out.message)
        if (out.to === 'others') return this.tell(siteId, out.message, peer.id)
        const here = (await room.members()).map(m => m.peer).filter(p => p.id !== peer.id)
        await room.send(socket, {
          type: 'welcome',
          you: peer,
          peers: [...here, ...this.remotePeers(siteId)],
        })
      },
      close: async () => {
        if (!members.delete(peer.id)) return
        if (members.size === 0 && this.rooms.get(siteId) === members) this.rooms.delete(siteId)
        await this.tell(siteId, { type: 'leave', peerId: peer.id }, peer.id)
      },
    }
  }

  async publish(siteId: string, message: LiveServerMessage) {
    await this.tell(siteId, message)
  }

  async close() {
    await this.fanout?.close?.()
  }
}
