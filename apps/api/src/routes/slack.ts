/**
 * `POST /api/integrations/slack/events`: the instance's Slack app's Events API endpoint, mounted only
 * when the app is set up (`slackUnfurls`, slack/config.ts). No session: each request is proven
 * Slack's by its signature (slack/signature.ts) before anything else is read from it.
 *
 * - `url_verification`: the challenge back, when an admin sets the request URL.
 * - `link_shared`: previews for the links (slack/unfurl.ts), sent before answering. Slack wants an
 *   answer within three seconds and retries otherwise; each Slack call is capped below that, and a
 *   retry (`X-Slack-Retry-Num`) is answered without working again, so a slow first try never
 *   posts twice. Working before answering keeps this the same on every platform: nothing has to
 *   outlive the response.
 *
 * Every other event is acknowledged and ignored. A failure is logged and answered 200 too: Slack's
 * retry would fail the same way.
 */
import { Hono } from 'hono'
import { bodyUpTo } from '../lib/body.ts'
import type { UnfurlTarget } from '../slack/client.ts'
import { verifySlackRequest } from '../slack/signature.ts'
import { unfurlLinks } from '../slack/unfurl.ts'
import type { AppEnv } from '../types.ts'

/** Slack's events are small; anything bigger isn't one. */
const EVENT_BYTES_MAX = 64 * 1024

interface SlackEnvelope {
  type?: string
  challenge?: string
  event?: {
    type?: string
    user?: string
    channel?: string
    message_ts?: string
    unfurl_id?: string
    source?: string
    links?: { url?: string }[]
  }
}

/** Where the routes are mounted: the Slack app's request URL is this plus `/events`. */
export const SLACK_EVENTS_BASE = '/api/integrations/slack'

export const slackRoutes = new Hono<AppEnv>()

slackRoutes.post('/events', async c => {
  const deps = c.get('deps')
  const { slack } = deps
  const secret = deps.config.secrets.slackSigningSecret
  if (!slack || !secret) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404)

  const bytes = await bodyUpTo(c.req.raw, EVENT_BYTES_MAX)
  const body = bytes ? new TextDecoder().decode(bytes) : ''
  const signed = verifySlackRequest(
    secret,
    {
      timestamp: c.req.header('x-slack-request-timestamp'),
      signature: c.req.header('x-slack-signature'),
      body,
    },
    Math.floor(deps.clock.now().getTime() / 1000)
  )
  if (!bytes || !signed) {
    return c.json({ error: { code: 'unauthorized', message: 'Not signed by Slack' } }, 401)
  }

  let envelope: SlackEnvelope
  try {
    envelope = JSON.parse(body) as SlackEnvelope
  } catch {
    return c.json({ error: { code: 'bad_request', message: 'Not JSON' } }, 400)
  }
  if (envelope.type === 'url_verification') {
    return c.json({ challenge: String(envelope.challenge ?? '') })
  }

  const event = envelope.event
  if (
    envelope.type !== 'event_callback' ||
    event?.type !== 'link_shared' ||
    !event.user ||
    c.req.header('x-slack-retry-num')
  ) {
    return c.body(null, 200)
  }

  const links = (event.links ?? []).flatMap(l => (typeof l.url === 'string' ? [l.url] : []))
  try {
    const { unfurls, summary } = await unfurlLinks(deps, slack, event.user, links)
    console.log(JSON.stringify({ level: 'info', msg: 'slack: link_shared', ...summary }))
    if (Object.keys(unfurls).length) {
      const source = event.source
      const target: UnfurlTarget | null =
        event.unfurl_id && (source === 'composer' || source === 'conversations_history')
          ? { unfurlId: event.unfurl_id, source }
          : event.channel && event.message_ts
            ? { channel: event.channel, ts: event.message_ts }
            : null
      if (target) await slack.unfurl(target, unfurls)
    }
  } catch (err) {
    console.error('slack: link_shared', err instanceof Error ? err.message : err)
  }
  return c.body(null, 200)
})
