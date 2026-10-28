/**
 * SesMailer: the Mailer port on Amazon SES v2. One `SendEmail` per recipient, from MAIL_FROM on
 * the operator's identity, naming SES_CONFIGURATION_SET when one is set (otherwise the identity's
 * default configuration set applies). The List-Unsubscribe headers and the batch id go on the
 * message as headers; the batch id and the event keys also go on it as message tags, so the
 * operator's event destinations can tell Fling's sends apart.
 *
 * SES errors map onto `MailResult` (docs/design/notifications.md §5.2): its rate limit to
 * `throttled`, the daily sending quota (a throttle or `LimitExceededException` whose message names
 * it) to `throttled` with `quota`, and `MessageRejected`, an unverified MAIL FROM domain, paused
 * sending, a suspended account, a missing configuration set, a bad request and any other
 * `LimitExceededException` to `rejected` with an error log, because they mean the sending setup is
 * wrong; anything else to `transient`. Logs carry the error's name and code, never its message. A
 * send to an address on SES's suppression list is accepted and dropped by SES, so nothing maps to
 * `suppressed` here.
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

const THROTTLED = new Set(['TooManyRequestsException', 'ThrottlingException', 'Throttling'])
/**
 * Refusals that mean the sending setup is wrong, not that this message was: retrying will not help
 * until the operator acts (an unverified sender, paused sending, a missing configuration set).
 */
const REJECTED = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'SendingPausedException',
  'AccountSuspendedException',
  'NotFoundException',
  'BadRequestException',
])
/** A limit SES reports this way is the daily quota only when its message says so. */
const LIMIT_EXCEEDED = 'LimitExceededException'

/** SES's daily sending quota, as its error message words it ("Daily message quota exceeded"). */
const DAILY_QUOTA = /daily (message |sending )?quota/i

/** The error's code, when SES gives one apart from its name. */
const errorCode = (err: unknown) => {
  const code =
    (err as { Code?: unknown; code?: unknown } | null)?.Code ??
    (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * An SES error as a `MailResult`. Only the error's name is kept (`detail`): SES's messages can
 * quote addresses (the sandbox names the unverified recipient).
 */
export function sesFailure(err: unknown): Extract<MailResult, { ok: false }> {
  const name = err instanceof Error ? err.name : 'Error'
  const text = err instanceof Error ? err.message : String(err)
  if ((THROTTLED.has(name) || name === LIMIT_EXCEEDED) && DAILY_QUOTA.test(text)) {
    return { ok: false, retry: true, reason: 'throttled', quota: true, detail: name }
  }
  if (THROTTLED.has(name)) return { ok: false, retry: true, reason: 'throttled', detail: name }
  if (REJECTED.has(name) || name === LIMIT_EXCEEDED) {
    return { ok: false, retry: false, reason: 'rejected', detail: name }
  }
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
        // Never the address or content, so never SES's message (the sandbox's names the
        // recipient): the batch id, and the error's name and code.
        const code = errorCode(err)
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'ses refused a send: check the identity, MAIL_FROM and the configuration set',
            error: failure.detail,
            ...(code && code !== failure.detail ? { code } : {}),
            batch: prepared.batchId,
          })
        )
      }
      return failure
    }
  }
}
