/**
 * Live rooms on Web PubSub (src/live.ts) against the core on memory adapters, with the service
 * faked: it posts the hub's CloudEvents to the handler as Web PubSub does (the abuse-protection
 * OPTIONS, `connect` with the client's query, `message`, `disconnected`), keeps the groups a
 * connect answer names, and records what the REST API was asked to deliver.
 */
import { loadBaseConfig } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { signTicket } from '@fling/api/live'
import type { Deps } from '@fling/api/types'
import { type LiveHubClient, liveHubConformance } from '@fling/conformance'
import type { LiveServerMessage } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { handleLiveEvents, LIVE_EVENTS_PATH, WebPubSubLiveHub } from '../src/live.ts'

const SECRET = 's'.repeat(40)
const EVENTS_SECRET = 'e'.repeat(40)
const ENDPOINT = 'https://fling-test.webpubsub.azure.com'
const SERVICE = 'fling-test.webpubsub.azure.com'
const HUB = 'fling'
const HANDLER = `https://app.example.test${LIVE_EVENTS_PATH}?code=${EVENTS_SECRET}`

function world() {
  const base = loadBaseConfig({
    APP_ENV: 'development',
    LIVE_URL: `wss://${SERVICE}/client/hubs/fling`,
  })
  const deps: Deps = buildDeps(
    { ...base, secrets: { sessionSecret: SECRET, siteHmacKey: 'h'.repeat(40) } },
    { fsRoot: '/tmp/fling-live-test' }
  )
  const inbox = new Map<string, LiveServerMessage[]>()
  const groups = new Map<string, Set<string>>()
  const gone = new Set<string>()
  const open = new Set<string>()
  const deliver = (id: string, data: string) => {
    if (open.has(id) && !gone.has(id)) inbox.set(id, [...(inbox.get(id) ?? []), JSON.parse(data)])
  }
  const hub = new WebPubSubLiveHub(deps.store, {
    async send(id, data) {
      if (gone.has(id) || !open.has(id)) return false
      deliver(id, data)
      return true
    },
    async sendToGroup(group, data) {
      for (const id of groups.get(group) ?? []) deliver(id, data)
    },
  })
  const post = (type: string, id: string, body: BodyInit, headers: Record<string, string> = {}) =>
    handleLiveEvents(
      new Request(HANDLER, {
        method: 'POST',
        headers: {
          'webhook-request-origin': SERVICE,
          'ce-hub': HUB,
          'ce-type': type,
          'ce-connectionid': id,
          ...headers,
        },
        body,
      }),
      deps,
      hub,
      { secret: EVENTS_SECRET, endpoint: ENDPOINT, hub: HUB }
    )
  /** The service's connect: the handler decides; a 200 names the groups to join. */
  const connect = async (id: string, ticket: string) => {
    inbox.set(id, [])
    open.add(id)
    const res = await post(
      'azure.webpubsub.sys.connect',
      id,
      JSON.stringify({ claims: {}, query: { ticket: [ticket] }, headers: {}, subprotocols: [] }),
      { 'content-type': 'application/json' }
    )
    if (res.status !== 200) {
      open.delete(id)
      return res
    }
    for (const g of ((await res.clone().json()) as { groups: string[] }).groups) {
      groups.set(g, new Set([...(groups.get(g) ?? []), id]))
    }
    return res
  }
  const say = (id: string, m: object) =>
    post('azure.webpubsub.user.message', id, JSON.stringify(m), { 'content-type': 'text/plain' })
  const leave = async (id: string) => {
    for (const members of groups.values()) members.delete(id)
    open.delete(id)
    await post('azure.webpubsub.sys.disconnected', id, JSON.stringify({ reason: '' }), {
      'content-type': 'application/json',
    })
  }
  const ticket = (siteId: string, name: string, seconds = 60) =>
    signTicket(
      SECRET,
      { siteId, siteName: 'hello', name, colour: 'red' },
      new Date(Date.now() + seconds * 1000)
    )
  return { deps, hub, inbox, open, gone, groups, post, connect, say, leave, ticket }
}

describe('Web PubSub live rooms', () => {
  it('answers the abuse-protection handshake for its own service only', async () => {
    const w = world()
    const options = (origin: string, url = HANDLER) =>
      handleLiveEvents(
        new Request(url, { method: 'OPTIONS', headers: { 'webhook-request-origin': origin } }),
        w.deps,
        w.hub,
        { secret: EVENTS_SECRET, endpoint: ENDPOINT, hub: HUB }
      )
    const ok = await options(SERVICE)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('webhook-allowed-origin')).toBe(SERVICE)
    expect((await options('evil.webpubsub.azure.com')).status).toBe(400)
    expect((await options(SERVICE, HANDLER.replace(EVENTS_SECRET, 'x'.repeat(40)))).status).toBe(
      401
    )
  })

  it('refuses events without the secret, from another hub, or a connect without a good ticket', async () => {
    const w = world()
    const event = (url: string, hub: string) =>
      handleLiveEvents(
        new Request(url, {
          method: 'POST',
          headers: {
            'webhook-request-origin': SERVICE,
            'ce-hub': hub,
            'ce-type': 'azure.webpubsub.sys.disconnected',
            'ce-connectionid': 'c1',
          },
          body: '{}',
        }),
        w.deps,
        w.hub,
        { secret: EVENTS_SECRET, endpoint: ENDPOINT, hub: HUB }
      )
    expect((await event(HANDLER.replace(/code=.*/, ''), HUB)).status).toBe(401)
    expect((await event(HANDLER, 'other')).status).toBe(400)
    expect((await w.connect('c1', 'nope')).status).toBe(401)
    expect((await w.connect('c1', w.ticket('S1', 'A', -1))).status).toBe(401)
    expect(await w.deps.store.getLiveConnection('c1')).toBeNull()
  })

  it('answers a message with an empty body, so nothing goes back through the service', async () => {
    const w = world()
    await w.connect('a', w.ticket('S1', 'Alice'))
    const res = await w.say('a', { type: 'ping' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(w.inbox.get('a')).toEqual([{ type: 'pong' }])
  })
})

liveHubConformance('WebPubSubLiveHub', () => {
  const w = world()
  let n = 0
  return {
    async connect(admission) {
      const id = `conn-${n++}`
      const res = await w.connect(id, w.ticket(admission.siteId, admission.name))
      if (res.status !== 200) throw new Error(`connect refused: ${res.status}`)
      const client: LiveHubClient & { id: string } = {
        id,
        get got() {
          return w.inbox.get(id) ?? []
        },
        send: async message => {
          if (w.open.has(id)) await w.say(id, message)
        },
        close: async () => {
          if (w.open.has(id)) await w.leave(id)
        },
      }
      return client
    },
    publish: (siteId, message) => w.hub.publish(siteId, message),
    async drop(client) {
      const id = (client as LiveHubClient & { id: string }).id
      w.gone.add(id)
      for (const members of w.groups.values()) members.delete(id)
    },
  }
})
