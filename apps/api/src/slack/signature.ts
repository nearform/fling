/**
 * Slack's request signature (https://api.slack.com/authentication/verifying-requests-from-slack):
 * `X-Slack-Signature: v0=<hex HMAC-SHA256 of "v0:<timestamp>:<raw body>">` with the app's signing
 * secret, and `X-Slack-Request-Timestamp` within five minutes of now, so a captured request can't
 * be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far a request's timestamp may be from now, in seconds. */
export const SLACK_TIMESTAMP_WINDOW_SECONDS = 5 * 60

export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

/** Whether the request is Slack's: the signature matches and the timestamp is recent. */
export function verifySlackRequest(
  secret: string,
  req: { timestamp: string | undefined; signature: string | undefined; body: string },
  nowSeconds: number
): boolean {
  const { timestamp, signature, body } = req
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_TIMESTAMP_WINDOW_SECONDS) return false
  const expected = Buffer.from(slackSignature(secret, timestamp, body))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
