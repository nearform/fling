/**
 * Live rooms' WebSockets on a Node HTTP server (the `ws` library): `GET /api/live?ticket=` upgrades
 * on the app host, admitted by the ticket (live.ts `admitTicket`) and handed to an in-process hub
 * (live-memory.ts). Any other upgrade, a bad or expired ticket, or live rooms off is refused with
 * 401 before the handshake. dev.ts and the Node host (platforms/node) both accept sockets this way.
 */
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { admitTicket } from './live.ts'
import type { MemoryLiveHub } from './live-memory.ts'

/** The path live sockets connect to (LIVE_URL is `ws(s)://<host>/api/live`). */
export const LIVE_PATH = '/api/live'

export interface LiveSocketsOptions {
  hub: MemoryLiveHub
  /** the tickets' key (SESSION_SECRET) */
  secret: string
  /** whether live rooms are on (`config.live`) */
  live: boolean
  now: () => Date
  /** the request's host must be this one, when given (the app host, port included) */
  host?: string
}

const refuse = (socket: Duplex) =>
  socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')

/** Accept live sockets on `server`; returns a function that closes them all. */
export function acceptLiveSockets(server: Server, opts: LiveSocketsOptions): () => void {
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const hostOk = !opts.host || req.headers.host?.toLowerCase() === opts.host
    const admission =
      url.pathname === LIVE_PATH && opts.live && hostOk
        ? admitTicket(opts.secret, url.searchParams.get('ticket'), opts.now())
        : null
    if (!admission) return refuse(socket)
    sockets.handleUpgrade(req, socket, head, ws => {
      // Listen at once: the client says hello as soon as it is open.
      const conn = opts.hub.connect(admission, ws)
      ws.on('message', (data, binary) => {
        const raw = binary ? new Uint8Array(data as Buffer) : (data as Buffer).toString('utf8')
        conn.then(c => c.message(raw)).catch(() => {})
      })
      ws.on('close', () => {
        conn.then(c => c.close()).catch(() => {})
      })
    })
  })
  return () => {
    for (const ws of sockets.clients) ws.terminate()
    sockets.close()
  }
}
