/**
 * Live rooms on Cloudflare: the `LiveRoom` Durable Object with hibernatable sockets and the
 * Worker's ticket check, in workerd (Miniflare), over real WebSockets.
 */
import { join } from 'node:path'
import { type Admission, signTicket } from '@fling/api/live'
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

interface Client {
  got: LiveServerMessage[]
  send(message: object): void
  /** the first message of `type` not taken yet, waiting for one */
  next(type: string): Promise<LiveServerMessage>
  close(): void
}

async function connect(ticket: string): Promise<Client> {
  const res = await mf.dispatchFetch(
    `https://app.example.test/api/live?ticket=${encodeURIComponent(ticket)}`,
    { headers: { upgrade: 'websocket' } }
  )
  const ws = res.webSocket
  if (!ws) throw new Error(`no socket: ${res.status}`)
  ws.accept()
  const got: LiveServerMessage[] = []
  const waiting: (() => void)[] = []
  ws.addEventListener('message', e => {
    got.push(JSON.parse(String(e.data)))
    for (const w of waiting.splice(0)) w()
  })
  const taken = new Set<number>()
  return {
    got,
    send: m => ws.send(JSON.stringify(m)),
    async next(type) {
      for (;;) {
        const i = got.findIndex((m, n) => !taken.has(n) && m.type === type)
        if (i >= 0) {
          taken.add(i)
          return got[i] as LiveServerMessage
        }
        await new Promise<void>(r => waiting.push(r))
      }
    },
    close: () => ws.close(1000),
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

  it('welcomes, announces joins and leaves, relays pointers to others only, publishes', async () => {
    const siteId = `S-${crypto.randomUUID()}`
    const a = await connect(ticketFor(admission(siteId, 'Alice')))
    a.send({ type: 'hello' })
    const welcomeA = await a.next('welcome')
    expect(welcomeA).toMatchObject({ you: { name: 'Alice' }, peers: [] })

    const b = await connect(ticketFor(admission(siteId, 'Bob')))
    const joined = await a.next('join')
    b.send({ type: 'hello' })
    const welcomeB = await b.next('welcome')
    expect(welcomeB).toMatchObject({ you: { name: 'Bob' }, peers: [{ name: 'Alice' }] })
    expect(joined).toMatchObject({ peer: { name: 'Bob' } })

    const cursor = { type: 'cursor', path: '/', hash: '', anchor: { x: 1, y: 2 } }
    a.send(cursor)
    a.send({ type: 'ping' })
    expect(await b.next('cursor')).toEqual({
      ...cursor,
      peerId: (welcomeA as { you: { id: string } }).you.id,
    })
    await a.next('pong')
    expect(a.got.some(m => m.type === 'cursor')).toBe(false)

    await mf.dispatchFetch(`https://app.example.test/publish/${siteId}`, { method: 'POST' })
    await a.next('comments')
    await b.next('comments')

    a.close()
    expect(await b.next('leave')).toEqual({
      type: 'leave',
      peerId: (welcomeA as { you: { id: string } }).you.id,
    })
    b.close()
  })
})
