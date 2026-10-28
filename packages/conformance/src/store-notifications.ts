/**
 * Store conformance for notifications: preferences, and the outbox the drainer works through
 * (idempotent events, folding into one batch, leases, the cool-down, the cursor, the counters),
 * including the races the outbox exists to survive. Part of `storeConformance`.
 *
 * Outbox partitions are per minute and shared by everything due then, so each test works in its
 * own random minute far in the future (which also keeps every item clear of expiry) and with
 * fresh addresses; a shared table needs no cleanup.
 */
import { randomInt, randomUUID } from 'node:crypto'
import type {
  BatchRef,
  Minute,
  NotificationBatchRecord,
  PendingNotificationRecord,
  Store,
} from '@fling/api/store'
import { describe, expect, it } from 'vitest'

const uid = () => randomUUID().replaceAll('-', '').slice(0, 12)
const email = () => `n-${uid()}@example.test`

/** A random minute between the years 2200 and about 2960. */
function minute(): Minute {
  const ms = Date.UTC(2200, 0, 1) + randomInt(0, 400_000_000) * 60_000
  return new Date(ms).toISOString().slice(0, 16)
}
const plus = (m: Minute, n: number) =>
  new Date(Date.parse(`${m}:00.000Z`) + n * 60_000).toISOString().slice(0, 16)
const at = (m: Minute, seconds = 0) =>
  new Date(Date.parse(`${m}:00.000Z`) + seconds * 1000).toISOString()

function pending(
  to: string,
  m: Minute,
  overrides: Partial<PendingNotificationRecord> = {}
): Omit<PendingNotificationRecord, 'expiresAt'> {
  return {
    email: to,
    channel: 'email',
    batchSiteId: 'site1',
    eventId: `comment.created:site1:${uid()}`,
    key: 'comment.created',
    siteId: 'site1',
    actor: 'actor@example.test',
    excerpt: 'Looks good',
    createdAt: at(m),
    ...overrides,
  }
}

const ref = (b: NotificationBatchRecord): BatchRef => ({
  email: b.email,
  channel: b.channel,
  siteId: b.siteId,
  due: b.due,
})

export function notificationStoreConformance(factory: () => Store | Promise<Store>) {
  describe('notification preferences', () => {
    it('are null until written; a write keeps only known events and channels', async () => {
      const store = await factory()
      const e = email()
      expect(await store.getNotificationPreferences(e)).toBeNull()
      const cells = {
        'comment.created': { email: 'off' },
        'site.gone': { email: 'off' },
        'comment.reply': { email: 'on', pigeon: 'off' },
      } as never
      const written = await store.putNotificationPreferences(
        e,
        { muted: true, cells },
        at(minute())
      )
      expect(written.cells).toEqual({
        'comment.created': { email: 'off' },
        'comment.reply': { email: 'on' },
      })
      expect(await store.getNotificationPreferences(e)).toEqual(written)
      await store.putNotificationPreferences(e, { muted: false, cells: {} }, written.updatedAt)
      expect(await store.getNotificationPreferences(e)).toMatchObject({ muted: false, cells: {} })
    })
  })

  describe('notification events', () => {
    it('are written once with their fan-out marker; a repeat writes nothing', async () => {
      const store = await factory()
      const m = minute()
      const event = {
        id: `site.shared:${uid()}:${at(m)}`,
        key: 'site.shared' as const,
        actor: email(),
        siteId: uid(),
        data: { emails: [email()] },
        createdAt: at(m),
      }
      expect(await store.putNotificationEvent(event, m)).toBe(true)
      expect(await store.putNotificationEvent({ ...event, data: { other: true } }, m)).toBe(false)
      expect(await store.getNotificationEvent(event.id)).toMatchObject(event)
      const due = await store.listDueNotifications(m)
      expect(due.fanOuts).toEqual([expect.objectContaining({ eventId: event.id, due: m, done: 0 })])
      expect(due.batches).toEqual([])
      await store.saveFanOutProgress(m, event.id, 7)
      expect((await store.listDueNotifications(m)).fanOuts[0]?.done).toBe(7)
      const later = plus(m, 1)
      await store.moveFanOut(m, later, event.id)
      expect((await store.listDueNotifications(m)).fanOuts).toEqual([])
      expect((await store.listDueNotifications(later)).fanOuts).toEqual([
        expect.objectContaining({ eventId: event.id, due: later, done: 7 }),
      ])
      await store.finishFanOut(later, event.id)
      expect((await store.listDueNotifications(later)).fanOuts).toEqual([])
      expect(await store.getNotificationEvent(event.id)).not.toBeNull()
    })
  })

  describe('batches', () => {
    it('folds notifications into the open batch while it is due; a leased one is left alone', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const a = await store.queueNotification(pending(to, m), plus(m, 2))
      expect(a).toMatchObject({ opened: true, queued: true })
      expect(a.batch).toMatchObject({ email: to, siteId: 'site1', due: plus(m, 2), state: 'due' })
      const b = await store.queueNotification(pending(to, m), plus(m, 3))
      expect(b).toMatchObject({ opened: false, queued: true })
      expect(b.batch.id).toBe(a.batch.id)
      // Another site, and no site, are batches of their own.
      const other = await store.queueNotification(
        pending(to, m, { batchSiteId: null, key: 'site.shared' }),
        plus(m, 2)
      )
      expect(other.opened).toBe(true)
      expect(other.batch.id).not.toBe(a.batch.id)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toHaveLength(2)
      expect(await store.listPendingNotifications(to, 'email', null)).toHaveLength(1)
      const due = await store.listDueNotifications(plus(m, 2))
      expect(
        due.batches
          .filter(x => x.email === to)
          .map(x => x.id)
          .sort()
      ).toEqual([a.batch.id, other.batch.id].sort())

      const leased = await store.leaseNotificationBatch(ref(a.batch), at(m, 120), at(m, 180))
      expect(leased).toMatchObject({ id: a.batch.id, state: 'leased', leaseUntil: at(m, 180) })
      const c = await store.queueNotification(pending(to, m), plus(m, 4))
      expect(c.opened).toBe(true)
      expect(c.batch.due).toBe(plus(m, 4))
      expect(c.batch.id).not.toBe(a.batch.id)
      expect((await store.getBatchPointer(to, 'email', 'site1'))?.due).toBe(plus(m, 4))
    })

    it('a repeated notification is not queued twice', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const item = pending(to, m)
      const first = await store.queueNotification(item, plus(m, 2))
      const again = await store.queueNotification(item, plus(m, 2))
      expect(again).toMatchObject({ queued: false, opened: false })
      expect(again.batch.id).toBe(first.batch.id)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toHaveLength(1)
    })

    it('race: concurrent fan-outs for one recipient open one batch and queue everything', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.queueNotification(pending(to, m), plus(m, 2)))
      )
      expect(results.filter(r => r.opened)).toHaveLength(1)
      expect(new Set(results.map(r => r.batch.id)).size).toBe(1)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toHaveLength(6)
      const due = await store.listDueNotifications(plus(m, 2))
      expect(due.batches.filter(b => b.email === to)).toHaveLength(1)
    })

    it('race: concurrent leases of one batch → exactly one wins; an expired lease is taken over', async () => {
      const store = await factory()
      const m = minute()
      const { batch } = await store.queueNotification(pending(email(), m), plus(m, 2))
      const leases = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.leaseNotificationBatch(ref(batch), at(m, 120), at(m, 180))
        )
      )
      const won = leases.filter(l => l !== null)
      expect(won).toHaveLength(1)
      expect(await store.leaseNotificationBatch(ref(batch), at(m, 179), at(m, 240))).toBeNull()
      const takeovers = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.leaseNotificationBatch(ref(batch), at(m, 180), at(m, 300))
        )
      )
      const taken = takeovers.filter(l => l !== null)
      expect(taken).toHaveLength(1)
      expect(taken[0]?.lease).not.toBe(won[0]?.lease)
      // The first drainer's lease is gone: finishing changes nothing.
      const stale = won[0] as NotificationBatchRecord
      expect(
        await store.finishNotificationBatch(stale, { eventIds: [], coolDownUntil: null })
      ).toBe(false)
      expect(await store.rescheduleNotificationBatch(stale, plus(m, 10), 1)).toBe('lost')
      expect((await store.listDueNotifications(batch.due)).batches.map(b => b.id)).toContain(
        batch.id
      )
    })

    it('finishing deletes the batch and what it sent, records it and starts the cool-down', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const items = Array.from({ length: 30 }, () => pending(to, m))
      let batch: NotificationBatchRecord | undefined
      for (const item of items) batch = (await store.queueNotification(item, plus(m, 2))).batch
      const leased = await store.leaseNotificationBatch(
        ref(batch as NotificationBatchRecord),
        at(m, 120),
        at(m, 180)
      )
      if (!leased) throw new Error('not leased')
      const sent = await store.listPendingNotifications(to, 'email', 'site1')
      expect(sent).toHaveLength(30)
      // One more arrives during the send: it waits for the next batch.
      const lateItem = pending(to, m)
      const late = await store.queueNotification(lateItem, plus(m, 3))
      expect(late.opened).toBe(true)
      const coolDownUntil = at(m, 17 * 60 + 30)
      const done = await store.finishNotificationBatch(leased, {
        eventIds: sent.map(p => p.eventId),
        coolDownUntil,
        sent: {
          id: `${m}-sent`,
          email: to,
          channel: 'email',
          batchId: leased.id,
          siteId: 'site1',
          eventIds: sent.map(p => p.eventId),
          eventKeys: ['comment.created'],
          subject: '30 comments',
          providerId: 'p-1',
          sentAt: at(m, 121),
        },
      })
      expect(done).toBe(true)
      const left = await store.listPendingNotifications(to, 'email', 'site1')
      expect(left.map(p => p.eventId)).toEqual([lateItem.eventId])
      expect((await store.listDueNotifications(plus(m, 2))).batches.map(b => b.id)).not.toContain(
        leased.id
      )
      expect(await store.listSentNotifications(to, 10)).toEqual([
        expect.objectContaining({ batchId: leased.id, subject: '30 comments', providerId: 'p-1' }),
      ])
      // The pointer names the batch opened meanwhile, and now carries the cool-down.
      expect(await store.getBatchPointer(to, 'email', 'site1')).toMatchObject({
        due: plus(m, 3),
        coolDownUntil,
      })
    })

    it('respects the cool-down: the next batch is due no sooner than it ends', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const first = await store.queueNotification(pending(to, m), plus(m, 2))
      const leased = await store.leaseNotificationBatch(ref(first.batch), at(m, 120), at(m, 180))
      if (!leased) throw new Error('not leased')
      const items = await store.listPendingNotifications(to, 'email', 'site1')
      const coolDownUntil = at(m, 17 * 60 + 30)
      expect(
        await store.finishNotificationBatch(leased, {
          eventIds: items.map(p => p.eventId),
          coolDownUntil,
        })
      ).toBe(true)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toEqual([])
      const pointer = await store.getBatchPointer(to, 'email', 'site1')
      expect(pointer).toMatchObject({ coolDownUntil })
      expect(pointer?.due).toBeUndefined()
      // Rounded up to the minute the cool-down ends in.
      const next = await store.queueNotification(pending(to, m), plus(m, 5))
      expect(next).toMatchObject({ opened: true })
      expect(next.batch.due).toBe(plus(m, 18))
      // Past the cool-down, `earliest` applies.
      const other = email()
      const plain = await store.queueNotification(pending(other, m), plus(m, 2))
      const l2 = await store.leaseNotificationBatch(ref(plain.batch), at(m, 120), at(m, 180))
      if (!l2) throw new Error('not leased')
      await store.finishNotificationBatch(l2, { eventIds: [], coolDownUntil: at(m, 300) })
      expect((await store.queueNotification(pending(other, m), plus(m, 9))).batch.due).toBe(
        plus(m, 9)
      )
      // Without a cool-down the pointer is closed.
      const third = email()
      const q = await store.queueNotification(pending(third, m), plus(m, 2))
      const l3 = await store.leaseNotificationBatch(ref(q.batch), at(m, 120), at(m, 180))
      if (!l3) throw new Error('not leased')
      await store.finishNotificationBatch(l3, { eventIds: [], coolDownUntil: null })
      expect(await store.getBatchPointer(third, 'email', 'site1')).toBeNull()
    })

    it('rescheduling moves a batch to a later minute, due again and still folding', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const { batch } = await store.queueNotification(pending(to, m), plus(m, 2))
      const leased = await store.leaseNotificationBatch(ref(batch), at(m, 120), at(m, 180))
      if (!leased) throw new Error('not leased')
      expect(await store.rescheduleNotificationBatch(leased, plus(m, 7), 1)).toBe('moved')
      expect((await store.listDueNotifications(plus(m, 2))).batches.map(b => b.id)).not.toContain(
        batch.id
      )
      const moved = (await store.listDueNotifications(plus(m, 7))).batches.find(
        b => b.id === batch.id
      )
      expect(moved).toMatchObject({ state: 'due', attempts: 1, due: plus(m, 7) })
      expect(moved?.lease).toBeUndefined()
      const folded = await store.queueNotification(pending(to, m), plus(m, 3))
      expect(folded).toMatchObject({ opened: false })
      expect(folded.batch.id).toBe(batch.id)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toHaveLength(2)
    })

    it('rescheduling a batch another batch has superseded merges it into that one', async () => {
      const store = await factory()
      const m = minute()
      const to = email()
      const { batch } = await store.queueNotification(pending(to, m), plus(m, 2))
      const leased = await store.leaseNotificationBatch(ref(batch), at(m, 120), at(m, 180))
      if (!leased) throw new Error('not leased')
      const newer = await store.queueNotification(pending(to, m), plus(m, 4))
      expect(await store.rescheduleNotificationBatch(leased, plus(m, 7), 1)).toBe('merged')
      expect((await store.listDueNotifications(plus(m, 7))).batches).toEqual([])
      expect((await store.listDueNotifications(plus(m, 2))).batches).toEqual([])
      expect((await store.getBatchPointer(to, 'email', 'site1'))?.due).toBe(newer.batch.due)
      expect(await store.listPendingNotifications(to, 'email', 'site1')).toHaveLength(2)
    })
  })

  describe('the drain cursor', () => {
    it('moves only from the value read', async () => {
      const store = await factory()
      const start = await store.getNotifyCursor()
      const m = minute()
      expect(await store.setNotifyCursor(m, start)).toBe(true)
      expect(await store.getNotifyCursor()).toBe(m)
      expect(await store.setNotifyCursor(plus(m, 1), start)).toBe(false)
      const racing = await Promise.all([
        store.setNotifyCursor(plus(m, 1), m),
        store.setNotifyCursor(plus(m, 2), m),
      ])
      expect(racing.filter(Boolean)).toHaveLength(1)
    })
  })

  describe('counters, records and suppression', () => {
    it('counts concurrently without losing any', async () => {
      const store = await factory()
      const e = email()
      const hour = minute().slice(0, 13)
      const counts = await Promise.all(
        Array.from({ length: 6 }, () => store.countRecipientSend(e, hour))
      )
      expect([...counts].sort()).toEqual([1, 2, 3, 4, 5, 6])
      expect(await store.recipientSends(e, hour)).toBe(6)
      expect(await store.recipientSends(email(), hour)).toBe(0)
      const m = minute()
      expect(await store.countInstanceSend(m)).toBe(1)
      expect(await store.countInstanceSend(m)).toBe(2)
      expect(await store.mailTests(e, hour)).toBe(0)
      expect(await store.countMailTest(e, hour)).toBe(1)
      expect(await store.countMailTest(e, hour)).toBe(2)
      expect(await store.mailTests(e, hour)).toBe(2)
    })

    it('adds to the hourly stats and lists them from an hour on', async () => {
      const store = await factory()
      const m = minute()
      const hour = m.slice(0, 13)
      const next = plus(m, 60).slice(0, 13)
      await Promise.all([
        store.addNotifyStats(hour, { sent: 2 }),
        store.addNotifyStats(hour, { sent: 1, retrying: 1 }),
        store.addNotifyStats(next, { givenUp: 1 }),
      ])
      const stats = await store.listNotifyStats(hour)
      expect(stats.find(s => s.hour === hour)).toEqual({
        hour,
        sent: 3,
        retrying: 1,
        givenUp: 0,
        suppressed: 0,
        dropped: 0,
      })
      expect(stats.find(s => s.hour === next)).toMatchObject({ givenUp: 1, sent: 0 })
      expect((await store.listNotifyStats(next)).map(s => s.hour)).not.toContain(hour)
    })

    it('lists failures newest first', async () => {
      const store = await factory()
      const batchId = uid()
      for (const [i, reason] of ['throttled', 'rejected'].entries()) {
        await store.addNotifyFailure({
          at: at('2999-12-31T23:58', i),
          batchId,
          eventKeys: ['comment.reply'],
          reason,
          detail: `E${i}`,
        })
      }
      const failures = await store.listNotifyFailures(2)
      expect(failures.map(f => [f.batchId, f.reason])).toEqual([
        [batchId, 'rejected'],
        [batchId, 'throttled'],
      ])
    })

    it('suppression is per address', async () => {
      const store = await factory()
      const e = email()
      expect(await store.getSuppression(e)).toBeNull()
      const record = { email: e, kind: 'complaint' as const, at: at(minute()) }
      await store.putSuppression(record)
      expect(await store.getSuppression(e)).toEqual(record)
      expect(await store.getSuppression(email())).toBeNull()
    })
  })
}
