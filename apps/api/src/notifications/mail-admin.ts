/**
 * The admins' mail page (`/api/admin/mail`, design §10.2): the mail settings, read only; the last
 * 24 hours of sending from the drainer's hourly counters and its latest failures (batch ids, event
 * keys and provider codes, never an address or content); and a test email to any address the
 * admin types, inside the email policy or not, so outside deliverability checkers work.
 *
 * The test goes straight to the Mailer, not through the outbox, and is the only message Fling
 * sends on request: nothing sends one automatically. At most MAIL_TESTS_PER_HOUR per admin
 * (`USER#<admin>/NTEST#<hour>`). Policy decides who (`admin.mail.read`, `admin.mail.test`); the
 * caller passes the decision in as `ensure`.
 */
import {
  MAIL_COUNTERS,
  MAIL_TESTS_PER_HOUR,
  type MailAdmin,
  type MailCounter,
  type MailTestResult,
} from '@fling/shared'
import { instanceMetadata } from '../instance.ts'
import { ApiError, badRequest, notFound } from '../lib/errors.ts'
import { newSortableId } from '../lib/ids.ts'
import { isMailAddress, type MailResult } from '../mail/types.ts'
import { hourOf } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { addressHash, logNotify } from './log.ts'
import { renderEmail } from './templates/layout.ts'

/** Failures the page lists. */
const FAILURES_SHOWN = 20
const HOUR_MS = 3_600_000

function mailOf(deps: Deps) {
  if (!deps.config.mail || !deps.mailer) throw notFound('Email is not set up on this instance')
  return { mail: deps.config.mail, mailer: deps.mailer }
}

export async function mailOverview(deps: Deps, admin: string): Promise<MailAdmin> {
  const { mail } = mailOf(deps)
  const now = deps.clock.now()
  const since = hourOf(new Date(now.getTime() - 23 * HOUR_MS))
  const [stats, failures, tests] = await Promise.all([
    deps.store.listNotifyStats(since),
    deps.store.listNotifyFailures(FAILURES_SHOWN),
    deps.store.mailTests(admin, hourOf(now)),
  ])
  const zero = () =>
    Object.fromEntries(MAIL_COUNTERS.map(k => [k, 0])) as Record<MailCounter, number>
  const totals = zero()
  const hours = stats.map(s => {
    const row = { hour: s.hour, ...zero() }
    for (const k of MAIL_COUNTERS) {
      row[k] = s[k] ?? 0
      totals[k] += row[k]
    }
    return row
  })
  return {
    config: {
      driver: mail.driver,
      from: mail.from,
      fromName: mail.fromName,
      replyTo: mail.replyTo ?? null,
      configurationSet: mail.sesConfigurationSet ?? null,
      invites: deps.config.invites,
    },
    health: {
      since,
      hours,
      totals,
      failures: failures.map(f => ({
        at: f.at,
        batchId: f.batchId,
        eventKeys: f.eventKeys,
        reason: f.reason,
        detail: f.detail ?? null,
      })),
    },
    tests: { remaining: Math.max(0, MAIL_TESTS_PER_HOUR - tests), limit: MAIL_TESTS_PER_HOUR },
  }
}

/** A provider code in words: `E_SENDER_NOT_VERIFIED` → `sender not verified`, `MessageRejected` → `message rejected`. */
export function codeInWords(code: string): string {
  return code
    .replace(/^E_/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()
}

/** How a failed send reads on the admin page: `rejected: sender not verified`. */
export function describeMailFailure(result: Extract<MailResult, { ok: false }>): string {
  const reason = result.quota ? `${result.reason} (daily quota)` : result.reason
  return result.detail ? `${reason}: ${codeInWords(result.detail)}` : reason
}

/** Send the branded test email to `to` as `admin`; counts against the admin's hourly limit. */
export async function sendTestMail(deps: Deps, admin: string, to: string): Promise<MailTestResult> {
  const { mail, mailer } = mailOf(deps)
  if (!isMailAddress(to)) throw badRequest('That is not an email address', 'invalid_email')
  const now = deps.clock.now()
  const used = await deps.store.countMailTest(admin, hourOf(now))
  if (used > MAIL_TESTS_PER_HOUR) {
    throw new ApiError(
      429,
      'too_many_tests',
      `You can send ${MAIL_TESTS_PER_HOUR} test emails an hour. Try again later`
    )
  }
  const metadata = instanceMetadata(deps.config)
  const rendered = renderEmail(
    metadata,
    [
      {
        subject: 'Test email',
        lead: `This is a test email from ${metadata.name}, sent by ${admin} from the admin page.`,
        lines: [
          `If you can read it, ${metadata.name} can send email. Check its headers for SPF, DKIM and DMARC alignment.`,
        ],
        action: { label: `Open ${metadata.name}`, url: metadata.appOrigin },
        why: `an admin of ${metadata.name} sent a test to this address`,
      },
    ],
    'Test email',
    { to, unsubscribe: [], commentNote: false }
  )
  const batchId = `test-${newSortableId(now)}`
  const result = await mailer.send({
    to,
    from: { address: mail.from, name: mail.fromName },
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: {},
    batchId,
    tags: ['mail.test'],
  })
  logNotify(result.ok ? 'info' : 'warn', 'test email', {
    batchId,
    to: addressHash(to),
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason, detail: result.detail }),
  })
  if (result.ok)
    return { ok: true, providerId: result.providerId ?? null, subject: rendered.subject }
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail ?? null,
    error: describeMailFailure(result),
  }
}
