/**
 * SmtpMailer: the Mailer port over SMTP (nodemailer), which every transactional provider (Postmark,
 * SendGrid, Mailgun, Resend, Brevo, SES's SMTP interface…) and every self-hosted relay accepts. One
 * message per send, with the List-Unsubscribe headers and the batch id (`X-Fling-Batch`) as
 * headers. The connection is pooled and kept open between sends.
 *
 * Security (`SMTP_SECURITY`): `tls` connects over TLS (port 465), `starttls` (the default, port
 * 587) refuses a server that won't upgrade the connection, and `none` (local relays and tests) is
 * refused in production by the config.
 *
 * An SMTP reply is mapped onto `MailResult` by its code and wording (docs/design/notifications.md
 * §5.2), since providers agree on the codes far more than on the text:
 * - the recipient's mailbox is full (`452 4.2.2`, `552 5.2.2`, "over quota") → `transient` for a
 *   4xx, `rejected` for a 5xx: it is their quota, never the sender's;
 * - our daily or sending quota, a policy reply that says so (`454 4.7.0 Daily sending quota
 *   exceeded`, any 4.7.x or 5.7.x) → `throttled`, `quota`, which holds the batches until the next
 *   UTC day;
 * - a rate limit, or `421` (the server sheds load) → `throttled`;
 * - any other 4xx (greylisting's `451 4.7.1 Try again later` included), and a connection that
 *   fails or times out → `transient`. A connection or TLS failure is also logged as a warning, once
 *   until a send succeeds again, since it usually means SMTP_HOST, SMTP_PORT or SMTP_SECURITY is
 *   wrong;
 * - a 5xx that says the recipient is suppressed, blocklisted or inactive → `suppressed`;
 * - any other 5xx, and failed authentication → `rejected`, logged as an error, because that means
 *   the sending setup is wrong (or the recipient doesn't exist).
 * The detail is the reply's code and enhanced status (`SMTP 550 5.1.1`), never its text, which can
 * carry the address.
 */
import type { Config } from '@fling/api/config'
import {
  BATCH_ID_HEADER,
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from '@fling/api/mail'
import nodemailer, { type Transporter } from 'nodemailer'

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpOptions {
  host: string
  port: number
  security: SmtpSecurity
  user?: string
  password?: string
  /** how long a connection, greeting or reply may take (default 30 s) */
  timeoutMs?: number
}

type Failure = Extract<MailResult, { ok: false }>

const QUOTA = /quota|daily (sending )?limit|sending limit/i
const RATE = /rate.?limit|too many|throttl|slow down/i
const SUPPRESSED = /suppress|block.?list|black.?list|inactive (recipient|address)|unsubscribed/i
const ENHANCED = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/
/** nodemailer's codes for a connection that failed before a reply: the setup, usually. */
const CONNECTION_CODES = new Set(['ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'ETLS', 'EDNS'])

/** A nodemailer error as a `MailResult`. */
export function smtpFailure(err: unknown): Failure {
  const e = (err ?? {}) as { responseCode?: unknown; response?: unknown; code?: unknown }
  const status = typeof e.responseCode === 'number' ? e.responseCode : undefined
  const reply = typeof e.response === 'string' ? e.response : ''
  const parts = reply.match(ENHANCED)
  const enhanced = parts?.[0]
  const detail = status
    ? `SMTP ${status}${enhanced ? ` ${enhanced}` : ''}`
    : typeof e.code === 'string'
      ? e.code
      : err instanceof Error
        ? err.name
        : 'Error'
  if (e.code === 'EAUTH') return { ok: false, retry: false, reason: 'rejected', detail }
  if (status === undefined || status < 400) {
    return { ok: false, retry: true, reason: 'transient', detail }
  }
  // x.2.2: the recipient's mailbox is full, whatever the text says about quotas.
  if (parts?.[2] === '2' && parts[3] === '2') {
    return status < 500
      ? { ok: false, retry: true, reason: 'transient', detail }
      : { ok: false, retry: false, reason: 'rejected', detail }
  }
  if (parts?.[2] === '7' && QUOTA.test(reply)) {
    return { ok: false, retry: true, reason: 'throttled', quota: true, detail }
  }
  if (status === 421 || RATE.test(reply)) {
    return { ok: false, retry: true, reason: 'throttled', detail }
  }
  if (status < 500) return { ok: false, retry: true, reason: 'transient', detail }
  if (SUPPRESSED.test(reply)) return { ok: false, retry: false, reason: 'suppressed', detail }
  return { ok: false, retry: false, reason: 'rejected', detail }
}

/** Whether a failure is a connection or TLS one (no reply from the server). */
export function connectionFailure(err: unknown): boolean {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown }
  return (
    typeof e.responseCode !== 'number' && typeof e.code === 'string' && CONNECTION_CODES.has(e.code)
  )
}

export class SmtpMailer implements Mailer {
  private transport: Transporter
  /** a connection failure has been logged since the last send that worked */
  private warned = false

  constructor(opts: SmtpOptions) {
    const timeout = opts.timeoutMs ?? 30_000
    this.transport = nodemailer.createTransport({
      pool: true,
      host: opts.host,
      port: opts.port,
      secure: opts.security === 'tls',
      requireTLS: opts.security === 'starttls',
      ignoreTLS: opts.security === 'none',
      ...(opts.user ? { auth: { user: opts.user, pass: opts.password ?? '' } } : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    })
  }

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    try {
      const info = await this.transport.sendMail({
        to: prepared.to,
        from: { address: prepared.from.address, name: prepared.from.name },
        ...(prepared.replyTo ? { replyTo: prepared.replyTo } : {}),
        subject: prepared.subject,
        text: prepared.text,
        html: prepared.html,
        headers: { ...prepared.headers, [BATCH_ID_HEADER]: prepared.batchId },
        // Nothing the message carries may set the envelope: it is the From and To above.
        envelope: { from: prepared.from.address, to: [prepared.to] },
        disableFileAccess: true,
        disableUrlAccess: true,
      })
      this.warned = false
      return { ok: true, providerId: info.messageId }
    } catch (err) {
      const failure = smtpFailure(err)
      if (connectionFailure(err) && !this.warned) {
        this.warned = true
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'could not reach the SMTP server: check SMTP_HOST, SMTP_PORT and SMTP_SECURITY',
            error: failure.detail,
          })
        )
      }
      if (failure.reason === 'rejected') {
        // Never the address or content: the batch id and the reply's code.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'the SMTP server refused a send: check SMTP_* and MAIL_FROM',
            error: failure.detail,
            batch: prepared.batchId,
          })
        )
      }
      return failure
    }
  }

  /** Close the pooled connections. */
  close() {
    this.transport.close()
  }
}

/** The `smtp` mail driver's mailer from config (`SMTP_*`, the `SMTP_PASSWORD` secret), if it is the driver. */
export function smtpMailerFor(config: Config): SmtpMailer | undefined {
  const smtp = config.mail?.driver === 'smtp' ? config.mail.smtp : undefined
  if (!smtp) return undefined
  return new SmtpMailer({ ...smtp, password: config.secrets.smtpPassword })
}
