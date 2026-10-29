/**
 * KeptMailer: a platform's mailer under local development (dev login on), keeping a copy of each
 * message it accepts so `GET /dev/mail` can show it, as it shows the memory and file mailers'.
 * Under `wrangler dev` the Worker's real Email Service binding only logs and saves to files the
 * Worker can't read, and the e2e reads its sign-in links from `/dev/mail`.
 *
 * The copies live in the module (deps may be built per request), newest last, at most KEPT_MAX.
 * Never used in production: buildDeps wraps only with dev login on.
 */
import type { SentMail } from './memory.ts'
import type { Mailer, MailMessage, MailResult } from './types.ts'

const KEPT_MAX = 200
const kept: SentMail[] = []
let count = 0

export class KeptMailer implements Mailer {
  constructor(private readonly inner: Mailer) {}

  /** what was accepted, oldest first */
  get sent(): readonly SentMail[] {
    return kept
  }

  async send(message: MailMessage): Promise<MailResult> {
    const result = await this.inner.send(message)
    if (result.ok) {
      kept.push({ providerId: result.providerId ?? `kept-${++count}`, message, sentAt: new Date() })
      if (kept.length > KEPT_MAX) kept.splice(0, kept.length - KEPT_MAX)
    }
    return result
  }
}
