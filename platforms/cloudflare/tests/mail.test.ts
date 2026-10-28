/**
 * CloudflareMailer: the Mailer conformance suite over Miniflare's simulated `send_email` binding
 * (the one `wrangler dev` uses), and the error mapping over a stubbed binding, since the simulator
 * produces none of Email Service's error codes.
 *
 * The simulator accepts any recipient, HTML and custom headers, enforces
 * `allowed_sender_addresses` and returns a message id, but records only From, To, Subject and the
 * bodies; what the binding received is recorded on the way in, so the header checks see the
 * adapter's real output.
 */
import type { SendEmail } from '@cloudflare/workers-types'
import { BATCH_ID_HEADER } from '@fling/api/mail'
import {
  type DeliveredMail,
  mailerConformance,
  mailMessage as message,
  type ProviderFailure,
} from '@fling/conformance'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CloudflareMailer, type EmailBinding, emailFailure } from '../src/mail/email.ts'
import { COMPATIBILITY } from './miniflare.ts'

type Sent = Parameters<SendEmail['send']>[0] & {
  to: string
  from: { email: string; name: string }
  subject: string
  headers: Record<string, string>
}

const FROM = 'fling@mail.example.test'

let mf: Miniflare
let simulated: EmailBinding
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null, { status: 404 }) } }',
    ...COMPATIBILITY,
    email: { send_email: [{ name: 'EMAIL', allowed_sender_addresses: [FROM] }] },
  })
  simulated = (await mf.getBindings<{ EMAIL: EmailBinding }>()).EMAIL
}, 60_000)
afterAll(() => mf?.dispose())

/** The simulated binding, recording each message it is given. */
function recording(binding: () => EmailBinding) {
  const sent: Sent[] = []
  const recorder: EmailBinding = {
    send: (async (msg: Sent) => {
      sent.push(msg)
      return binding().send(msg as never)
    }) as EmailBinding['send'],
  }
  return { recorder, sent }
}

/** What Email Service throws: an Error with a `code`. */
const CODES: Record<ProviderFailure, string> = {
  throttle: 'E_RATE_LIMIT_EXCEEDED',
  quota: 'E_DAILY_LIMIT_EXCEEDED',
  rejected: 'E_SENDER_NOT_VERIFIED',
  suppressed: 'E_RECIPIENT_SUPPRESSED',
  transient: 'E_INTERNAL_SERVER_ERROR',
}

const failingBinding = (code: string): EmailBinding => ({
  send: async () => {
    throw Object.assign(new Error(`email service: ${code}`), { code })
  },
})

mailerConformance(
  "CloudflareMailer (Miniflare's simulated send_email)",
  () => {
    const { recorder, sent } = recording(() => simulated)
    return {
      mailer: new CloudflareMailer(recorder),
      delivered: async (): Promise<DeliveredMail[]> =>
        sent.map(m => ({
          to: m.to,
          subject: m.subject,
          from: { address: m.from.email, name: m.from.name },
          headers: m.headers,
        })),
    }
  },
  {
    failing: failure => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mailer = new CloudflareMailer(failingBinding(CODES[failure]))
      return {
        send: async msg => {
          try {
            return await mailer.send(msg)
          } finally {
            error.mockRestore()
          }
        },
      }
    },
  }
)

describe('CloudflareMailer', () => {
  it('sends the batch id as a header, and the reply-to', async () => {
    const { recorder, sent } = recording(() => simulated)
    const result = await new CloudflareMailer(recorder).send(message({ batchId: 'b1' }))
    expect(result).toMatchObject({
      ok: true,
      providerId: expect.stringMatching(/@mail\.example\.test>$/),
    })
    expect(sent[0]).toMatchObject({
      replyTo: 'help@example.test',
      text: expect.stringContaining('q3-report'),
      html: expect.stringContaining('<b>q3-report</b>'),
      headers: { [BATCH_ID_HEADER]: 'b1', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    })
  })

  it('maps every Email Service code it knows, and anything else to transient', () => {
    const coded = (code?: string) => Object.assign(new Error('x'), code ? { code } : {})
    expect(emailFailure(coded('E_RECIPIENT_NOT_ALLOWED'))).toMatchObject({
      reason: 'rejected',
      retry: false,
      detail: 'E_RECIPIENT_NOT_ALLOWED',
    })
    expect(emailFailure(coded('E_DAILY_LIMIT_EXCEEDED'))).toMatchObject({ quota: true })
    expect(emailFailure(coded('E_RATE_LIMIT_EXCEEDED'))).not.toHaveProperty('quota')
    expect(emailFailure(coded('E_DELIVERY_FAILED'))).toMatchObject({
      reason: 'transient',
      retry: true,
      detail: 'E_DELIVERY_FAILED',
    })
    expect(emailFailure(coded())).toMatchObject({ reason: 'transient', detail: 'Error' })
  })

  it('logs a refusal with its code, never its message or the address', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const binding: EmailBinding = {
      send: async () => {
        throw Object.assign(new Error('recipient reader@example.test is not allowed'), {
          code: 'E_RECIPIENT_NOT_ALLOWED',
        })
      },
    }
    try {
      await new CloudflareMailer(binding).send(message())
      const refused = String(error.mock.calls[0]?.[0])
      expect(refused).toContain('E_RECIPIENT_NOT_ALLOWED')
      expect(refused).not.toContain('reader@example.test')
      expect(refused).not.toContain('not allowed')
      error.mockClear()
      await new CloudflareMailer(failingBinding('E_SENDER_NOT_VERIFIED')).send(message())
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain('E_SENDER_NOT_VERIFIED')
      expect(line).not.toContain('reader@example.test')
    } finally {
      error.mockRestore()
    }
  })
})
