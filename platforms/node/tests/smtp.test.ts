/**
 * SmtpMailer: the Mailer conformance suite against a fake SMTP server in process (smtp-server),
 * which parses what it is sent (mailparser), so the header checks see the adapter's real output on
 * the wire, and answers a send with the replies real providers give for each failure.
 */
import type { AddressInfo } from 'node:net'
import { loadBaseConfig } from '@fling/api/config'
import {
  type DeliveredMail,
  mailerConformance,
  mailMessage,
  type ProviderFailure,
} from '@fling/conformance'
import { simpleParser } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SmtpMailer, smtpFailure, smtpMailerFor } from '../src/mail/smtp.ts'

/** What providers answer for each failure, as (code, reply). */
const REPLIES: Record<ProviderFailure, [number, string]> = {
  throttle: [421, '4.7.0 Too many messages, rate limit exceeded'],
  quota: [454, '4.7.0 Daily sending quota exceeded'],
  rejected: [550, '5.7.1 Sender address is not verified'],
  suppressed: [550, '5.1.1 Recipient address is on the suppression list'],
  transient: [451, '4.3.0 Temporary local problem, try again'],
}

const USER = 'fling'
const PASSWORD = 'smtp-test-password'

let server: SMTPServer
let port: number
let received: DeliveredMail[] = []
/** the reply the server gives the next recipient, once */
let nextFailure: ProviderFailure | undefined

const unfold = (line: string) => line.replace(/\r?\n[ \t]+/g, ' ')

beforeAll(async () => {
  server = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authOptional: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === USER && auth.password === PASSWORD) cb(null, { user: USER })
      else cb(Object.assign(new Error('5.7.8 Authentication failed'), { responseCode: 535 }))
    },
    onRcptTo(_address, _session, cb) {
      const failure = nextFailure
      nextFailure = undefined
      if (!failure) return cb()
      const [code, reply] = REPLIES[failure]
      cb(Object.assign(new Error(reply), { responseCode: code }))
    },
    onData(stream, _session, cb) {
      simpleParser(stream)
        .then(mail => {
          const to = Array.isArray(mail.to) ? mail.to[0] : mail.to
          const from = mail.from?.value[0]
          received.push({
            to: to?.value[0]?.address ?? '',
            subject: mail.subject ?? '',
            from: { address: from?.address ?? '', name: from?.name ?? '' },
            headers: Object.fromEntries(
              mail.headerLines.map(h => [
                h.key,
                unfold(h.line)
                  .slice(h.key.length + 1)
                  .trim(),
              ])
            ),
          })
          cb()
        })
        .catch(cb)
    },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.server.address() as AddressInfo).port
})
const opened: SmtpMailer[] = []
afterAll(async () => {
  for (const m of opened) m.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const mailer = (overrides: Partial<ConstructorParameters<typeof SmtpMailer>[0]> = {}) => {
  const m = new SmtpMailer({
    host: '127.0.0.1',
    port,
    security: 'none',
    user: USER,
    password: PASSWORD,
    timeoutMs: 5_000,
    ...overrides,
  })
  opened.push(m)
  return m
}

mailerConformance(
  'SmtpMailer (a fake SMTP server)',
  () => {
    received = []
    return { mailer: mailer(), delivered: async () => received }
  },
  {
    failing: failure => {
      nextFailure = failure
      return mailer()
    },
  }
)

describe('SmtpMailer', () => {
  it('tags the message with its batch, and names no address in a failure', async () => {
    received = []
    expect(await mailer().send(mailMessage({ batchId: 'b-42' }))).toMatchObject({ ok: true })
    expect(received[0]?.headers['x-fling-batch']).toBe('b-42')
    nextFailure = 'suppressed'
    const result = await mailer().send(mailMessage())
    expect(result).toMatchObject({ ok: false, detail: 'SMTP 550 5.1.1' })
  })

  it('refuses a send when authentication fails, as a setup to fix', async () => {
    expect(await mailer({ password: 'wrong' }).send(mailMessage())).toMatchObject({
      ok: false,
      retry: false,
      reason: 'rejected',
    })
  })

  it('is transient when the server cannot be reached', async () => {
    const closed = new SMTPServer({ logger: false })
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const gone = (closed.server.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    expect(await mailer({ port: gone }).send(mailMessage())).toMatchObject({
      ok: false,
      retry: true,
      reason: 'transient',
    })
  })

  it('maps replies by code and wording', () => {
    const reply = (responseCode: number, response: string) =>
      smtpFailure(Object.assign(new Error(response), { responseCode, response }))
    expect(reply(450, '450 4.2.1 Slow down')).toMatchObject({ reason: 'throttled' })
    expect(reply(552, '552 5.2.2 Mailbox full')).toMatchObject({ reason: 'rejected' })
    expect(reply(550, '550 5.7.1 Inactive recipient')).toMatchObject({ reason: 'suppressed' })
    expect(reply(554, '554 Sending limit reached')).toMatchObject({
      reason: 'throttled',
      quota: true,
      retry: true,
    })
    expect(smtpFailure(new Error('boom'))).toMatchObject({ reason: 'transient', retry: true })
  })

  it("is the smtp driver's mailer, and no other's", () => {
    const config = (env: Record<string, string>) => ({
      ...loadBaseConfig({ MAIL_FROM: 'f@example.test', ...env }),
      secrets: { sessionSecret: 's'.repeat(32), siteHmacKey: 'h'.repeat(32), smtpPassword: 'p' },
    })
    const m = smtpMailerFor(config({ MAIL_DRIVER: 'smtp', SMTP_HOST: 'localhost' }))
    expect(m).toBeInstanceOf(SmtpMailer)
    m?.close()
    expect(smtpMailerFor(config({ MAIL_DRIVER: 'memory' }))).toBeUndefined()
  })
})
