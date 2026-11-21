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
 * - a daily or sending quota (`454 4.7.0 Daily sending quota exceeded`) → `throttled`, `quota`;
 * - a rate limit, or `421` (the server sheds load) → `throttled`;
 * - any other 4xx, and a connection that fails or times out → `transient`;
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
const RATE = /rate.?limit|too many|throttl|slow down|try (again )?later/i
const SUPPRESSED = /suppress|block.?list|black.?list|inactive (recipient|address)|unsubscribed/i
const ENHANCED = /\b[245]\.\d{1,3}\.\d{1,3}\b/

/** A nodemailer error as a `MailResult`. */
export function smtpFailure(err: unknown): Failure {
  const e = (err ?? {}) as { responseCode?: unknown; response?: unknown; code?: unknown }
  const status = typeof e.responseCode === 'number' ? e.responseCode : undefined
  const reply = typeof e.response === 'string' ? e.response : ''
  const enhanced = reply.match(ENHANCED)?.[0]
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
  if (QUOTA.test(reply)) return { ok: false, retry: true, reason: 'throttled', quota: true, detail }
  if (status === 421 || RATE.test(reply)) {
    return { ok: false, retry: true, reason: 'throttled', detail }
  }
  if (status < 500) return { ok: false, retry: true, reason: 'transient', detail }
  if (SUPPRESSED.test(reply)) return { ok: false, retry: false, reason: 'suppressed', detail }
  return { ok: false, retry: false, reason: 'rejected', detail }
}

export class SmtpMailer implements Mailer {
  private transport: Transporter

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
      return { ok: true, providerId: info.messageId }
    } catch (err) {
      const failure = smtpFailure(err)
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
