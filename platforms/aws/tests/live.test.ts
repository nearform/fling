/**
 * Live rooms on AWS (src/live.ts): API Gateway's `$connect`, `$default` and `$disconnect` events
 * against the core on memory adapters, with the management API faked (what PostToConnection was
 * asked to deliver, and connections it reports gone).
 */
import { loadBaseConfig } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { signTicket } from '@fling/api/live'
import type { Deps } from '@fling/api/types'
import { type LiveHubClient, liveHubConformance } from '@fling/conformance'
import type { LiveServerMessage } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { ApiGatewayLiveHub, handleLiveEvent, isLiveEvent, type LiveEvent } from '../src/live.ts'

const SECRET = 's'.repeat(40)

function world() {
  const base = loadBaseConfig({
    APP_ENV: 'development',
    LIVE_URL: 'wss://abc.execute-api.eu-west-1.amazonaws.com/live',
  })
  const deps: Deps = buildDeps(
    { ...base, secrets: { sessionSecret: SECRET, siteHmacKey: 'h'.repeat(40) } },
    { fsRoot: '/tmp/fling-live-test' }
  )
  const sent = new Map<string, LiveServerMessage[]>()
  const gone = new Set<string>()
  const hub = new ApiGatewayLiveHub(deps.store, {
    async post(id, data) {
      if (gone.has(id)) return false
      sent.set(id, [...(sent.get(id) ?? []), JSON.parse(data)])
      return true
    },
  })
  const got = (id: string) => sent.get(id) ?? []
  const ticket = (siteId: string, name: string, seconds = 60) =>
    signTicket(
      SECRET,
      { siteId, siteName: 'hello', name, colour: 'red' },
      new Date(Date.now() + seconds * 1000)
    )
  const event = (
    eventType: LiveEvent['requestContext']['eventType'],
    connectionId: string,
    extra: Partial<LiveEvent> = {}
  ): LiveEvent => ({ requestContext: { eventType, connectionId }, ...extra })
  const run = (e: LiveEvent) => handleLiveEvent(e, deps, hub)
  const connect = (id: string, t: string) =>
    run(event('CONNECT', id, { queryStringParameters: { ticket: t } }))
  const say = (id: string, m: object) => run(event('MESSAGE', id, { body: JSON.stringify(m) }))
  return { deps, hub, got, gone, ticket, event, run, connect, say }
}

describe('API Gateway live rooms', () => {
  it('recognises WebSocket events, not HTTP or migrate events', () => {
    const w = world()
    expect(isLiveEvent(w.event('MESSAGE', 'c1'))).toBe(true)
    expect(isLiveEvent({ requestContext: { http: { method: 'GET' } } })).toBe(false)
    expect(isLiveEvent({ fling: 'migrate' })).toBe(false)
  })

  it('refuses $connect without a good ticket, and stores nothing', async () => {
    const w = world()
    expect(await w.connect('c1', 'nope')).toEqual({ statusCode: 401 })
    expect(await w.connect('c1', w.ticket('S1', 'A', -1))).toEqual({ statusCode: 401 })
    expect(await w.deps.store.getLiveConnection('c1')).toBeNull()
  })

  it('reads base64 bodies', async () => {
    const w = world()
    await w.connect('a', w.ticket('S1', 'Alice'))
    const body = Buffer.from('{"type":"ping"}').toString('base64')
    await w.run(w.event('MESSAGE', 'a', { body, isBase64Encoded: true }))
    expect(w.got('a')).toEqual([{ type: 'pong' }])
  })
})

liveHubConformance('ApiGatewayLiveHub', () => {
  const w = world()
  let n = 0
  const idOf = new WeakMap<LiveHubClient, string>()
  return {
    publish: (siteId, message) => w.hub.publish(siteId, message),
    async connect(admission) {
      const id = `c${++n}`
      const t = signTicket(SECRET, admission, new Date(Date.now() + 60_000))
      expect(await w.connect(id, t)).toEqual({ statusCode: 200 })
      const client: LiveHubClient = {
        get got() {
          return w.got(id)
        },
        send: async m => void (await w.say(id, m)),
        close: async () => void (await w.run(w.event('DISCONNECT', id))),
      }
      idOf.set(client, id)
      return client
    },
    async drop(client) {
      w.gone.add(idOf.get(client) ?? '')
    },
  }
})
