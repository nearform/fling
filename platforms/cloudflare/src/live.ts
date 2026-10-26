/**
 * Live rooms on Cloudflare: one Durable Object per site (`LiveRoom`, binding LIVE_ROOMS, named by
 * the site's id) holds the room's sockets with the WebSocket hibernation API, so an idle room
 * costs nothing while its sockets stay open. Each socket's peer is its serialised attachment,
 * which survives hibernation. What a room does (welcome, join, leave, relaying pointers) is the
 * core's (@fling/api/live); this only keeps the sockets.
 *
 * - `handleLiveUpgrade`: the Worker's `GET /api/live?ticket=` (on the app host). The ticket is
 *   checked here, then the upgrade goes to the site's object with the admission in a header only
 *   the Worker can set (a Durable Object has no public address).
 * - `DurableObjectLiveHub`: the LiveHub port, `POST /publish` to the site's object.
 */
import type {
  WebSocket as CfWebSocket,
  WebSocketPair as CfWebSocketPair,
  DurableObjectNamespace,
  DurableObjectState,
} from '@cloudflare/workers-types'
import {
  type Admission,
  admitTicket,
  broadcast,
  joinRoom,
  type LiveHub,
  type LiveRoom as LiveRoomPort,
  leaveRoom,
  newPeer,
  receive,
} from '@fling/api/live'
import type { LivePeer, LiveServerMessage } from '@fling/shared'

/** The path the Worker accepts live sockets on (LIVE_URL is `wss://<app host>/api/live`). */
export const LIVE_PATH = '/api/live'
const ADMISSION_HEADER = 'x-fling-live-admission'

const WebSocketPair = (globalThis as unknown as { WebSocketPair: typeof CfWebSocketPair })
  .WebSocketPair

const roomOf = (ns: DurableObjectNamespace, siteId: string) => ns.get(ns.idFromName(siteId))

/** `GET /api/live?ticket=`: a WebSocket upgrade with a valid ticket goes to its site's room. */
export async function handleLiveUpgrade(
  request: Request,
  ns: DurableObjectNamespace,
  secret: string,
  now: Date
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 })
  }
  const ticket = new URL(request.url).searchParams.get('ticket')
  const admission = admitTicket(secret, ticket, now)
  if (!admission) return new Response('Bad or expired ticket', { status: 401 })
  const headers = new Headers(request.headers)
  headers.set(ADMISSION_HEADER, JSON.stringify(admission))
  return (await roomOf(ns, admission.siteId).fetch(request.url, {
    headers: headers as never,
  })) as unknown as Response
}

export class DurableObjectLiveHub implements LiveHub {
  constructor(private ns: DurableObjectNamespace) {}

  async publish(siteId: string, message: LiveServerMessage) {
    const res = await roomOf(this.ns, siteId).fetch('https://live-room/publish', {
      method: 'POST',
      body: JSON.stringify(message),
    })
    if (!res.ok) throw new Error(`the live room answered ${res.status}`)
  }
}

/** One site's room. */
export class LiveRoom {
  constructor(private ctx: DurableObjectState) {}

  private room: LiveRoomPort<CfWebSocket> = {
    members: async () =>
      this.ctx.getWebSockets().flatMap(ws => {
        const peer = ws.deserializeAttachment() as LivePeer | null
        return peer && ws.readyState === 1 ? [{ conn: ws, peer }] : []
      }),
    send: async (ws, message) => {
      try {
        ws.send(JSON.stringify(message))
      } catch {
        // closing: webSocketClose announces it
      }
    },
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/publish' && request.method === 'POST') {
      await broadcast(this.room, (await request.json()) as LiveServerMessage)
      return new Response(null, { status: 204 })
    }
    const header = request.headers.get(ADMISSION_HEADER)
    if (!header || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 })
    }
    const peer = newPeer(JSON.parse(header) as Admission)
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(peer)
    await joinRoom(this.room, peer)
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer) {
    const peer = ws.deserializeAttachment() as LivePeer | null
    if (peer) await receive(this.room, ws, peer, message)
  }

  async webSocketClose(ws: CfWebSocket, code: number) {
    const peer = ws.deserializeAttachment() as LivePeer | null
    ws.serializeAttachment(null)
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye')
    } catch {
      // already closed
    }
    if (peer) await leaveRoom(this.room, peer.id)
  }

  async webSocketError(ws: CfWebSocket) {
    await this.webSocketClose(ws, 1011)
  }
}
