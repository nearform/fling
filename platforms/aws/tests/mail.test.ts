/**
 * SesMailer: the Mailer conformance suite against a stubbed SES v2 client (what each SendEmail
 * carried is what the provider "received"), and the request it builds: headers, tags, the
 * configuration set.
 */
import {
  LimitExceededException,
  MessageRejected,
  type SendEmailCommand,
  type SendEmailRequest,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2'
import { BATCH_ID_HEADER } from '@fling/api/mail'
import {
  type DeliveredMail,
  mailerConformance,
  mailMessage as message,
  type ProviderFailure,
} from '@fling/conformance'
import { describe, expect, it, vi } from 'vitest'
import { BATCH_TAG, EVENTS_TAG, type SesClient, SesMailer, sesFailure } from '../src/mail/ses.ts'

const $metadata = {}

/** What SES says for each failure the adapter maps. */
const SES_ERRORS: Record<Exclude<ProviderFailure, 'suppressed'>, () => Error> = {
  throttle: () =>
    new TooManyRequestsException({ message: 'Maximum sending rate exceeded.', $metadata }),
  quota: () => new LimitExceededException({ message: 'Daily message quota exceeded.', $metadata }),
  rejected: () => new MessageRejected({ message: 'Email address is not verified.', $metadata }),
  transient: () => Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
}

class StubSes implements SesClient {
  readonly requests: SendEmailRequest[] = []
  private count = 0
  constructor(private readonly fail?: () => Error) {}
  async send(command: SendEmailCommand) {
    if (this.fail) throw this.fail()
    this.requests.push(command.input)
    return { MessageId: `ses-${++this.count}`, $metadata }
  }
}

/** `"Name" <addr>` or `=?UTF-8?B?…?= <addr>`, back to its parts. */
function parseFrom(value: string) {
  const match = /^(.*) <([^>]+)>$/.exec(value)
  if (!match) throw new Error(`unexpected From: ${value}`)
  const [, phrase = '', address = ''] = match
  const encoded = /^=\?UTF-8\?B\?(.*)\?=$/.exec(phrase)
  const name = encoded
    ? Buffer.from(encoded[1] ?? '', 'base64').toString('utf8')
    : phrase.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1')
  return { address, name }
}

const delivered = (ses: StubSes) => async (): Promise<DeliveredMail[]> =>
  ses.requests.map(r => ({
    to: r.Destination?.ToAddresses?.[0] ?? '',
    subject: r.Content?.Simple?.Subject?.Data ?? '',
    from: parseFrom(r.FromEmailAddress ?? ''),
    headers: Object.fromEntries(
      (r.Content?.Simple?.Headers ?? []).map(h => [h.Name ?? '', h.Value ?? ''])
    ),
  }))

mailerConformance(
  'SesMailer (stubbed SES v2 client)',
  () => {
    const ses = new StubSes()
    return { mailer: new SesMailer({}, ses), delivered: delivered(ses) }
  },
  {
    failing: failure =>
      new SesMailer({}, new StubSes(SES_ERRORS[failure as keyof typeof SES_ERRORS])),
    // SES accepts a send to a suppressed address and drops it: it never reports one.
    failures: ['throttle', 'quota', 'rejected', 'transient'],
  }
)

describe('SesMailer', () => {
  it('sends one message per recipient with the unsubscribe headers, the batch tag and the configuration set', async () => {
    const ses = new StubSes()
    const mailer = new SesMailer({ configurationSet: 'fling-mail' }, ses)
    await mailer.send(message({ batchId: 'b:1', tags: ['comment.created', 'comment.reply'] }))
    const [request] = ses.requests
    expect(request).toMatchObject({
      FromEmailAddress: '"Acme Fling" <fling@mail.example.test>',
      Destination: { ToAddresses: ['reader@example.test'] },
      ReplyToAddresses: ['help@example.test'],
      ConfigurationSetName: 'fling-mail',
      Content: {
        Simple: {
          Subject: { Data: 'Ana shared q3-report with you', Charset: 'UTF-8' },
          Body: { Html: { Charset: 'UTF-8' }, Text: { Charset: 'UTF-8' } },
        },
      },
    })
    expect(request?.Content?.Simple?.Headers).toEqual(
      expect.arrayContaining([
        { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        { Name: BATCH_ID_HEADER, Value: 'b:1' },
      ])
    )
    expect(request?.EmailTags).toEqual([
      { Name: BATCH_TAG, Value: 'b_1' },
      { Name: EVENTS_TAG, Value: 'comment_created-comment_reply' },
    ])
  })

  it('leaves the configuration set and reply-to out when they are not set', async () => {
    const ses = new StubSes()
    await new SesMailer({}, ses).send(message({ replyTo: undefined }))
    expect(ses.requests[0]).not.toHaveProperty('ConfigurationSetName')
    expect(ses.requests[0]).not.toHaveProperty('ReplyToAddresses')
  })

  it('logs a rejection by name and code, never its message (the sandbox quotes the address)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const sandbox = () =>
        new MessageRejected({
          message:
            'Email address is not verified. The following identities failed the check in region EU-WEST-1: reader@example.test',
          $metadata,
        })
      await new SesMailer({}, new StubSes(sandbox)).send(message())
      expect(error).toHaveBeenCalledOnce()
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain('MessageRejected')
      expect(line).not.toContain('reader@example.test')
      expect(line).not.toContain('not verified')
    } finally {
      error.mockRestore()
    }
  })

  it('maps SES errors by name, and the daily quota by its message', () => {
    const named = (name: string, text = 'x') => Object.assign(new Error(text), { name })
    expect(sesFailure(named('ThrottlingException'))).toMatchObject({ reason: 'throttled' })
    expect(sesFailure(named('ThrottlingException'))).not.toHaveProperty('quota')
    expect(
      sesFailure(named('TooManyRequestsException', 'Daily message quota exceeded.'))
    ).toMatchObject({ reason: 'throttled', quota: true, retry: true })
    expect(sesFailure(named('MailFromDomainNotVerifiedException'))).toMatchObject({
      reason: 'rejected',
      retry: false,
    })
    expect(
      sesFailure(named('LimitExceededException', 'Daily message quota exceeded.'))
    ).toMatchObject({ reason: 'throttled', quota: true, retry: true })
    // Any other limit (too many configuration sets, a request too large) is a setup problem.
    expect(sesFailure(named('LimitExceededException', 'Too many tags.'))).toMatchObject({
      reason: 'rejected',
      retry: false,
    })
    for (const name of [
      'SendingPausedException',
      'AccountSuspendedException',
      'NotFoundException',
      'BadRequestException',
    ]) {
      expect(sesFailure(named(name))).toMatchObject({
        reason: 'rejected',
        retry: false,
        detail: name,
      })
    }
    expect(sesFailure(named('TooManyRequestsException'))).toMatchObject({
      reason: 'throttled',
      retry: true,
    })
    expect(sesFailure(named('InternalServiceErrorException'))).toMatchObject({
      reason: 'transient',
      retry: true,
      detail: 'InternalServiceErrorException',
    })
  })
})
