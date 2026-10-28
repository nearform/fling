/**
 * MemoryMailer: keeps every message it accepts, in order, for tests and the e2e's Node runtime.
 * `failNext` scripts what the following sends return instead (a throttle, the daily quota, a
 * rejection), so core tests can drive retries and deferrals without a provider.
 */
import {
  type Mailer,
  type MailMessage,
  type MailResult,
  prepareMessage,
  wasRefused,
} from './types.ts'

export interface SentMail {
  providerId: string
  message: MailMessage
  sentAt: Date
}

export class MemoryMailer implements Mailer {
  /** what was accepted, oldest first */
  readonly sent: SentMail[] = []
  private script: Extract<MailResult, { ok: false }>[] = []
  private count = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The next sends (one per result, in order) fail with these results. */
  failNext(...results: Extract<MailResult, { ok: false }>[]) {
    this.script.push(...results)
  }

  /** Accepted messages to `to`, oldest first. */
  sentTo(to: string) {
    return this.sent.filter(m => m.message.to === to)
  }

  clear() {
    this.sent.length = 0
    this.script = []
  }

  async send(message: MailMessage): Promise<MailResult> {
    const prepared = prepareMessage(message)
    if (wasRefused(prepared)) return prepared.refused
    const scripted = this.script.shift()
    if (scripted) return scripted
    const providerId = `memory-${++this.count}`
    this.sent.push({ providerId, message: prepared, sentAt: this.now() })
    return { ok: true, providerId }
  }
}
