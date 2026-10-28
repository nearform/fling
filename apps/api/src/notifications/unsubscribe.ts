/**
 * Unsubscribing without signing in (design §4.2). Every email links to
 * `/notifications/unsubscribe?t=<token>` and names the same URL in `List-Unsubscribe`.
 *
 * The token is HMAC-signed with SESSION_SECRET, domain-separated (`fling-unsubscribe:`, as live.ts
 * separates its tickets), and names the address, the event and the channel. It does not expire and
 * cannot be revoked: the most a leaked link can do is turn email off for one address, which the
 * page lets them undo.
 *
 * `GET` only shows a page; `POST` changes the preferences, so mail scanners that follow links
 * unsubscribe nobody. The mail client's one-click `POST` (RFC 8058) turns the event's cell off;
 * the page's buttons do that or mute everything, and Undo reverts either. Any token that does not
 * verify gets the same neutral page.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  applyPreferencesUpdate,
  type ChannelId,
  type EventKey,
  isChannelId,
  isEventKey,
  UNSUBSCRIBE_PATH,
} from '@fling/shared'
import type { Deps } from '../types.ts'

/** What a token names: whose email about which event on which channel. */
export interface UnsubscribeTarget {
  email: string
  event: EventKey
  channel: ChannelId
}

interface TokenPayload {
  e: string
  k: string
  c: string
}

const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`fling-unsubscribe:${body}`).digest('base64url')

export function signUnsubscribeToken(secret: string, target: UnsubscribeTarget): string {
  const payload: TokenPayload = { e: target.email, k: target.event, c: target.channel }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/** The target a token names, or null when it is malformed or not ours. */
export function verifyUnsubscribeToken(
  secret: string,
  token: string | null | undefined
): UnsubscribeTarget | null {
  if (!token || token.length > 2048) return null
  const [body, mac, ...rest] = token.split('.')
  if (!body || !mac || rest.length) return null
  const want = Buffer.from(sign(secret, body))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let p: Partial<TokenPayload>
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof p.e !== 'string' || typeof p.k !== 'string' || typeof p.c !== 'string') return null
  if (!isEventKey(p.k) || !isChannelId(p.c)) return null
  return { email: p.e, event: p.k, channel: p.c }
}

/** The unsubscribe link for one address, event and channel. */
export function unsubscribeUrl(
  config: Pick<Deps['config'], 'appOrigin' | 'secrets'>,
  target: UnsubscribeTarget
): string {
  const token = signUnsubscribeToken(config.secrets.sessionSecret, target)
  return `${config.appOrigin}${UNSUBSCRIBE_PATH}?t=${token}`
}

/** What a POST does: stop this event (or, `all`, every email), or undo that. */
export interface UnsubscribeChange {
  scope: 'event' | 'all'
  undo: boolean
}

/** Apply a change to the target's preferences. */
export async function applyUnsubscribe(
  deps: Deps,
  target: UnsubscribeTarget,
  change: UnsubscribeChange
): Promise<void> {
  const prefs = await deps.store.getNotificationPreferences(target.email)
  const next =
    change.scope === 'all'
      ? applyPreferencesUpdate(prefs, { muted: !change.undo })
      : applyPreferencesUpdate(prefs, {
          cells: { [target.event]: { [target.channel]: change.undo ? null : 'off' } },
        })
  await deps.store.putNotificationPreferences(target.email, next, deps.clock.now().toISOString())
}
