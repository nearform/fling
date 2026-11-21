/**
 * AcsMailer: the Mailer port on Azure Communication Services Email. One send per recipient, from
 * MAIL_FROM (a sender username on the instance's verified domain, infra/mail.tf), with the
 * List-Unsubscribe headers and the batch id (`X-Fling-Batch`) as the message's custom headers and
 * engagement tracking off. ACS takes no display name per message: the sender username's display
 * name (the Terraform `mail.from_name`) is the one recipients see, so `from.name` is not sent.
 *
 * A send is an operation ACS accepts and then runs. Each attempt names a new operation (a random
 * UUID, which is the provider id). ACS's Email Send reference documents `Operation-Id` only as "the
 * ID provided by the customer to identify the long running operation" (REST API 2025-09-01), not
 * what a repeated one answers: a 409, or the earlier operation's outcome, would report a delivered
 * retry as failed or keep a failed one failing. So an attempt is never named after an earlier one,
 * and the duplicate this accepts is the one every provider here has: a send ACS accepted whose
 * answer never arrived (the network failing after the 202) is retried and can arrive twice. A send
 * still running when the wait ends is not retried. The mailer waits for the outcome for up to
 * `waitMs`; one still running then counts as sent, since ACS has taken it. The SDK's poller
 * reports a failed operation by throwing an Error whose message carries ACS's error code (`The
 * long-running operation has failed. <code>. <message>`); the mailer reads the code from there.
 *
 * ACS's answers map onto `MailResult`, never a throw: 429 (its per-minute and per-hour sending
 * limits) to `throttled`; an operation that failed because every recipient is on the domain's
 * suppression list to `suppressed`; a bad request, a refused or unknown sender or domain and a
 * missing permission (400, 401, 403, 404) to `rejected`, with an error log, because the sending
 * setup is wrong; anything else (5xx, the network, a failed or cancelled operation) to `transient`.
 * ACS has no daily quota, so nothing maps to `quota`. Logs carry the status and code, never
 * ACS's message, which can quote an address.
 */
import { randomUUID } from 'node:crypto'
import type { EmailMessage, EmailSendResponse } from '@azure/communication-email'
import {
  BATCH_ID_HEADER,
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from '@fling/api/mail'

/** What AcsMailer needs of the SDK's EmailClient, so tests can stub it. */
export interface AcsClient {
  beginSend(
    message: EmailMessage,
    options?: { operationId?: string; abortSignal?: AbortSignal }
  ): Promise<{ pollUntilDone(): Promise<EmailSendResponse> }>
}

export interface AcsMailerOptions {
  /** how long a send waits for ACS's outcome (default 10 s) */
  waitMs?: number
}

type Failure = Extract<MailResult, { ok: false }>

/** The error codes ACS gives a send dropped for suppressed recipients. */
const SUPPRESSED = /suppress/i

const REJECTED_STATUS = new Set([400, 401, 403, 404])

/** How the SDK's poller words an operation that ended Failed (`@azure/core-lro`). */
const OPERATION_FAILED = /^The long-running operation has failed(?:\. (\w+)\.)?/

/** The status and code of an SDK error (a RestError), if it has them. */
function describe(err: unknown): { status?: number; code?: string } {
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown } | null
  return {
    ...(typeof e?.statusCode === 'number' ? { status: e.statusCode } : {}),
    ...(typeof e?.code === 'string' ? { code: e.code } : {}),
  }
}

/** The ACS error code of an operation the poller reported failed, if `err` is one. */
function operationFailure(err: unknown): { code?: string } | undefined {
  if (!(err instanceof Error)) return undefined
  const match = OPERATION_FAILED.exec(err.message)
  if (!match) return undefined
  return match[1] ? { code: match[1] } : {}
}

/** An error ACS answered (or the network raised) as a `MailResult`. */
export function acsFailure(err: unknown): Failure {
  const failed = operationFailure(err)
  if (failed) return codeFailure(failed.code ?? 'Failed')
  const { status, code } = describe(err)
  const detail = code ?? (status === undefined ? 'Error' : String(status))
  if (status === 429) return { ok: false, retry: true, reason: 'throttled', detail }
  if (code && SUPPRESSED.test(code))
    return { ok: false, retry: false, reason: 'suppressed', detail }
  if (status !== undefined && REJECTED_STATUS.has(status)) {
    return { ok: false, retry: false, reason: 'rejected', detail }
  }
  return { ok: false, retry: true, reason: 'transient', detail }
}

/** A finished operation that did not succeed, as a `MailResult`. */
function outcomeFailure(result: EmailSendResponse): Failure {
  return codeFailure(result.error?.code ?? result.status)
}

/** A failed operation's code as a `MailResult`: suppressed recipients, else transient. */
function codeFailure(code: string): Failure {
  if (SUPPRESSED.test(code)) return { ok: false, retry: false, reason: 'suppressed', detail: code }
  return { ok: false, retry: true, reason: 'transient', detail: code }
}

export class AcsMailer implements Mailer {
  constructor(
    private readonly client: AcsClient,
    private readonly opts: AcsMailerOptions = {}
  ) {}

  /** The ACS message for one prepared message. */
  request(message: MailMessage): EmailMessage {
    return {
      senderAddress: message.from.address,
      recipients: { to: [{ address: message.to }] },
      ...(message.replyTo ? { replyTo: [{ address: message.replyTo }] } : {}),
      content: { subject: message.subject, plainText: message.text, html: message.html },
      headers: { ...message.headers, [BATCH_ID_HEADER]: message.batchId },
      disableUserEngagementTracking: true,
    }
  }

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    const operationId = randomUUID()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.opts.waitMs ?? 10_000)
    try {
      const poller = await this.client.beginSend(this.request(prepared), {
        operationId,
        abortSignal: abort.signal,
      })
      const result = await poller.pollUntilDone().catch(err => {
        // Accepted and still running when the wait ran out: ACS has it.
        if (abort.signal.aborted) return null
        throw err
      })
      if (result && result.status !== 'Succeeded')
        return this.logged(outcomeFailure(result), prepared)
      return { ok: true, providerId: result?.id ?? operationId }
    } catch (err) {
      return this.logged(acsFailure(err), prepared)
    } finally {
      clearTimeout(timer)
    }
  }

  private logged(failure: Failure, message: MailMessage): Failure {
    if (failure.reason === 'rejected') {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'acs refused a send: check the domain, MAIL_FROM and the identity’s role',
          error: failure.detail,
          batch: message.batchId,
        })
      )
    }
    return failure
  }
}
