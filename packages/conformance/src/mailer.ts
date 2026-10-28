/**
 * Mailer conformance: what the email channel relies on from every Mailer (`@fling/api/mail`).
 * A well-formed message is accepted with a provider id; nothing the caller puts in a subject,
 * display name or header value breaks a line in the message's headers; a malformed address is
 * refused without reaching the provider; and each kind of provider failure maps onto the same
 * `MailResult`, never a throw.
 *
 * Adapters run it from their own test files. The harness says what the provider received
 * (`delivered`), so the header checks see the adapter's real output: the messages kept in memory,
 * the `.eml` files written, the calls a stubbed SDK client or binding saw. Real providers' errors
 * can't be produced on demand, so the failure cases take `failing`: a mailer whose provider (a
 * stub, for a cloud adapter) answers the next send with the given failure.
 */
import type { Mailer, MailMessage, MailResult } from '@fling/api/mail'
import { describe, expect, it } from 'vitest'

/** One message as its provider received it. */
export interface DeliveredMail {
  to: string
  subject: string
  from: { address: string; name: string }
  /** every header the adapter set, by name (whatever case the adapter uses) */
  headers: Record<string, string>
}

export interface MailerHarness {
  mailer: Mailer
  /** what the provider received, in any order */
  delivered(): Promise<DeliveredMail[]>
}

/**
 * The provider failures an adapter maps: its rate limit (`throttle`), its daily quota (`quota`), a
 * refusal (`rejected`: a bad recipient, an unverified sender), a suppressed recipient
 * (`suppressed`) and anything unexpected, such as a network error (`transient`).
 */
export const PROVIDER_FAILURES = [
  'throttle',
  'quota',
  'rejected',
  'suppressed',
  'transient',
] as const
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number]

/** What each provider failure must come back as. */
export const EXPECTED_FAILURE: Record<
  ProviderFailure,
  Partial<Extract<MailResult, { ok: false }>>
> = {
  throttle: { ok: false, retry: true, reason: 'throttled' },
  quota: { ok: false, retry: true, reason: 'throttled', quota: true },
  rejected: { ok: false, retry: false, reason: 'rejected' },
  suppressed: { ok: false, retry: false, reason: 'suppressed' },
  transient: { ok: false, retry: true, reason: 'transient' },
}

export interface MailerConformanceOptions {
  /** A mailer whose provider answers the next send with `failure`. */
  failing?: (failure: ProviderFailure) => Mailer | Promise<Mailer>
  /**
   * The failures the provider can report, when not all of them: SES, for one, accepts a send to a
   * suppressed address and drops it, so it never reports `suppressed`.
   */
  failures?: readonly ProviderFailure[]
}

const LINE_BREAK = /[\r\n]/

export function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'reader@example.test',
    from: { address: 'fling@mail.example.test', name: 'Acme Fling' },
    replyTo: 'help@example.test',
    subject: 'Ana shared q3-report with you',
    text: 'Ana shared q3-report with you.\n\nhttps://app.example.test/review/q3-report',
    html: '<p>Ana shared <b>q3-report</b> with you.</p>',
    headers: {
      'List-Unsubscribe': '<https://app.example.test/notifications/unsubscribe?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    batchId: 'batch123',
    tags: ['site.shared'],
    ...overrides,
  }
}

const header = (mail: DeliveredMail, name: string) =>
  Object.entries(mail.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]

export function mailerConformance(
  name: string,
  factory: () => MailerHarness | Promise<MailerHarness>,
  opts: MailerConformanceOptions = {}
) {
  describe(`Mailer conformance: ${name}`, () => {
    it('accepts a well-formed message and returns a provider id', async () => {
      const { mailer, delivered } = await factory()
      const result = await mailer.send(message())
      expect(result).toMatchObject({ ok: true })
      expect(result.ok && result.providerId).toEqual(expect.any(String))
      const [mail, ...rest] = await delivered()
      expect(rest).toEqual([])
      expect(mail).toMatchObject({
        to: 'reader@example.test',
        subject: 'Ana shared q3-report with you',
        from: { address: 'fling@mail.example.test', name: 'Acme Fling' },
      })
      expect(header(mail as DeliveredMail, 'List-Unsubscribe-Post')).toBe(
        'List-Unsubscribe=One-Click'
      )
    })

    it('gives each message its own provider id', async () => {
      const { mailer } = await factory()
      const a = await mailer.send(message())
      const b = await mailer.send(message({ to: 'other@example.test' }))
      expect(a.ok && b.ok).toBe(true)
      if (a.ok && b.ok) expect(a.providerId).not.toBe(b.providerId)
    })

    it('keeps non-ASCII text intact', async () => {
      const { mailer, delivered } = await factory()
      const subject = 'Zoë commented on café-menü ✨'
      await mailer.send(
        message({ subject, from: { address: 'fling@mail.example.test', name: 'Café Fling' } })
      )
      const [mail] = await delivered()
      expect(mail?.subject).toBe(subject)
      expect(mail?.from.name).toBe('Café Fling')
    })

    it('never lets CR or LF from a subject, name or header value into the headers', async () => {
      const { mailer, delivered } = await factory()
      const result = await mailer.send(
        message({
          subject: 'Hello\r\nBcc: victim@example.test',
          from: { address: 'fling@mail.example.test', name: 'Acme\nBcc: victim@example.test' },
          headers: {
            'List-Unsubscribe': '<https://app.example.test/u>\r\nBcc: victim@example.test',
          },
        })
      )
      expect(result.ok).toBe(true)
      const [mail] = await delivered()
      if (!mail) throw new Error('nothing delivered')
      expect(mail.subject).not.toMatch(LINE_BREAK)
      expect(mail.subject).toContain('Hello')
      expect(mail.from.name).not.toMatch(LINE_BREAK)
      for (const [k, v] of Object.entries(mail.headers)) {
        expect(k.toLowerCase()).not.toBe('bcc')
        expect(v).not.toMatch(LINE_BREAK)
      }
    })

    it('refuses a malformed recipient without retrying, sending nothing', async () => {
      const { mailer, delivered } = await factory()
      for (const to of ['not-an-address', 'a@b.test\r\nBcc: victim@example.test', '']) {
        expect(await mailer.send(message({ to }))).toMatchObject(EXPECTED_FAILURE.rejected)
      }
      expect(await delivered()).toEqual([])
    })

    describe.runIf(opts.failing)('provider failures', () => {
      for (const failure of opts.failures ?? PROVIDER_FAILURES) {
        it(`maps ${failure} onto its result`, async () => {
          const mailer = await (opts.failing as NonNullable<typeof opts.failing>)(failure)
          const result = await mailer.send(message())
          expect(result).toMatchObject(EXPECTED_FAILURE[failure])
          if (failure !== 'quota') expect(result).not.toMatchObject({ quota: true })
        })
      }
    })
  })
}
