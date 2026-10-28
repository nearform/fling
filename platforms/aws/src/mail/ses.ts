/**
 * SesMailer: the Mailer port on Amazon SES v2. One `SendEmail` per recipient, from MAIL_FROM on
 * the operator's identity, naming SES_CONFIGURATION_SET when one is set (otherwise the identity's
 * default configuration set applies). The List-Unsubscribe headers and the batch id go on the
 * message as headers; the batch id and the event keys also go on it as message tags, so the
 * operator's event destinations can tell Fling's sends apart.
 *
 * SES errors map onto `MailResult` (docs/design/notifications.md §5.2): its rate limit to
 * `throttled`, the daily sending quota to `throttled` with `quota`, `MessageRejected` (and an
 * unverified MAIL FROM domain) to `rejected` with an error log, because they mean the sending
 * setup is wrong; anything else to `transient`. A send to an address on SES's suppression list is
 * accepted and dropped by SES, so nothing maps to `suppressed` here.
 */
import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput,
  type SendEmailRequest,
} from '@aws-sdk/client-sesv2'
import {
  BATCH_ID_HEADER,
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from '@fling/api/mail'

/** What SesMailer needs of the SDK client, so tests can stub it. */
export interface SesClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>
}

export interface SesMailerOptions {
  /** SES_CONFIGURATION_SET */
  configurationSet?: string
}

/** The tag carrying the batch id; `fling-events` carries the event keys. */
export const BATCH_TAG = 'fling-batch'
export const EVENTS_TAG = 'fling-events'

/** A message tag value: SES allows letters, digits, `_` and `-`, at most 256 characters. */
export const tagValue = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || '_'

/** A display name as an RFC 5322 phrase: quoted ASCII, or a MIME encoded-word otherwise. */
export function displayName(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}"`
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`
}

const THROTTLED = new Set([
  'TooManyRequestsException',
  'ThrottlingException',
  'Throttling',
  'LimitExceededException',
])
const REJECTED = new Set(['MessageRejected', 'MailFromDomainNotVerifiedException'])

/** SES's daily sending quota, as its error message words it ("Daily message quota exceeded"). */
const DAILY_QUOTA = /daily (message |sending )?quota/i

/** An SES error as a `MailResult`. */
export function sesFailure(err: unknown): Extract<MailResult, { ok: false }> {
  const name = err instanceof Error ? err.name : 'Error'
  const text = err instanceof Error ? err.message : String(err)
  if (DAILY_QUOTA.test(text)) {
    return { ok: false, retry: true, reason: 'throttled', quota: true, detail: name }
  }
  if (THROTTLED.has(name)) return { ok: false, retry: true, reason: 'throttled', detail: name }
  if (REJECTED.has(name)) return { ok: false, retry: false, reason: 'rejected', detail: name }
  return { ok: false, retry: true, reason: 'transient', detail: name }
}

export class SesMailer implements Mailer {
  constructor(
    private readonly opts: SesMailerOptions = {},
    private readonly client: SesClient = new SESv2Client({})
  ) {}

  /** The SendEmail request for one prepared message. */
  request(message: MailMessage): SendEmailRequest {
    const headers = { ...message.headers, [BATCH_ID_HEADER]: message.batchId }
    return {
      FromEmailAddress: `${displayName(message.from.name)} <${message.from.address}>`,
      Destination: { ToAddresses: [message.to] },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            Html: { Data: message.html, Charset: 'UTF-8' },
          },
          Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
        },
      },
      EmailTags: [
        { Name: BATCH_TAG, Value: tagValue(message.batchId) },
        ...(message.tags.length
          ? [{ Name: EVENTS_TAG, Value: tagValue(message.tags.join('-')) }]
          : []),
      ],
      ...(this.opts.configurationSet ? { ConfigurationSetName: this.opts.configurationSet } : {}),
    }
  }

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    try {
      const out = await this.client.send(new SendEmailCommand(this.request(prepared)))
      return { ok: true, ...(out.MessageId ? { providerId: out.MessageId } : {}) }
    } catch (err) {
      const failure = sesFailure(err)
      if (failure.reason === 'rejected') {
        // Never the address or content: the batch id and SES's own words about the setup.
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'ses refused a send: check the identity, MAIL_FROM and the configuration set',
            error: failure.detail,
            message: err instanceof Error ? err.message.slice(0, 200) : undefined,
            batch: prepared.batchId,
          })
        )
      }
      return failure
    }
  }
}
