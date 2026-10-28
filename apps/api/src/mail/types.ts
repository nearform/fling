/**
 * The Mailer port: how the email channel hands one rendered message to a provider. The core has
 * `MemoryMailer` (tests, the e2e's Node runtime) and `FileMailer` (local dev); each platform
 * supplies its cloud's (SES on AWS, the Email Service binding on Cloudflare). Every one passes
 * `mailerConformance` in @fling/conformance.
 *
 * An adapter never throws for a provider's refusal: it maps it onto `MailResult` (throttling and
 * the daily quota to `throttled`, a refused or misconfigured send to `rejected`, a suppressed
 * recipient to `suppressed`, anything unexpected to `transient`). It passes the message through
 * `prepareMessage` first, so no header carries a line break and a malformed recipient is refused
 * before any provider sees it.
 */

export interface MailMessage {
  to: string
  from: { address: string; name: string }
  /** MAIL_REPLY_TO, the operator's; never the actor's */
  replyTo?: string
  /** one line: `prepareMessage` strips CR/LF */
  subject: string
  text: string
  html: string
  /** extra headers (List-Unsubscribe, List-Unsubscribe-Post) */
  headers: Record<string, string>
  /** the batch id: adapters tag the message with it (SES tag, a header on Cloudflare) */
  batchId: string
  /** event keys, for provider analytics; never personal data */
  tags: string[]
}

export type MailFailureReason = 'throttled' | 'transient' | 'rejected' | 'suppressed'

export type MailResult =
  | { ok: true; providerId?: string }
  | {
      ok: false
      /** worth trying again later (throttled, transient) */
      retry: boolean
      reason: MailFailureReason
      /** throttled by the provider's daily quota, not its rate: wait for the next UTC day */
      quota?: boolean
      /**
       * The provider's error code or a short explanation (`E_SENDER_NOT_VERIFIED`,
       * `MessageRejected`), for logs and the admin page. Never an address or message content.
       */
      detail?: string
    }

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>
}

/** The header every adapter that can set headers tags a message's batch with. */
export const BATCH_ID_HEADER = 'X-Fling-Batch'

/** A single address, as the config and the email policy accept them. */
const ADDRESS_RE = /^[^@\s<>"(),;:\\[\]]+@[^@\s<>"(),;:\\[\]]+\.[^@\s<>"(),;:\\[\]]+$/

export const isMailAddress = (value: string) => value.length <= 254 && ADDRESS_RE.test(value)

/** One line of header text: CR, LF and other control characters become spaces. */
export function headerSafe(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/** A header name: RFC 5322 field-name characters only. */
const HEADER_NAME_RE = /^[!-9;-~]+$/

/** What a mailer may not send: why, as a `MailResult`. */
const refuse = (detail: string): MailResult => ({
  ok: false,
  retry: false,
  reason: 'rejected',
  detail,
})

/**
 * The message an adapter sends: subject, display name and header values on one line, header names
 * well formed. Or the result to return instead, when an address is malformed.
 */
export function prepareMessage(message: MailMessage): MailMessage | { refused: MailResult } {
  if (!isMailAddress(message.to)) return { refused: refuse('invalid recipient') }
  if (!isMailAddress(message.from.address)) return { refused: refuse('invalid sender') }
  if (message.replyTo !== undefined && !isMailAddress(message.replyTo)) {
    return { refused: refuse('invalid reply-to') }
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(message.headers)) {
    if (HEADER_NAME_RE.test(name)) headers[name] = headerSafe(value)
  }
  return {
    ...message,
    from: { address: message.from.address, name: headerSafe(message.from.name) },
    subject: headerSafe(message.subject),
    headers,
    batchId: headerSafe(message.batchId),
    tags: message.tags.map(headerSafe),
  }
}

export const wasRefused = (
  prepared: MailMessage | { refused: MailResult }
): prepared is { refused: MailResult } => 'refused' in prepared
