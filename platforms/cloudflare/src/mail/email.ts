/**
 * CloudflareMailer: the Mailer port on Cloudflare Email Service, through the `send_email` binding
 * (`EMAIL`, rendered from the deploy config's `MAIL` by scripts/config.mjs). One `send` per
 * recipient, with the List-Unsubscribe headers and the batch id (`X-Fling-Batch`) as custom
 * headers. Under `wrangler dev` the binding is simulated: messages are logged and saved to local
 * files, never sent.
 *
 * The binding returns `{ messageId }` or throws an Error with a `code`, mapped onto `MailResult`
 * (docs/design/notifications.md §5.2): the rate limit to `throttled`, the daily quota to
 * `throttled` with `quota`, a suppressed recipient to `suppressed`, and a recipient or sender the
 * binding refuses to `rejected` with an error log, because that means the sending setup is wrong.
 * Anything else is `transient`.
 */
import type { SendEmail } from '@cloudflare/workers-types'
import {
  BATCH_ID_HEADER,
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from '@fling/api/mail'

/** What CloudflareMailer needs of the binding, so tests can stub it. */
export type EmailBinding = Pick<SendEmail, 'send'>

const FAILURES: Record<string, Omit<Extract<MailResult, { ok: false }>, 'ok' | 'detail'>> = {
  E_RATE_LIMIT_EXCEEDED: { retry: true, reason: 'throttled' },
  E_DAILY_LIMIT_EXCEEDED: { retry: true, reason: 'throttled', quota: true },
  E_RECIPIENT_SUPPRESSED: { retry: false, reason: 'suppressed' },
  E_RECIPIENT_NOT_ALLOWED: { retry: false, reason: 'rejected' },
  E_SENDER_NOT_VERIFIED: { retry: false, reason: 'rejected' },
  E_SENDER_DOMAIN_NOT_AVAILABLE: { retry: false, reason: 'rejected' },
  E_VALIDATION_ERROR: { retry: false, reason: 'rejected' },
}

/** A binding error as a `MailResult`. */
export function emailFailure(err: unknown): Extract<MailResult, { ok: false }> {
  const code = (err as { code?: unknown } | null)?.code
  const known = typeof code === 'string' ? FAILURES[code] : undefined
  if (known) return { ok: false, ...known, detail: code as string }
  return {
    ok: false,
    retry: true,
    reason: 'transient',
    detail: typeof code === 'string' ? code : err instanceof Error ? err.name : 'Error',
  }
}

export class CloudflareMailer implements Mailer {
  constructor(private readonly binding: EmailBinding) {}

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    try {
      const { messageId } = await this.binding.send({
        to: prepared.to,
        from: { email: prepared.from.address, name: prepared.from.name },
        ...(prepared.replyTo ? { replyTo: prepared.replyTo } : {}),
        subject: prepared.subject,
        text: prepared.text,
        html: prepared.html,
        headers: { ...prepared.headers, [BATCH_ID_HEADER]: prepared.batchId },
      })
      return { ok: true, providerId: messageId }
    } catch (err) {
      const failure = emailFailure(err)
      if (failure.reason === 'rejected') {
        // Never the address or content: the batch id and the binding's error code.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'email service refused a send: check the sending domain and MAIL.FROM',
            error: failure.detail,
            batch: prepared.batchId,
          })
        )
      }
      return failure
    }
  }
}
