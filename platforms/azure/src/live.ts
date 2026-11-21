/**
 * Live rooms on Azure Web PubSub. The service holds the sockets: clients open
 * `LIVE_URL?ticket=…` (`wss://<service>/client/hubs/<hub>`, the hub allowing anonymous connects),
 * and the service tells the host about each connection as CloudEvents over HTTP (the hub's event
 * handler, infra/live.tf), which `handleLiveEvents` answers on the app host at `LIVE_EVENTS_PATH`.
 * The room is the site's live connection records in the Store, as on AWS
 * (`SITE#<siteId>/LIVE#<connectionId>`, expiring after LIVE_CONNECTION_TTL_SECONDS), and what a
 * room does is the core's (@fling/api/live).
 *
 * - `connect` (the service waits for the answer): the ticket in the query admits the connection,
 *   which is stored and put in its site's group, and the room hears `join`. A refusal is a 401,
 *   which the service turns into a closed socket.
 * - `message` (a user event): a client message, relayed. The answer's body would go back to the
 *   sender, so it is always empty; replies go out through the service's REST API.
 * - `disconnected`: forgotten, and the room hears `leave`.
 *
 * `publish` is one REST call, a send to the site's group. A send to one connection that the
 * service reports gone (404) forgets the connection.
 *
 * Only the instance's service may call the handler: the URL carries `code`, the live-events secret
 * (LIVE_EVENTS_SECRET, from Key Vault, also in the hub's event handler URL), compared in constant
 * time, and the event must name the hub and come from the service's host. The abuse-protection
 * handshake (an OPTIONS request with `WebHook-Request-Origin`) is answered only for that host.
 */
import { timingSafeEqual } from 'node:crypto'
import type { WebPubSubServiceClient } from '@azure/web-pubsub'
import {
  admitTicket,
  joinRoom,
  LIVE_CONNECTION_TTL_SECONDS,
  type LiveHub,
  type LiveRoom,
  leaveRoom,
  newPeer,
  receive,
} from '@fling/api/live'
import type { Store } from '@fling/api/store'
import type { Deps } from '@fling/api/types'
import type { LiveServerMessage } from '@fling/shared'

/** Where the hub's event handler posts, on the app host. */
export const LIVE_EVENTS_PATH = '/webpubsub/events'

/** What the hub needs of the service's REST API. */
export interface PubSubConnections {
  /** false: the service reports the connection gone */
  send(connectionId: string, data: string): Promise<boolean>
  /** to every connection in a group (none in it is not an error) */
  sendToGroup(group: string, data: string): Promise<void>
}

const statusOf = (err: unknown) => (err as { statusCode?: unknown } | null)?.statusCode

export function webPubSubConnections(client: WebPubSubServiceClient): PubSubConnections {
  return {
    async send(connectionId, data) {
      try {
        await client.sendToConnection(connectionId, data, { contentType: 'text/plain' })
        return true
      } catch (err) {
        if (statusOf(err) === 404) return false
        throw err
      }
    },
    async sendToGroup(group, data) {
      await client.group(group).sendToAll(data, { contentType: 'text/plain' })
    },
  }
}

/** A site's group in the hub. */
export const groupOf = (siteId: string) => `site.${siteId}`

export class WebPubSubLiveHub implements LiveHub {
  constructor(
    private store: Store,
    private connections: PubSubConnections
  ) {}

  /** A site's room: its stored connections. */
  room(siteId: string): LiveRoom<string> {
    return {
      members: async () =>
        (await this.store.listLiveConnections(siteId)).map(c => ({
          conn: c.connectionId,
          peer: c.peer,
        })),
      send: async (connectionId, message) => {
        if (!(await this.connections.send(connectionId, JSON.stringify(message)))) {
          await this.store.deleteLiveConnection(connectionId)
        }
      },
    }
  }

  async publish(siteId: string, message: LiveServerMessage) {
    await this.connections.sendToGroup(groupOf(siteId), JSON.stringify(message))
  }
}

export interface LiveEventsOptions {
  /** LIVE_EVENTS_SECRET: the `code` in the event handler's URL */
  secret: string
  /** the service's endpoint (WEB_PUBSUB_ENDPOINT), whose host sends the events */
  endpoint: string
  /** the hub (WEB_PUBSUB_HUB) */
  hub: string
}

const empty = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } })

function sameSecret(given: string | null, secret: string) {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The ticket of a connect event: its query's `ticket`, as the service passes it on. */
function ticketOf(body: unknown): string | undefined {
  const query = (body as { query?: Record<string, unknown> } | null)?.query
  const ticket = query?.ticket
  const first = Array.isArray(ticket) ? ticket[0] : ticket
  return typeof first === 'string' ? first : undefined
}

/** One request from the hub's event handler: the abuse-protection handshake or an event. */
export async function handleLiveEvents(
  request: Request,
  deps: Deps,
  hub: WebPubSubLiveHub,
  opts: LiveEventsOptions
): Promise<Response> {
  const url = new URL(request.url)
  if (!sameSecret(url.searchParams.get('code'), opts.secret)) return empty(401)
  const service = new URL(opts.endpoint).host.toLowerCase()
  const origin = request.headers.get('webhook-request-origin')?.toLowerCase()
  if (origin !== service) return empty(400)
  if (request.method === 'OPTIONS') return empty(200, { 'webhook-allowed-origin': service })
  if (request.method !== 'POST') return empty(405)
  if (request.headers.get('ce-hub')?.toLowerCase() !== opts.hub.toLowerCase()) return empty(400)
  const type = request.headers.get('ce-type') ?? ''
  const connectionId = request.headers.get('ce-connectionid')
  if (!connectionId) return empty(400)
  const now = deps.clock.now()

  if (type === 'azure.webpubsub.sys.connect') {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return empty(400)
    }
    const admission = deps.config.live
      ? admitTicket(deps.config.secrets.sessionSecret, ticketOf(body), now)
      : null
    if (!admission) return empty(401)
    const peer = newPeer(admission)
    await deps.store.putLiveConnection({
      siteId: admission.siteId,
      connectionId,
      peer,
      connectedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LIVE_CONNECTION_TTL_SECONDS * 1000).toISOString(),
    })
    await joinRoom(hub.room(admission.siteId), peer)
    return Response.json(
      { groups: [groupOf(admission.siteId)] },
      { headers: { 'cache-control': 'no-store' } }
    )
  }
  if (type === 'azure.webpubsub.sys.disconnected') {
    const gone = await deps.store.deleteLiveConnection(connectionId)
    if (gone) await leaveRoom(hub.room(gone.siteId), gone.peer.id)
    return empty(204)
  }
  if (type === 'azure.webpubsub.user.message') {
    const conn = await deps.store.getLiveConnection(connectionId)
    if (!conn) return empty(204)
    const raw = request.headers.get('content-type')?.startsWith('application/octet-stream')
      ? new Uint8Array(await request.arrayBuffer())
      : await request.text()
    await receive(hub.room(conn.siteId), connectionId, conn.peer, raw)
    return empty(204)
  }
  // `connected` and any other event: nothing to do.
  return empty(204)
}
