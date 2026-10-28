/**
 * Live rooms (live.ts, live-memory.ts): tickets (signed, short-lived, tamper-proof), who gets one
 * (policy, through POST /api/sites/:name/live), what a room does with each client message, the
 * in-process hub end to end over fake sockets, and comments telling the room they changed.
 */
import type { LiveServerMessage } from '@fling/shared'
import { LIVE_MESSAGE_MAX_BYTES } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  type Admission,
  admitTicket,
  LIVE_TICKET_TTL_SECONDS,
  type LiveHub,
  relay,
  signTicket,
} from '../src/live.ts'
import { MemoryLiveHub } from '../src/live-memory.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const SECRET = 's'.repeat(40)
const NOW = new Date('2026-01-01T00:00:00Z')
const LIVE = { live: true, liveUrl: 'wss://live.fling.test/live' }
const admission: Admission = {
  siteId: 'S1',
  siteName: 'hello',
  name: 'Alice',
  colour: 'hsl(1 75% 45%)',
}
const later = (s: number) => new Date(NOW.getTime() + s * 1000)

describe('tickets', () => {
  const ticket = signTicket(SECRET, admission, later(60))

  it('admit what they were signed for, until they expire', () => {
    expect(admitTicket(SECRET, ticket, NOW)).toEqual(admission)
    expect(admitTicket(SECRET, ticket, later(59))).toEqual(admission)
    expect(admitTicket(SECRET, ticket, later(60))).toBeNull()
  })

  it('refuse another key, a changed payload or signature, and junk', () => {
    expect(admitTicket('t'.repeat(40), ticket, NOW)).toBeNull()
    const [body, mac] = ticket.split('.') as [string, string]
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), s: 'S2' })
    ).toString('base64url')
    expect(admitTicket(SECRET, `${forged}.${mac}`, NOW)).toBeNull()
    expect(admitTicket(SECRET, `${body}.${mac.slice(1)}x`, NOW)).toBeNull()
    for (const junk of [null, undefined, '', 'x', 'a.b.c', `${body}.`, `.${mac}`]) {
      expect(admitTicket(SECRET, junk, NOW)).toBeNull()
    }
  })

  it('carry a profile picture when there is an https one', () => {
    const picture = 'https://img.example.test/a.png'
    const withPicture = signTicket(SECRET, { ...admission, picture }, later(60))
    expect(admitTicket(SECRET, withPicture, NOW)).toEqual({ ...admission, picture })
    const insecure = signTicket(SECRET, { ...admission, picture: 'http://x.test/a' }, later(60))
    expect(admitTicket(SECRET, insecure, NOW)).toEqual(admission)
  })

  it('carry no email', () => {
    const t = signTicket(SECRET, { ...admission, name: 'alice' }, later(60))
    expect(Buffer.from(t.split('.')[0] as string, 'base64url').toString()).not.toContain('@')
  })
})

describe('relay', () => {
  const peer = { id: 'p1', name: 'Alice', colour: 'red' }
  const cursor = { type: 'cursor', path: '/docs/', hash: '#a', anchor: { x: 1, y: 2 } }

  it('answers ping, welcomes hello, passes pointers on stamped with the sender', () => {
    expect(relay(peer, '{"type":"ping"}')).toEqual({ to: 'sender', message: { type: 'pong' } })
    expect(relay(peer, '{"type":"hello"}')).toEqual({ to: 'welcome' })
    expect(relay(peer, JSON.stringify({ ...cursor, peerId: 'someone-else' }))).toEqual({
      to: 'others',
      message: { ...cursor, peerId: 'p1' },
    })
    expect(relay(peer, new TextEncoder().encode('{"type":"ping"}'))).toMatchObject({ to: 'sender' })
  })

  it('ignores what is too large, not JSON, unknown or malformed', () => {
    const big = JSON.stringify({ ...cursor, hash: 'x'.repeat(LIVE_MESSAGE_MAX_BYTES) })
    for (const raw of [
      big,
      'not json',
      '{"type":"shout"}',
      '{"type":"cursor"}',
      '[]',
      'null',
      JSON.stringify({ ...cursor, anchor: { x: 'left' } }),
    ]) {
      expect(relay(peer, raw)).toBeNull()
    }
  })
})

/** A socket that records what it was sent. */
const socket = () => {
  const got: LiveServerMessage[] = []
  return { got, send: (data: string) => void got.push(JSON.parse(data)) }
}

describe('MemoryLiveHub', () => {
  it('welcomes, announces joins and leaves, never echoes a pointer, publishes to the room', async () => {
    const hub = new MemoryLiveHub()
    const [a, b, elsewhere] = [socket(), socket(), socket()]
    const ca = await hub.connect(admission, a)
    const cb = await hub.connect({ ...admission, name: 'Bob' }, b)
    await hub.connect({ ...admission, siteId: 'S2' }, elsewhere)
    expect(a.got).toEqual([{ type: 'join', peer: cb.peer }])
    expect(b.got).toEqual([])

    await cb.message('{"type":"hello"}')
    expect(b.got).toEqual([{ type: 'welcome', you: cb.peer, peers: [ca.peer] }])

    const cursor = { type: 'cursor', path: '/', hash: '', anchor: { x: 5, y: 6 } }
    await ca.message(JSON.stringify(cursor))
    expect(b.got.at(-1)).toEqual({ ...cursor, peerId: ca.peer.id })
    expect(a.got).toHaveLength(1)

    await hub.publish('S1', { type: 'comments' })
    expect(a.got.at(-1)).toEqual({ type: 'comments' })
    expect(b.got.at(-1)).toEqual({ type: 'comments' })
    expect(elsewhere.got).toEqual([])

    await ca.close()
    expect(b.got.at(-1)).toEqual({ type: 'leave', peerId: ca.peer.id })
    await ca.close() // twice is once
    expect(b.got.filter(m => m.type === 'leave')).toHaveLength(1)
  })
})

async function deploy(env: Env, key: string, name: string, access = 'members') {
  const files = [file('index.html', '<h1>hi</h1>')]
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    access,
  })
  const body = await json(res)
  await upload(env, body.uploads, files)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
}

describe('POST /api/sites/:name/live', () => {
  async function twoUsers(overrides = {}) {
    const env = setup(overrides)
    const alice = await createUser(env, 'alice@example.test')
    const bob = await createUser(env, 'bob@example.test')
    await deploy(env, alice.key, 'hello')
    return { env, alice, bob }
  }

  it('gives a member of the instance a ticket into the site’s room', async () => {
    const { env, bob } = await twoUsers(LIVE)
    const res = await api(env, bob.key, 'POST', '/api/sites/hello/live')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({
      url: LIVE.liveUrl,
      ticket: expect.any(String),
      expiresIn: LIVE_TICKET_TTL_SECONDS,
    })
    const site = await env.store.findSite('hello')
    expect(
      admitTicket(env.config.secrets.sessionSecret, body.ticket, env.deps.clock.now())
    ).toEqual({ siteId: site?.id, siteName: 'hello', name: 'Alice', colour: expect.any(String) })
  })

  it('is a 404 for a site nobody holds, and when live rooms are off; 401 signed out', async () => {
    const { env, bob } = await twoUsers(LIVE)
    expect((await api(env, bob.key, 'POST', '/api/sites/nope/live')).status).toBe(404)
    expect((await api(env, bob.key, 'POST', '/api/sites/NOT_A_NAME/live')).status).toBe(404)
    expect((await env.app.request('/api/sites/hello/live', { method: 'POST' })).status).toBe(401)
    const off = await twoUsers()
    expect((await api(off.env, off.bob.key, 'POST', '/api/sites/hello/live')).status).toBe(404)
    const noComments = await twoUsers({ ...LIVE, comments: false })
    const res = await api(noComments.env, noComments.bob.key, 'POST', '/api/sites/hello/live')
    expect(res.status).toBe(404)
  })
})

describe('comments tell the live room', () => {
  it('after adding, resolving, reopening and deleting', async () => {
    const env = setup(LIVE)
    const alice = await createUser(env)
    await deploy(env, alice.key, 'hello')
    const site = await env.store.findSite('hello')
    const published: [string, LiveServerMessage][] = []
    const hub: LiveHub = { publish: async (id, m) => void published.push([id, m]) }
    env.deps.live = hub
    const thread = await json(
      await api(env, alice.key, 'POST', '/api/sites/hello/comments', { body: 'Hi', path: '/' })
    )
    await api(env, alice.key, 'PATCH', `/api/sites/hello/comments/${thread.id}`, { resolved: true })
    await api(env, alice.key, 'PATCH', `/api/sites/hello/comments/${thread.id}`, {
      resolved: false,
    })
    await api(env, alice.key, 'DELETE', `/api/sites/hello/comments/${thread.id}`)
    expect(published).toEqual(Array(4).fill([site?.id, { type: 'comments' }]))
  })

  it('a hub that fails does not fail the change', async () => {
    const env = setup(LIVE)
    const alice = await createUser(env)
    await deploy(env, alice.key, 'hello')
    env.deps.live = {
      publish: async () => {
        throw new Error('room unreachable')
      },
    }
    const res = await api(env, alice.key, 'POST', '/api/sites/hello/comments', { body: 'Hi' })
    expect(res.status).toBe(201)
  })
})
