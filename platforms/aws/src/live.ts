/**
 * Live rooms on AWS: an API Gateway WebSocket API (infra/live.tf) invokes the same function for
 * `$connect`, `$default` and `$disconnect`. API Gateway holds the sockets; the room is the site's
 * live connection records in the Store (`SITE#<siteId>/LIVE#<connectionId>`, with a lookup by
 * connection id, expiring after LIVE_CONNECTION_TTL_SECONDS), and messages go out through the
 * management API (PostToConnection). What a room does is the core's (@fling/api/live).
 *
 * - `$connect`: the ticket in the query string admits the connection, which is stored, and the
 *   room hears `join`. API Gateway delivers nothing to a connection until `$connect` returns,
 *   which is why `welcome` answers the client's `hello` on every platform.
 * - `$default`: a client message, relayed.
 * - `$disconnect`: forgotten, and the room hears `leave`.
 * A connection API Gateway reports gone (410) is forgotten when a send finds it.
 *
 * Every message is one function invocation (DEPLOY.md, costs).
 */
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'
import {
  admitTicket,
  broadcast,
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

/** What the hub needs of the management API. */
export interface Connections {
  /** false: the connection is gone */
  post(connectionId: string, data: string): Promise<boolean>
}

/** The management endpoint of a stage: its `wss://` URL as `https://`. */
export const managementEndpoint = (liveUrl: string) => liveUrl.replace(/^wss?:/, 'https:')

export function apiGatewayConnections(liveUrl: string): Connections {
  const client = new ApiGatewayManagementApiClient({ endpoint: managementEndpoint(liveUrl) })
  return {
    async post(connectionId, data) {
      try {
        await client.send(
          new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(data) })
        )
        return true
      } catch (err) {
        if (err instanceof GoneException || (err as { name?: string }).name === 'GoneException') {
          return false
        }
        throw err
      }
    },
  }
}

export class ApiGatewayLiveHub implements LiveHub {
  constructor(
    private store: Store,
    private connections: Connections
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
        if (!(await this.connections.post(connectionId, JSON.stringify(message)))) {
          await this.store.deleteLiveConnection(connectionId)
        }
      },
    }
  }

  async publish(siteId: string, message: LiveServerMessage) {
    await broadcast(this.room(siteId), message)
  }
}

/** The part of an API Gateway WebSocket event the hub reads. */
export interface LiveEvent {
  requestContext: {
    eventType: 'CONNECT' | 'MESSAGE' | 'DISCONNECT'
    connectionId: string
    routeKey?: string
  }
  queryStringParameters?: Record<string, string | undefined> | null
  body?: string | null
  isBase64Encoded?: boolean
}

export const isLiveEvent = (event: unknown): event is LiveEvent => {
  const ctx = (event as { requestContext?: { eventType?: unknown; connectionId?: unknown } })
    ?.requestContext
  return (
    typeof ctx?.connectionId === 'string' &&
    ['CONNECT', 'MESSAGE', 'DISCONNECT'].includes(String(ctx.eventType))
  )
}

/** One WebSocket event; the status code is what API Gateway does with `$connect`. */
export async function handleLiveEvent(
  event: LiveEvent,
  deps: Deps,
  hub: ApiGatewayLiveHub
): Promise<{ statusCode: number }> {
  const { eventType, connectionId } = event.requestContext
  const now = deps.clock.now()
  if (eventType === 'CONNECT') {
    const admission = deps.config.live
      ? admitTicket(deps.config.secrets.sessionSecret, event.queryStringParameters?.ticket, now)
      : null
    if (!admission) return { statusCode: 401 }
    const peer = newPeer(admission)
    await deps.store.putLiveConnection({
      siteId: admission.siteId,
      connectionId,
      peer,
      connectedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LIVE_CONNECTION_TTL_SECONDS * 1000).toISOString(),
    })
    await joinRoom(hub.room(admission.siteId), peer)
    return { statusCode: 200 }
  }
  if (eventType === 'DISCONNECT') {
    const gone = await deps.store.deleteLiveConnection(connectionId)
    if (gone) await leaveRoom(hub.room(gone.siteId), gone.peer.id)
    return { statusCode: 200 }
  }
  const conn = await deps.store.getLiveConnection(connectionId)
  if (!conn) return { statusCode: 410 }
  const body = event.body ?? ''
  const raw = event.isBase64Encoded ? new Uint8Array(Buffer.from(body, 'base64')) : body
  await receive(hub.room(conn.siteId), connectionId, conn.peer, raw)
  return { statusCode: 200 }
}
