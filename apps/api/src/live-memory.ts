/**
 * The in-process live hub (dev and tests): rooms are maps of open sockets in this process, so it
 * serves one process only. dev.ts puts it behind `GET /api/live?ticket=` on the API server (the
 * `ws` library), which is how `pnpm dev` and the e2e exercise live rooms. Room behaviour is
 * live.ts's; this only keeps the sockets.
 */
import type { LivePeer, LiveServerMessage } from '@fling/shared'
import {
  type Admission,
  joinRoom,
  type LiveHub,
  type LiveRoom,
  leaveRoom,
  newPeer,
  receive,
  broadcast as tellRoom,
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

export class MemoryLiveHub implements LiveHub {
  private rooms = new Map<string, Map<string, { socket: LiveSocket; peer: LivePeer }>>()

  private room(siteId: string): LiveRoom<LiveSocket> {
    return {
      members: async () =>
        [...(this.rooms.get(siteId)?.values() ?? [])].map(m => ({ conn: m.socket, peer: m.peer })),
      send: async (socket, message) => {
        try {
          socket.send(JSON.stringify(message))
        } catch {
          // closing: its close() removes it
        }
      },
    }
  }

  /** An admitted socket joins its room. */
  async connect(admission: Admission, socket: LiveSocket): Promise<LiveConnection> {
    const peer = newPeer(admission)
    const room = this.room(admission.siteId)
    const members = this.rooms.get(admission.siteId) ?? new Map()
    this.rooms.set(admission.siteId, members)
    members.set(peer.id, { socket, peer })
    await joinRoom(room, peer)
    return {
      peer,
      message: raw => receive(room, socket, peer, raw),
      close: async () => {
        if (!members.delete(peer.id)) return
        if (members.size === 0 && this.rooms.get(admission.siteId) === members) {
          this.rooms.delete(admission.siteId)
        }
        await leaveRoom(room, peer.id)
      },
    }
  }

  async publish(siteId: string, message: LiveServerMessage) {
    if (this.rooms.has(siteId)) await tellRoom(this.room(siteId), message)
  }
}
