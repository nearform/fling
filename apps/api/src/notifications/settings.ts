/**
 * A person's own notification settings, as every client sees them (`GET/PUT /api/me/notifications`,
 * `GET /api/me/notifications/sent`, the MCP tools `fling_notifications` and
 * `fling_notifications_set`): the catalogue this instance has, their effective preferences, and
 * what was sent to them. With no channel on (the `notifications` capability off) none of it
 * exists (404).
 *
 * Preferences are the user's consent, so an admin impersonating them may read but never change
 * them (`account.notifications.change` in policy.ts).
 */
import {
  applyPreferencesUpdate,
  type NotificationPreferencesUpdate,
  type NotificationSettings,
  notificationSettings,
  SENT_NOTIFICATIONS_MAX,
  type SentNotification,
} from '@fling/shared'
import { instanceMetadata, notificationChannels } from '../instance.ts'
import { forbidden, notFound } from '../lib/errors.ts'
import { canInstance, type Principal } from '../policy.ts'
import type { Deps } from '../types.ts'

/** The channels that are on; 404 when there are none. */
export function channelsOn(deps: Pick<Deps, 'config'>) {
  const channels = notificationChannels(deps.config)
  if (channels.length === 0) throw notFound('Notifications are not set up on this instance')
  return channels
}

function settingsOf(
  deps: Pick<Deps, 'config'>,
  prefs: Parameters<typeof notificationSettings>[0]
): NotificationSettings {
  return notificationSettings(prefs, {
    channels: channelsOn(deps),
    capabilities: instanceMetadata(deps.config).capabilities,
  })
}

export async function getNotificationSettings(
  deps: Deps,
  email: string
): Promise<NotificationSettings> {
  channelsOn(deps)
  return settingsOf(deps, await deps.store.getNotificationPreferences(email))
}

/** Change `muted` and any cells (null: back to the default); returns the settings after. */
export async function updateNotificationSettings(
  deps: Deps,
  p: Principal,
  update: NotificationPreferencesUpdate
): Promise<NotificationSettings> {
  channelsOn(deps)
  if (!canInstance(p, 'account.notifications.change')) {
    throw forbidden(
      `Not while impersonating ${p.email}: changing what they hear about`,
      'impersonating'
    )
  }
  const prefs = await deps.store.getNotificationPreferences(p.email)
  const next = applyPreferencesUpdate(prefs, update)
  const saved = await deps.store.putNotificationPreferences(
    p.email,
    next,
    deps.clock.now().toISOString()
  )
  return settingsOf(deps, saved)
}

/** What was sent to `email` in the last 30 days, newest first. */
export async function sentNotifications(deps: Deps, email: string): Promise<SentNotification[]> {
  channelsOn(deps)
  const sent = await deps.store.listSentNotifications(email, SENT_NOTIFICATIONS_MAX)
  return sent.map(s => ({
    id: s.id,
    channel: s.channel,
    eventKeys: s.eventKeys,
    subject: s.subject,
    providerId: s.providerId ?? null,
    sentAt: s.sentAt,
  }))
}
