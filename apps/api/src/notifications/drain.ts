/**
 * The drainer: what each platform's one-minute tick calls (the Cloudflare cron, the AWS scheduler's
 * `{"fling":"notify"}`). It walks the outbox a minute at a time from the cursor (the last minute
 * fully drained) to now, and for each minute:
 *
 * 1. leases each batch due then and delivers it: the send-time checks (resolve.ts; the email policy
 *    and suppression per address), the per-recipient limit (10 an hour: the batch moves to the next
 *    hour and keeps folding) and the instance's per-minute limit (the drain stops; the next tick
 *    goes on), then one message through the channel. Once the provider has accepted it, the batch
 *    is marked sent before any bookkeeping, and nothing after that can send it again: a failed
 *    bookkeeping step is logged, and a later lease finishes a batch marked sent without sending.
 *    Finishing deletes the batch and the pending items it loaded, starts the cool-down for comment
 *    events (15 minutes) and records the message (`NSENT`). A provider's refusal:
 *    `throttled`/`transient` retry after 1, 5, 15, 60 minutes and give up after 6 attempts; the
 *    daily quota moves the batch to the next UTC day without using an attempt; `rejected`
 *    (misconfiguration, logged as an error) and `suppressed` (remembered for 30 days) drop it.
 * 2. fans out each event due then: one pending notification per recipient and channel
 *    (recipients.ts), folded into the recipient's open batch for the site (or `-`), which is due
 *    2 minutes after the event, or when the recipient's cool-down for that site ends. Fan-outs get
 *    at most half of a drain's time, so a large one never holds up the batches of later minutes.
 *    One that runs out of time moves to the first minute the walk has yet to reach, with its
 *    progress (the last address queued, in address order); one that fails moves on with backoff
 *    and is given up after 5 attempts. Either way the minute is done, so the cursor goes on. An
 *    event with more than 100 recipients is logged by count.
 *
 * The cursor only moves past a minute once everything in it is done; a minute that is not (a
 * batch another drain holds) keeps the cursor before it while the walk goes on to later minutes.
 * The walk stops a little behind the clock (`LAG_MS`), so an event recorded in a minute is always
 * there before the minute is read, and nothing is ever queued or rescheduled into a minute the walk
 * has passed (`floor`). Overlapping drains are safe: leases, the cursor's compare-and-set and
 * idempotent queueing keep every message to one send (but for a crash between the provider
 * accepting it and the batch being marked sent).
 *
 * Logs name batches by id, events by key and recipients by `addressHash`.
 */
import { type EventKey, eventDefinition } from '@fling/shared'
import { emailAllowed } from '../auth/identity.ts'
import { newSortableId } from '../lib/ids.ts'
import {
  addMinutes,
  type BatchSent,
  type FanOutRecord,
  hourOf,
  type Minute,
  minuteOf,
  minuteStart,
  type NotificationBatchRecord,
  type NotifyCounter,
  type PendingNotificationRecord,
} from '../store/types.ts'
import type { Deps } from '../types.ts'
import { type AnyDeliveryItem, type Channel, channelsOf, type DeliveryResult } from './channel.ts'
import { addressHash, errorName, logNotify } from './log.ts'
import { recipientsOf } from './recipients.ts'
import { Resolver } from './resolve.ts'

/** A batch is due this long after its first notification; what arrives meanwhile folds in. */
export const FOLD_MINUTES = 2
/** After a message about a site's comments, the recipient's next one for it waits this long. */
export const COOL_DOWN_MS = 15 * 60_000
/** Messages to one recipient in one hour, at most. */
export const RECIPIENT_HOURLY_LIMIT = 10
/** Messages from the instance in one minute, at most (below the providers' rates). */
export const INSTANCE_PER_MINUTE_LIMIT = 60
/** Minutes to wait after each failed send (the last one repeats); given up after MAX_ATTEMPTS. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60] as const
export const MAX_ATTEMPTS = 6
/** A fan-out that keeps failing is given up after this many attempts (same backoff). */
export const FAN_OUT_MAX_ATTEMPTS = 5
/** How long a suppression the provider reported at send time lasts. */
export const SUPPRESSION_MS = 30 * 24 * 3_600_000
/** How long a drain runs by default before leaving the rest to the next tick. */
export const DRAIN_BUDGET_MS = 20_000
/** Fan-outs with more recipients than this are logged (by count). */
const LARGE_FAN_OUT = 100
/** How far behind the clock the walk stays, so a minute is complete before it is read. */
const LAG_MS = 15_000
/** How long a lease holds a batch: far longer than any drain runs. */
const LEASE_MS = 5 * 60_000
/** Minutes walked in one drain, at most; a cursor further behind catches up over several. */
const MINUTES_PER_DRAIN = 120
/** Where the first drain ever starts: this many minutes back. */
const FIRST_DRAIN_MINUTES = 60
/** `flush`: also deliver what is due in the next this many minutes (dev and the e2e). */
const FLUSH_MINUTES = 60
/** The share of a drain's time fan-outs may use; batches have the rest. */
const FAN_OUT_SHARE = 0.5
/** Fan-out progress is saved this often (recipients). */
const PROGRESS_EVERY = 25

export interface DrainOptions {
  /** the time to drain as of (default: the clock) */
  now?: Date
  /** stop starting new work after this time, in epoch ms (default: DRAIN_BUDGET_MS from the start) */
  deadline?: number
  /** messages from the instance per minute, at most */
  perMinute?: number
  /**
   * Also fan out and deliver what is due in the next hour, without moving the cursor past now:
   * `POST /dev/notify/drain`, so local runs and the e2e need not wait. Never on a tick.
   */
  flush?: boolean
}

export interface DrainResult {
  /** the last minute fully drained */
  cursor: Minute | null
  /** minutes read */
  minutes: number
  /** pending notifications queued by fan-outs */
  queued: number
  sent: number
  /** batches moved to later: retries, the hourly limit, the daily quota */
  deferred: number
  /** pending notifications dropped by the send-time checks */
  dropped: number
  givenUp: number
  suppressed: number
  /** false when it stopped early (time, the instance limit, a batch held by another drain) */
  complete: boolean
}

interface Run {
  deps: Deps
  now: Date
  nowIso: string
  deadline: number
  /** fan-outs start no work after this (epoch ms) */
  fanOutDeadline: number
  perMinute: number
  /** the walk may queue only after this minute (the cursor never passes it) */
  end: Minute
  /** the first minute after `end`: nothing is queued or rescheduled before it */
  floor: Minute
  channels: Map<string, Channel>
  /** a daily quota was hit: the remaining batches wait for the next day */
  quotaHit: boolean
  stats: Partial<Record<NotifyCounter, number>>
  result: DrainResult
}

/** `done`: nothing left in it; `busy`: some of it waits (the walk goes on); `stop`: stop the walk. */
type Outcome = 'done' | 'busy' | 'stop'

/** Remembers which UTC day already warned that the quota was hit (per process). */
let quotaWarnedDay: string | undefined

const count = (run: Run, counter: NotifyCounter, n = 1) => {
  run.stats[counter] = (run.stats[counter] ?? 0) + n
}

const latest = (a: Minute, b: Minute) => (a > b ? a : b)

export async function drain(deps: Deps, opts: DrainOptions = {}): Promise<DrainResult> {
  const now = opts.now ?? deps.clock.now()
  const result: DrainResult = {
    cursor: null,
    minutes: 0,
    queued: 0,
    sent: 0,
    deferred: 0,
    dropped: 0,
    givenUp: 0,
    suppressed: 0,
    complete: true,
  }
  const channels = channelsOf(deps)
  if (channels.length === 0) return result
  const started = Date.now()
  const deadline = opts.deadline ?? started + DRAIN_BUDGET_MS
  const end = minuteOf(new Date(now.getTime() - LAG_MS - 60_000))
  const run: Run = {
    deps,
    now,
    nowIso: now.toISOString(),
    deadline,
    fanOutDeadline: started + Math.max(0, deadline - started) * FAN_OUT_SHARE,
    perMinute: opts.perMinute ?? INSTANCE_PER_MINUTE_LIMIT,
    end,
    floor: addMinutes(end, 1),
    channels: new Map(channels.map(c => [c.id, c])),
    quotaHit: false,
    stats: {},
    result,
  }
  let cursor = await deps.store.getNotifyCursor()
  result.cursor = cursor
  const last = opts.flush ? addMinutes(minuteOf(now), FLUSH_MINUTES) : run.end
  let minute = cursor ? addMinutes(cursor, 1) : addMinutes(run.end, -FIRST_DRAIN_MINUTES)
  const most = MINUTES_PER_DRAIN + (opts.flush ? FLUSH_MINUTES : 0)
  // A minute not done yet holds the cursor before it; later minutes are still drained.
  let held = false
  try {
    while (minute <= last && result.minutes < most) {
      if (Date.now() > run.deadline) {
        result.complete = false
        break
      }
      result.minutes++
      const outcome = await drainMinute(run, minute)
      if (outcome === 'stop') {
        result.complete = false
        break
      }
      if (outcome === 'busy') {
        result.complete = false
        held = true
      }
      if (!held && minute <= run.end) {
        if (!(await deps.store.setNotifyCursor(minute, cursor))) {
          // Another drain moved it: it carries on from there.
          result.complete = false
          break
        }
        cursor = minute
        result.cursor = cursor
      }
      minute = addMinutes(minute, 1)
    }
    if (minute <= last) result.complete = false
  } finally {
    await deps.store
      .addNotifyStats(hourOf(now), run.stats)
      .catch(err => logNotify('error', 'notify stats failed', { err: errorName(err) }))
  }
  return result
}

/** Everything due at `minute`: batches first, then fan-outs (which queue only after the walk). */
async function drainMinute(run: Run, minute: Minute): Promise<Outcome> {
  const { fanOuts, batches } = await run.deps.store.listDueNotifications(minute)
  let outcome: Outcome = 'done'
  for (const batch of batches) {
    if (Date.now() > run.deadline) return 'stop'
    const delivered = await deliverBatchSafely(run, batch)
    if (delivered === 'stop') return 'stop'
    if (delivered === 'busy') outcome = 'busy'
  }
  for (const fanOut of fanOuts) {
    if ((await fanOutEvent(run, minute, fanOut)) === 'busy') outcome = 'busy'
  }
  return outcome
}

/** Where a fan-out that cannot finish now goes: the first minute the walk has yet to reach. */
const nextFanOutMinute = (run: Run, minute: Minute) =>
  minute < run.floor ? run.floor : addMinutes(minute, 1)

/** The event key an event id starts with (ids are `<key>:<cause>`), for logs. */
const keyOfId = (eventId: string) => eventId.slice(0, eventId.indexOf(':'))

/**
 * Queue the event's notifications, carrying on after the last address queued. Out of time, it
 * moves to a later minute with its progress; on a failure, later with backoff, until it is given
 * up. `busy` only when the marker could not be moved (it stays, and holds the cursor).
 */
async function fanOutEvent(run: Run, minute: Minute, fanOut: FanOutRecord): Promise<Outcome> {
  const { store } = run.deps
  const park = async (changes: { after?: string; attempts?: number }, to?: Minute) => {
    try {
      await store.moveFanOut(minute, to ?? nextFanOutMinute(run, minute), fanOut.eventId, changes)
      return 'done' as const
    } catch (err) {
      logNotify('error', 'fan-out not moved', {
        event: keyOfId(fanOut.eventId),
        err: errorName(err),
      })
      return 'busy' as const
    }
  }
  if (Date.now() > run.fanOutDeadline) return park({})
  let after = fanOut.after
  try {
    const event = await store.getNotificationEvent(fanOut.eventId)
    if (!event) {
      await store.finishFanOut(minute, fanOut.eventId)
      return 'done'
    }
    const recipients = await recipientsOf(run.deps, event)
    if (recipients.length > LARGE_FAN_OUT && fanOut.after === undefined) {
      logNotify('info', 'large fan-out', { event: event.key, recipients: recipients.length })
    }
    const def = eventDefinition(event.key)
    const earliest = latest(
      addMinutes(minuteOf(new Date(event.createdAt)), FOLD_MINUTES),
      run.floor
    )
    let unsaved = 0
    for (const r of recipients) {
      if (after !== undefined && r.email <= after) continue
      if (Date.now() > run.fanOutDeadline) {
        return park(after !== undefined && after !== fanOut.after ? { after } : {})
      }
      for (const channel of run.channels.keys()) {
        const queued = await store.queueNotification(
          {
            email: r.email,
            channel: channel as PendingNotificationRecord['channel'],
            batchSiteId: def.coolDown ? event.siteId : null,
            eventId: event.id,
            key: event.key,
            siteId: event.siteId,
            actor: event.actor,
            data: r.data,
            createdAt: run.nowIso,
          },
          earliest,
          run.floor
        )
        if (queued.queued) run.result.queued++
      }
      after = r.email
      if (++unsaved === PROGRESS_EVERY) {
        unsaved = 0
        await store.saveFanOutProgress(minute, event.id, after)
      }
    }
    await store.finishFanOut(minute, event.id)
    return 'done'
  } catch (err) {
    const attempts = (fanOut.attempts ?? 0) + 1
    const event = keyOfId(fanOut.eventId)
    const progress = after !== undefined ? { after } : {}
    if (attempts >= FAN_OUT_MAX_ATTEMPTS) {
      count(run, 'givenUp')
      run.result.givenUp++
      logNotify('error', 'fan-out given up', { event, attempts, err: errorName(err) })
      try {
        await store.finishFanOut(minute, fanOut.eventId)
        return 'done'
      } catch {
        return park({ ...progress, attempts })
      }
    }
    logNotify('error', 'fan-out failed', { event, attempts, err: errorName(err) })
    const wait = backoff(attempts)
    const retryAt = minuteOf(new Date(run.now.getTime() + wait * 60_000))
    return park({ ...progress, attempts }, latest(retryAt, nextFanOutMinute(run, minute)))
  }
}

const backoff = (attempts: number) =>
  RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)] as number

async function deliverBatchSafely(run: Run, listed: NotificationBatchRecord): Promise<Outcome> {
  const { store, clock } = run.deps
  // The lease runs from when it is taken, however long the drain has run so far.
  const at = clock.now()
  let batch: NotificationBatchRecord | null
  try {
    batch = await store.leaseNotificationBatch(
      listed,
      at.toISOString(),
      new Date(at.getTime() + LEASE_MS).toISOString()
    )
  } catch (err) {
    logNotify('error', 'batch lease failed', { batch: listed.id, err: errorName(err) })
    return 'busy'
  }
  if (!batch) return 'busy'
  const loaded: Loaded = { ids: [] }
  try {
    return await deliverBatch(run, batch, loaded)
  } catch (err) {
    logNotify('error', 'delivery failed', { batch: batch.id, err: errorName(err) })
    // Nothing was sent (a send's own bookkeeping never throws): treated as a transient failure, so
    // a batch that keeps failing is given up in the end.
    try {
      await retryOrGiveUp(run, batch, [], loaded.ids, {
        reason: 'transient',
        detail: errorName(err),
      })
    } catch (again) {
      logNotify('error', 'batch not rescheduled', { batch: batch.id, err: errorName(again) })
      return 'busy'
    }
    return 'done'
  }
}

/** The pending notifications a delivery loaded, so a give-up deletes those and no others. */
interface Loaded {
  ids: string[]
}

const later = (batch: NotificationBatchRecord, to: Minute) =>
  to > batch.due ? to : addMinutes(batch.due, 1)

async function reschedule(run: Run, batch: NotificationBatchRecord, to: Minute, attempts: number) {
  const outcome = await run.deps.store.rescheduleNotificationBatch(
    batch,
    latest(later(batch, to), run.floor),
    attempts,
    run.floor
  )
  if (outcome === 'lost') logNotify('warn', 'batch lease lost', { batch: batch.id })
  run.result.deferred++
}

/** Done with the batch: delete it and these pending notifications (sent or dropped). */
async function finish(
  run: Run,
  batch: NotificationBatchRecord,
  eventIds: string[],
  sent?: { record: BatchSent; coolDownFrom: Date }
) {
  const { store } = run.deps
  let coolDownUntil: string | null = null
  if (sent?.record.coolDown) {
    coolDownUntil = new Date(sent.coolDownFrom.getTime() + COOL_DOWN_MS).toISOString()
  } else {
    const pointer = await store.getBatchPointer(batch.email, batch.channel, batch.siteId)
    if (pointer?.coolDownUntil && pointer.coolDownUntil > run.nowIso) {
      coolDownUntil = pointer.coolDownUntil
    }
  }
  const s = sent?.record
  const ok = await store.finishNotificationBatch(batch, {
    eventIds,
    coolDownUntil,
    ...(s
      ? {
          sent: {
            id: s.id,
            email: batch.email,
            channel: batch.channel,
            batchId: batch.id,
            siteId: batch.siteId,
            eventIds: s.eventIds,
            eventKeys: s.eventKeys,
            subject: s.subject,
            ...(s.providerId ? { providerId: s.providerId } : {}),
            sentAt: s.sentAt,
          },
        }
      : {}),
  })
  if (!ok) logNotify('warn', 'batch lease lost', { batch: batch.id })
}

/**
 * Finish a batch whose message is out. It never throws: a failure leaves the batch marked sent
 * and leased (`busy`), and the drain that next leases it finishes it without sending.
 */
async function finishSent(run: Run, batch: NotificationBatchRecord, sent: BatchSent) {
  try {
    await finish(run, batch, sent.pendingIds, {
      record: sent,
      coolDownFrom: new Date(sent.sentAt),
    })
    return 'done' as const
  } catch (err) {
    logNotify('error', 'finishing a sent batch failed: a later drain finishes it', {
      batch: batch.id,
      err: errorName(err),
    })
    return 'busy' as const
  }
}

const uniqueKeys = (items: { key: EventKey }[]) => [...new Set(items.map(i => i.key))]

async function deliverBatch(
  run: Run,
  batch: NotificationBatchRecord,
  loaded: Loaded
): Promise<Outcome> {
  const { deps } = run
  const { store, config } = deps
  // Sent by an earlier drain that could not finish it: finish it, and send nothing.
  if (batch.sent) return finishSent(run, batch, batch.sent)
  const to = addressHash(batch.email)
  const pending = await store.listPendingNotifications(batch.email, batch.channel, batch.siteId)
  const allIds = pending.map(p => p.eventId)
  loaded.ids = allIds
  const channel = run.channels.get(batch.channel)

  if (pending.length === 0) {
    await finish(run, batch, [])
    return 'done'
  }
  if (!channel) {
    logNotify('warn', 'channel off: batch dropped', { batch: batch.id, channel: batch.channel })
    count(run, 'dropped', pending.length)
    run.result.dropped += pending.length
    await finish(run, batch, allIds)
    return 'done'
  }
  if (run.quotaHit) {
    await reschedule(run, batch, nextUtcDay(run.now), batch.attempts)
    return 'done'
  }
  if (await store.getSuppression(batch.email)) {
    count(run, 'suppressed')
    run.result.suppressed++
    await finish(run, batch, allIds)
    return 'done'
  }
  const policy = { allowedDomains: config.allowedEmailDomains, allowedEmails: config.allowedEmails }
  const [prefs, memberships] = await Promise.all([
    store.getNotificationPreferences(batch.email),
    store.listMemberships(batch.email),
  ])
  const items: { item: AnyDeliveryItem; at: string }[] = []
  if (emailAllowed(batch.email, policy)) {
    const resolver = new Resolver(deps, batch.email, memberships, prefs, batch.channel)
    for (const p of pending) {
      const item = await resolver.resolve(p)
      if (item) items.push({ item, at: p.createdAt })
    }
  }
  const dropped = pending.length - items.length
  if (dropped > 0) {
    count(run, 'dropped', dropped)
    run.result.dropped += dropped
  }
  if (items.length === 0) {
    await finish(run, batch, allIds)
    return 'done'
  }

  const hour = hourOf(run.now)
  if ((await store.recipientSends(batch.email, hour)) >= RECIPIENT_HOURLY_LIMIT) {
    logNotify('info', 'recipient limit: batch moved to the next hour', { batch: batch.id, to })
    await reschedule(run, batch, nextHour(run.now), batch.attempts)
    return 'done'
  }
  if ((await store.countInstanceSend(minuteOf(run.now))) > run.perMinute) {
    logNotify('info', 'instance limit: drain stopped', { batch: batch.id })
    await reschedule(run, batch, addMinutes(minuteOf(run.now), 1), batch.attempts)
    return 'stop'
  }

  const delivered = items.map(i => i.item)
  const keys = uniqueKeys(delivered)
  const result: DeliveryResult = await channel.deliver(
    {
      id: batch.id,
      to: batch.email,
      channel: batch.channel,
      site: batchSite(delivered),
      items: delivered,
    },
    deps
  )
  if (result.ok) return afterSend(run, batch, allIds, delivered, result)
  const failure = { at: run.nowIso, batchId: batch.id, eventKeys: keys }
  if (result.quota) {
    run.quotaHit = true
    const day = run.nowIso.slice(0, 10)
    if (quotaWarnedDay !== day) {
      quotaWarnedDay = day
      logNotify('warn', 'daily sending quota reached: batches wait for the next UTC day', {
        batch: batch.id,
        detail: result.detail,
      })
    }
    count(run, 'retrying')
    await store.addNotifyFailure({ ...failure, reason: 'quota', ...detail(result.detail) })
    await reschedule(run, batch, nextUtcDay(run.now), batch.attempts)
    return 'done'
  }
  if (result.retry) {
    await retryOrGiveUp(run, batch, keys, allIds, { reason: result.reason, detail: result.detail })
    return 'done'
  }
  // Refused for good: the address is suppressed, or the setup is wrong.
  if (result.reason === 'suppressed') {
    count(run, 'suppressed')
    run.result.suppressed++
    await store.putSuppression({
      email: batch.email,
      kind: 'bounce',
      at: run.nowIso,
      expiresAt: new Date(run.now.getTime() + SUPPRESSION_MS).toISOString(),
    })
    logNotify('warn', 'recipient suppressed by the provider', { batch: batch.id, events: keys, to })
  } else {
    count(run, 'givenUp')
    run.result.givenUp++
    logNotify('error', 'message rejected: check the mail setup', {
      batch: batch.id,
      events: keys,
      reason: result.reason,
      detail: result.detail,
    })
  }
  await store.addNotifyFailure({ ...failure, reason: result.reason, ...detail(result.detail) })
  await finish(run, batch, allIds)
  return 'done'
}

/**
 * The provider accepted the message. From here nothing may send it again, so nothing throws: the
 * batch is marked sent first, then the recipient's hourly count and the finish are each logged on
 * failure, and a batch left marked sent is finished by a later lease.
 */
async function afterSend(
  run: Run,
  batch: NotificationBatchRecord,
  pendingIds: string[],
  delivered: AnyDeliveryItem[],
  result: Extract<DeliveryResult, { ok: true }>
): Promise<Outcome> {
  const { store, clock } = run.deps
  const keys = uniqueKeys(delivered)
  count(run, 'sent')
  run.result.sent++
  logNotify('info', 'notification sent', {
    batch: batch.id,
    events: keys,
    to: addressHash(batch.email),
  })
  const sent: BatchSent = {
    id: newSortableId(run.now),
    pendingIds,
    eventIds: delivered.map(i => i.eventId),
    eventKeys: keys,
    subject: result.subject,
    ...(result.providerId ? { providerId: result.providerId } : {}),
    sentAt: clock.now().toISOString(),
    coolDown: keys.some(k => eventDefinition(k).coolDown),
  }
  try {
    if (!(await store.markNotificationBatchSent(batch, sent))) {
      logNotify('warn', 'batch lease lost', { batch: batch.id })
    }
  } catch (err) {
    logNotify('error', 'marking a sent batch failed', { batch: batch.id, err: errorName(err) })
  }
  try {
    await store.countRecipientSend(batch.email, hourOf(run.now))
  } catch (err) {
    logNotify('error', 'counting a send failed', { batch: batch.id, err: errorName(err) })
  }
  return finishSent(run, { ...batch, sent }, sent)
}

const detail = (value: string | undefined) => (value ? { detail: value } : {})

/**
 * A failed send worth trying again: later with backoff, or given up after MAX_ATTEMPTS. A give-up
 * deletes the pending notifications this delivery loaded (`ids`), never ones queued since.
 */
async function retryOrGiveUp(
  run: Run,
  batch: NotificationBatchRecord,
  keys: EventKey[],
  ids: string[],
  failure: { reason: string; detail?: string | undefined }
) {
  const { store } = run.deps
  const attempts = batch.attempts + 1
  await store.addNotifyFailure({
    at: run.nowIso,
    batchId: batch.id,
    eventKeys: keys,
    reason: failure.reason,
    ...detail(failure.detail),
  })
  if (attempts >= MAX_ATTEMPTS) {
    count(run, 'givenUp')
    run.result.givenUp++
    logNotify('error', 'notification given up', {
      batch: batch.id,
      events: keys,
      attempts,
      reason: failure.reason,
    })
    await finish(run, batch, ids)
    return
  }
  count(run, 'retrying')
  const wait = backoff(attempts)
  await reschedule(run, batch, minuteOf(new Date(run.now.getTime() + wait * 60_000)), attempts)
}

/** The site a batch is about: the one its items name, if they are all about one. */
function batchSite(items: AnyDeliveryItem[]) {
  const first = items[0]
  if (!first || !('site' in first.details)) return null
  const site = first.details.site
  return items.every(i => 'site' in i.details && i.details.site.name === site.name) ? site : null
}

function nextHour(now: Date): Minute {
  return minuteOf(new Date(`${hourOf(new Date(now.getTime() + 3_600_000))}:00:00.000Z`))
}

function nextUtcDay(now: Date): Minute {
  const day = new Date(minuteStart(minuteOf(now)))
  day.setUTCHours(24, 0, 0, 0)
  return minuteOf(day)
}
