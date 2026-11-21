/**
 * AcsMailer against a stubbed EmailClient: what ACS was asked to send, and each failure ACS can
 * answer (a RestError status and code, or an operation that ends Failed).
 */
import type { EmailMessage, EmailSendResponse } from '@azure/communication-email'
import {
  type DeliveredMail,
  mailerConformance,
  mailMessage as message,
  type ProviderFailure,
} from '@fling/conformance'
import { describe, expect, it } from 'vitest'
import { type AcsClient, AcsMailer } from '../src/mail/acs.ts'

const restError = (statusCode: number, code: string) =>
  Object.assign(new Error('refused for someone@example.test'), {
    name: 'RestError',
    statusCode,
    code,
  })

/** A stub EmailClient: keeps what it was asked to send, or answers with `fail`. */
function stub(
  fail?: { throws: unknown } | { ends: Partial<EmailSendResponse> } | { pending: true }
) {
  const sent: { message: EmailMessage; operationId?: string }[] = []
  const client: AcsClient = {
    async beginSend(message, options) {
      if (fail && 'throws' in fail) throw fail.throws
      sent.push({ message, ...(options?.operationId ? { operationId: options.operationId } : {}) })
      return {
        pollUntilDone: () =>
          fail && 'pending' in fail
            ? new Promise((_, reject) =>
                options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
              )
            : Promise.resolve({
                id: options?.operationId ?? 'op',
                status: 'Succeeded',
                ...(fail && 'ends' in fail ? fail.ends : {}),
              } as EmailSendResponse),
      }
    },
  }
  return { client, sent }
}

const FAILURES: Record<Exclude<ProviderFailure, 'quota'>, Parameters<typeof stub>[0]> = {
  throttle: { throws: restError(429, 'TooManyRequests') },
  rejected: { throws: restError(400, 'InvalidSenderUserName') },
  suppressed: {
    ends: { status: 'Failed', error: { code: 'EmailDroppedAllRecipientsSuppressed' } },
  },
  transient: { throws: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
}

mailerConformance(
  'AcsMailer',
  () => {
    const { client, sent } = stub()
    return {
      mailer: new AcsMailer(client),
      delivered: async (): Promise<DeliveredMail[]> =>
        sent.map(({ message: m }) => ({
          to: m.recipients.to?.[0]?.address ?? '',
          subject: m.content.subject,
          // ACS shows the sender username's display name; nothing per message.
          from: { address: m.senderAddress, name: '' },
          headers: m.headers ?? {},
        })),
    }
  },
  {
    failing: failure => new AcsMailer(stub(FAILURES[failure as keyof typeof FAILURES]).client),
    failures: ['throttle', 'rejected', 'suppressed', 'transient'],
    providerSetsFromName: true,
  }
)

describe('AcsMailer', () => {
  it('tags the batch, keeps the reply-to, turns tracking off and names the operation', async () => {
    const { client, sent } = stub()
    const result = await new AcsMailer(client).send(message())
    const [first] = sent
    expect(first?.message.headers).toMatchObject({ 'X-Fling-Batch': 'batch123' })
    expect(first?.message.replyTo).toEqual([{ address: 'help@example.test' }])
    expect(first?.message.disableUserEngagementTracking).toBe(true)
    expect(result).toEqual({ ok: true, providerId: first?.operationId })
  })

  it('counts a send ACS accepted and is still running when the wait runs out', async () => {
    const { client } = stub({ pending: true })
    const result = await new AcsMailer(client, { waitMs: 20 }).send(message())
    expect(result).toMatchObject({ ok: true, providerId: expect.any(String) })
  })

  it('maps a missing permission and an unknown domain to rejected, never logging the message', async () => {
    for (const err of [restError(403, 'Forbidden'), restError(404, 'DomainNotLinked')]) {
      const result = await new AcsMailer(stub({ throws: err }).client).send(message())
      expect(result).toMatchObject({ ok: false, retry: false, reason: 'rejected' })
      expect(JSON.stringify(result)).not.toContain('someone@example.test')
    }
  })
})
