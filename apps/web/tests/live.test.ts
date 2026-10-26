import type { LivePeer } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  applyLiveMessage,
  cursorsAt,
  dropExited,
  EMERGE_STAGGER_MS,
  EMPTY_LIVE,
  initials,
  type LiveState,
  liveAnnouncement,
  liveSocketUrl,
  PRESENCE_SHOWN,
  type PresenceCircle,
  presenceCircles,
  reconcileCircles,
  reconnectDelay,
} from '../src/lib/live'

const peer = (id: string, name = id): LivePeer => ({ id, name, colour: 'hsl(1 75% 45%)' })

describe('live room helpers', () => {
  it('connects to the ticket URL as a socket URL, with the ticket', () => {
    const t = { ticket: 'a b+c', expiresIn: 60 }
    expect(liveSocketUrl({ ...t, url: 'wss://live.example.test/api/live' }, 'https://x/')).toBe(
      'wss://live.example.test/api/live?ticket=a+b%2Bc'
    )
    expect(liveSocketUrl({ ...t, url: '/api/live' }, 'http://fling.lvh.me:47100/review/x')).toBe(
      'ws://fling.lvh.me:47100/api/live?ticket=a+b%2Bc'
    )
  })

  it('backs off from about a second to about thirty', () => {
    expect(reconnectDelay(0, () => 0.5)).toBe(1000)
    expect(reconnectDelay(3, () => 0.5)).toBe(8000)
    expect(reconnectDelay(50, () => 0.5)).toBe(30_000)
    expect(reconnectDelay(0, () => 0)).toBe(750)
  })

  it('tracks who is here and where their pointers are', () => {
    let s = applyLiveMessage(EMPTY_LIVE, {
      type: 'welcome',
      you: peer('me'),
      peers: [peer('me'), peer('a')],
    })
    expect(s.peers.map(p => p.id)).toEqual(['a'])
    s = applyLiveMessage(s, { type: 'join', peer: peer('b') })
    s = applyLiveMessage(s, { type: 'join', peer: peer('me') })
    expect(s.peers.map(p => p.id)).toEqual(['a', 'b'])
    s = applyLiveMessage(s, {
      type: 'cursor',
      peerId: 'a',
      path: '/docs/',
      hash: '',
      anchor: { x: 1, y: 2 },
    })
    s = applyLiveMessage(s, {
      type: 'cursor',
      peerId: 'b',
      path: '/docs/',
      hash: '#x',
      anchor: { x: 3, y: 4 },
    })
    expect(cursorsAt(s.peers, { path: '/docs/', hash: '' })).toEqual([
      { id: 'a', name: 'a', colour: 'hsl(1 75% 45%)', anchor: { x: 1, y: 2 } },
    ])
    s = applyLiveMessage(s, { type: 'cursor', peerId: 'a', path: '/docs/', hash: '', anchor: null })
    expect(cursorsAt(s.peers, { path: '/docs/', hash: '' })).toEqual([])
    s = applyLiveMessage(s, { type: 'leave', peerId: 'b' })
    expect(s.peers.map(p => p.id)).toEqual(['a'])
    expect(applyLiveMessage(s, { type: 'comments' })).toBe(s)
  })

  it("keeps a join that arrives before this connection's welcome", () => {
    let s = applyLiveMessage(EMPTY_LIVE, { type: 'join', peer: peer('early') })
    s = applyLiveMessage(s, { type: 'welcome', you: peer('me'), peers: [peer('a')] })
    expect(s.you?.id).toBe('me')
    expect(s.peers.map(p => p.id)).toEqual(['a', 'early'])
  })

  it('makes initials from the first and last words, splitting email-style names too', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('Ada King Lovelace')).toBe('AL')
    expect(initials('clifton.cunningham')).toBe('CC')
    expect(initials('mary_jane-watson')).toBe('MW')
    expect(initials('bob')).toBe('B')
    expect(initials('  ')).toBe('?')
  })
})

describe('presence circles', () => {
  const room = (you: LivePeer, ...others: [LivePeer, string | null][]): LiveState => ({
    you,
    peers: others.map(([p, page]) => ({ ...p, cursor: null, page })),
  })
  const at = { path: '/docs/', hash: '' }

  it('puts you first, then others in arrival order, one circle per person', () => {
    const ada = { id: 'a1', name: 'Ada', colour: 'red' }
    const { shown, more } = presenceCircles(
      room(
        { id: 'me', name: 'Me', colour: 'blue' },
        [ada, '/docs/'],
        [{ id: 'b1', name: 'Bob', colour: 'green' }, '/'],
        [{ ...ada, id: 'a2' }, null],
        [{ id: 'me2', name: 'Me', colour: 'blue' }, '/'],
        [{ id: 'c1', name: 'Ada', colour: 'pink' }, null]
      ),
      at
    )
    expect(more).toEqual([])
    expect(shown.map(c => [c.name, c.colour, c.you, c.here, c.page])).toEqual([
      ['Me', 'blue', true, true, '/docs/'],
      ['Ada', 'red', false, true, '/docs/'],
      ['Bob', 'green', false, false, '/'],
      ['Ada', 'pink', false, false, null],
    ])
  })

  it(`folds everyone after ${PRESENCE_SHOWN} circles into more`, () => {
    const others = Array.from({ length: PRESENCE_SHOWN + 2 }, (_, i): [LivePeer, null] => [
      peer(`p${i}`),
      null,
    ])
    const { shown, more } = presenceCircles(room(peer('me'), ...others), at)
    expect(shown).toHaveLength(PRESENCE_SHOWN)
    expect(shown[0].you).toBe(true)
    expect(more.map(c => c.name)).toEqual(['p4', 'p5', 'p6'])
  })

  it('enters new circles staggered, keeps known ones, and lets leavers finish leaving', () => {
    const c = (name: string): PresenceCircle => ({
      key: name,
      name,
      colour: 'red',
      you: false,
      page: null,
      here: false,
    })
    let drawn = reconcileCircles([], [c('me'), c('a'), c('b')])
    expect(drawn.map(d => [d.circle.key, d.phase, d.delay])).toEqual([
      ['me', 'enter', 0],
      ['a', 'enter', EMERGE_STAGGER_MS],
      ['b', 'enter', 2 * EMERGE_STAGGER_MS],
    ])
    drawn = reconcileCircles(drawn, [c('me'), c('b'), c('d')])
    expect(drawn.map(d => [d.circle.key, d.phase, d.delay])).toEqual([
      ['me', 'enter', 0],
      ['a', 'exit', 0],
      ['b', 'enter', 2 * EMERGE_STAGGER_MS],
      ['d', 'enter', 0],
    ])
    // a comes back before its exit ends: it enters again, in place
    const back = reconcileCircles(drawn, [c('me'), c('a'), c('b'), c('d')])
    expect(back.map(d => [d.circle.key, d.phase])).toEqual([
      ['me', 'enter'],
      ['a', 'enter'],
      ['b', 'enter'],
      ['d', 'enter'],
    ])
    expect(dropExited(drawn, 'a').map(d => d.circle.key)).toEqual(['me', 'b', 'd'])
    expect(dropExited(drawn, 'b')).toHaveLength(4)
  })
})

describe('announcements', () => {
  it('welcomes you with how many others are here', () => {
    expect(
      liveAnnouncement(EMPTY_LIVE, { type: 'welcome', you: peer('me'), peers: [peer('me')] })
    ).toEqual({ text: "You're the first here", colour: 'hsl(1 75% 45%)' })
    expect(
      liveAnnouncement(EMPTY_LIVE, {
        type: 'welcome',
        you: peer('me'),
        peers: [peer('a'), peer('b')],
      })?.text
    ).toBe("You're live — 2 others here")
  })

  it('announces a newcomer, but not their second tab or joins before your welcome', () => {
    const ada = peer('a1', 'Ada')
    expect(liveAnnouncement(EMPTY_LIVE, { type: 'join', peer: ada })).toBeNull()
    const s = applyLiveMessage(EMPTY_LIVE, { type: 'welcome', you: peer('me'), peers: [] })
    expect(liveAnnouncement(s, { type: 'join', peer: ada })?.text).toBe('Ada joined')
    const withAda = applyLiveMessage(s, { type: 'join', peer: ada })
    expect(liveAnnouncement(withAda, { type: 'join', peer: { ...ada, id: 'a2' } })).toBeNull()
  })
})
