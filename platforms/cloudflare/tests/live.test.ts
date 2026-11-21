/**
 * Live rooms on Cloudflare: the `LiveRoom` Durable Object with hibernatable sockets and the
 * Worker's ticket check, in workerd (Miniflare), over real WebSockets. The room's behaviour is the
 * live hub conformance suite's; the ticket check is the Worker's own.
 */
import { join } from 'node:path'
import { type Admission, signTicket } from '@fling/api/live'
import { type LiveHubClient, liveHubConformance } from '@fling/conformance'
import type { LiveServerMessage } from '@fling/shared'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundle, COMPATIBILITY } from './miniflare.ts'

const SECRET = 'x'.repeat(40)
let mf: Miniflare

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundle(join(import.meta.dirname, 'live-worker.ts')),
    ...COMPATIBILITY,
    bindings: { SECRET },
    durableObjects: { LIVE_ROOMS: 'LiveRoom' },
  })
}, 60_000)
afterAll(() => mf?.dispose())

const admission = (siteId: string, name: string): Admission => ({
  siteId,
  siteName: 'hello',
  name,
  colour: 'red',
})

/** A real socket to the Worker's `GET /api/live`, recording what the room sends it. */
async function connect(ticket: string): Promise<LiveHubClient> {
  const res = await mf.dispatchFetch(
    `https://app.example.test/api/live?ticket=${encodeURIComponent(ticket)}`,
    { headers: { upgrade: 'websocket' } }
  )
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status}`)
  ws.accept()
  const got: LiveServerMessage[] = []
  ws.addEventListener('message', e => void got.push(JSON.parse(String(e.data))))
  let closed = false
  return {
    got,
    send: async m => ws.send(JSON.stringify(m)),
    close: async () => {
      // a socket closes once; the suite closes twice to check the room says one leave
      if (!closed) ws.close(1000)
      closed = true
    },
  }
}

const ticketFor = (a: Admission, secondsLeft = 60) =>
  signTicket(SECRET, a, new Date(Date.now() + secondsLeft * 1000))

describe('LiveRoom (Durable Object)', () => {
  it('refuses a bad or expired ticket, and a request that is not an upgrade', async () => {
    const url = 'https://app.example.test/api/live?ticket='
    const bad = await mf.dispatchFetch(`${url}nope`, { headers: { upgrade: 'websocket' } })
    expect(bad.status).toBe(401)
    const expired = ticketFor(admission('S0', 'A'), -1)
    const late = await mf.dispatchFetch(`${url}${expired}`, { headers: { upgrade: 'websocket' } })
    expect(late.status).toBe(401)
    expect((await mf.dispatchFetch(`${url}${ticketFor(admission('S0', 'A'))}`)).status).toBe(426)
  })
})

liveHubConformance('DurableObjectLiveHub', () => ({
  async publish(siteId, message) {
    const res = await mf.dispatchFetch(`https://app.example.test/publish/${siteId}`, {
      method: 'POST',
      body: JSON.stringify(message),
    })
    if (!res.ok) throw new Error(`publish answered ${res.status}`)
  },
  connect: a => connect(ticketFor(a)),
}))
