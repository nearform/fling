/**
 * The two Slack Web API methods unfurling needs, over plain HTTPS with the bot token: who posted
 * (`users.info`, scope `users:read.email`) and the previews (`chat.unfurl`, scope `links:write`).
 * Each call gives up after SLACK_CALL_TIMEOUT_MS, so the events route answers Slack in time.
 */

export const SLACK_API = 'https://slack.com/api'
const SLACK_CALL_TIMEOUT_MS = 2000

/** What `chat.unfurl` attaches to one link: Block Kit blocks. */
export interface SlackUnfurl {
  blocks: unknown[]
}

/** Where the previews go: the posted message, or the message being written (`composer`). */
export type UnfurlTarget =
  | { channel: string; ts: string }
  | { unfurlId: string; source: 'composer' | 'conversations_history' }

export interface SlackClient {
  /** The Slack user's email address, if they are a person with one (not a bot, not deactivated). */
  userEmail(userId: string): Promise<string | null>
  unfurl(target: UnfurlTarget, unfurls: Record<string, SlackUnfurl>): Promise<void>
}

export class SlackWebClient implements SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = SLACK_API
  ) {}

  async userEmail(userId: string): Promise<string | null> {
    const res = await this.call(`users.info?user=${encodeURIComponent(userId)}`, { method: 'GET' })
    const user = res.user as
      | { deleted?: boolean; is_bot?: boolean; profile?: { email?: string } }
      | undefined
    if (!user || user.deleted || user.is_bot) return null
    return user.profile?.email?.trim().toLowerCase() || null
  }

  async unfurl(target: UnfurlTarget, unfurls: Record<string, SlackUnfurl>): Promise<void> {
    const where =
      'unfurlId' in target
        ? { unfurl_id: target.unfurlId, source: target.source }
        : { channel: target.channel, ts: target.ts }
    await this.call('chat.unfurl', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ...where, unfurls }),
    })
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.base}/${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${this.token}`,
      },
      signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // Slack answers 200 with `ok: false` and an `error` code for most failures.
    if (!res.ok || body.ok !== true) {
      throw new Error(`Slack ${path.split('?')[0]}: ${String(body.error ?? res.status)}`)
    }
    return body
  }
}
