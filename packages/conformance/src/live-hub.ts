/**
 * Live hub conformance: what review mode's live rooms rely on from every hub, whatever keeps its
 * connections (sockets in memory, a Durable Object's hibernatable sockets, stored records behind
 * API Gateway). What a room does is the core's (`@fling/api/live`); this proves each hub carries
 * it out the same way:
 *
 * - `hello` is answered with `welcome`: the connection's own peer and everyone else in its room;
 * - a newcomer is announced to the others (`join`), never to itself, and a close to the rest
 *   (`leave`);
 * - pointers reach the room's others stamped with the sender's peer id, never the sender;
 *   `ping` is answered with `pong`;
 * - `publish` reaches every connection in the site's room and none in another room, and a room
 *   nobody is in is not an error;
 * - a connection that closed, or whose transport is gone, gets nothing more, does not stop the
 *   others hearing, and is no longer one of the room's peers.
 *
 * Adapters run it from their own test files with a harness that drives the hub as its platform
 * does: the WebSocket server's events, the Durable Object over real sockets, API Gateway's
 * `$connect`, `$default` and `$disconnect` events with the management API faked.
 */
import type { Admission } from '@fling/api/live'
import type { LivePeer, LiveServerMessage } from '@fling/shared'
import { describe, expect, it } from 'vitest'

/** One connection, as its client sees it. */
export interface LiveHubClient {
  /** every message the client received, in order */
  readonly got: LiveServerMessage[]
  send(message: object): Promise<void>
  /** the client closes its connection (the hub hears the close) */
  close(): Promise<void>
}

export interface LiveHubHarness {
  /** an admitted connection to `admission.siteId`'s room */
  connect(admission: Admission): Promise<LiveHubClient>
  /** the port: what the core calls after a change */
  publish(siteId: string, message: LiveServerMessage): Promise<void>
  /**
   * The client's transport goes without a close reaching the hub (a send to it fails from now
   * on). Leave it out where the platform can't stage that; the case is skipped.
   */
  drop?(client: LiveHubClient): Promise<void>
}

/** How long a message the hub sends may take to arrive. */
const ARRIVAL_MS = 5_000

/** The first message of `type` after the first `skip` of that type, waiting for it to arrive. */
async function next(
  client: LiveHubClient,
  type: LiveServerMessage['type'],
  skip = 0
): Promise<LiveServerMessage> {
  const deadline = Date.now() + ARRIVAL_MS
  for (;;) {
    const found = client.got.filter(m => m.type === type)[skip]
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`no ${type} arrived (got ${JSON.stringify(client.got.map(m => m.type))})`)
    }
    await new Promise(r => setTimeout(r, 5))
  }
}

/**
 * Wait until the hub has dealt with everything sent to `client` so far: one ping's pong comes
 * back on the same connection, after whatever the hub sent it before. A short pause then covers
 * hubs whose rooms deliver independently of each other.
 */
async function settled(client: LiveHubClient) {
  const pongs = client.got.filter(m => m.type === 'pong').length
  await client.send({ type: 'ping' })
  await next(client, 'pong', pongs)
  await new Promise(r => setTimeout(r, 25))
}

const admission = (siteId: string, name: string): Admission => ({
  siteId,
  siteName: 'hello',
  name,
  colour: 'red',
})

/** A room of its own for each case, so hubs that keep state across cases stay apart. */
const room = () => `S-${Math.random().toString(36).slice(2)}`

/** Connect and learn the connection's own peer. */
async function join(h: LiveHubHarness, siteId: string, name: string) {
  const client = await h.connect(admission(siteId, name))
  await client.send({ type: 'hello' })
  const welcome = (await next(client, 'welcome')) as Extract<LiveServerMessage, { type: 'welcome' }>
  return { client, peer: welcome.you, welcome }
}

const ids = (peers: LivePeer[]) => peers.map(p => p.id).sort()

export function liveHubConformance(
  name: string,
  make: () => LiveHubHarness | Promise<LiveHubHarness>
) {
  describe(`${name} (live hub conformance)`, () => {
    it('welcomes a connection with its own peer and the others in its room only', async () => {
      const h = await make()
      const site = room()
      const alice = await join(h, site, 'Alice')
      expect(alice.peer).toMatchObject({ name: 'Alice', colour: 'red' })
      expect(alice.welcome.peers).toEqual([])
      await join(h, room(), 'Elsewhere')
      const bob = await join(h, site, 'Bob')
      expect(ids(bob.welcome.peers)).toEqual([alice.peer.id])
      expect(bob.peer.id).not.toBe(alice.peer.id)
      await Promise.all([alice.client.close(), bob.client.close()])
    })

    it('announces a newcomer to the others, never to itself, and a close to the rest', async () => {
      const h = await make()
      const site = room()
      const alice = await join(h, site, 'Alice')
      const other = await join(h, room(), 'Elsewhere')
      const bob = await join(h, site, 'Bob')
      expect(await next(alice.client, 'join')).toEqual({ type: 'join', peer: bob.peer })
      await settled(bob.client)
      expect(bob.client.got.some(m => m.type === 'join')).toBe(false)
      await bob.client.close()
      expect(await next(alice.client, 'leave')).toEqual({ type: 'leave', peerId: bob.peer.id })
      await settled(other.client)
      expect(other.client.got.some(m => m.type === 'join' || m.type === 'leave')).toBe(false)
      await Promise.all([alice.client.close(), other.client.close()])
    })

    it("relays a pointer to the room's others, stamped with the sender, and answers ping", async () => {
      const h = await make()
      const site = room()
      const alice = await join(h, site, 'Alice')
      const bob = await join(h, site, 'Bob')
      const other = await join(h, room(), 'Elsewhere')
      const cursor = { type: 'cursor', path: '/', hash: '', anchor: null }
      await alice.client.send({ ...cursor, peerId: 'someone-else' })
      expect(await next(bob.client, 'cursor')).toEqual({ ...cursor, peerId: alice.peer.id })
      await Promise.all([settled(alice.client), settled(other.client)])
      expect(alice.client.got.some(m => m.type === 'cursor')).toBe(false)
      expect(other.client.got.some(m => m.type === 'cursor')).toBe(false)
      await Promise.all([alice.client.close(), bob.client.close(), other.client.close()])
    })

    it('ignores what is not in the protocol', async () => {
      const h = await make()
      const alice = await join(h, room(), 'Alice')
      const before = alice.client.got.length
      await alice.client.send({ type: 'shout', text: 'hi' })
      await settled(alice.client)
      expect(alice.client.got.slice(before).map(m => m.type)).toEqual(['pong'])
      await alice.client.close()
    })

    it("publishes to every connection in the site's room and none in another", async () => {
      const h = await make()
      const site = room()
      const alice = await join(h, site, 'Alice')
      const bob = await join(h, site, 'Bob')
      const other = await join(h, room(), 'Elsewhere')
      await h.publish(site, { type: 'comments' })
      await next(alice.client, 'comments')
      await next(bob.client, 'comments')
      await settled(other.client)
      expect(other.client.got.some(m => m.type === 'comments')).toBe(false)
      await h.publish(room(), { type: 'comments' })
      await Promise.all([alice.client.close(), bob.client.close(), other.client.close()])
    })

    it('sends nothing more to a closed connection, and leaves it out of the room', async () => {
      const h = await make()
      const site = room()
      const alice = await join(h, site, 'Alice')
      const bob = await join(h, site, 'Bob')
      await bob.client.close()
      await next(alice.client, 'leave')
      await bob.client.close() // twice is once
      const seen = bob.client.got.length
      await h.publish(site, { type: 'comments' })
      await next(alice.client, 'comments')
      const carol = await join(h, site, 'Carol')
      expect(ids(carol.welcome.peers)).toEqual([alice.peer.id])
      expect(bob.client.got.length).toBe(seen)
      await settled(alice.client)
      expect(alice.client.got.filter(m => m.type === 'leave')).toHaveLength(1)
      await Promise.all([alice.client.close(), carol.client.close()])
    })

    it('forgets a connection whose transport is gone, and the others still hear', async ctx => {
      const h = await make()
      if (!h.drop) return ctx.skip()
      const site = room()
      const alice = await join(h, site, 'Alice')
      const bob = await join(h, site, 'Bob')
      await h.drop(bob.client)
      await h.publish(site, { type: 'comments' })
      await next(alice.client, 'comments')
      await h.publish(site, { type: 'comments' })
      await next(alice.client, 'comments', 1)
      const carol = await join(h, site, 'Carol')
      expect(ids(carol.welcome.peers)).toEqual([alice.peer.id])
      await Promise.all([alice.client.close(), carol.client.close()])
    })
  })
}
