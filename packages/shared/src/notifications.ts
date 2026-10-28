// Notifications: the event catalogue (what Fling tells people about), the channels it can tell them
// through, and the preferences contract (`GET/PUT /api/me/notifications`). Every client builds its
// settings from the catalogue the server sends, so a new event needs no client change. Templates
// are not here: they render server data and live in the core. Browser-safe (zod only).

import { z } from 'zod'

/** The channels a notification can go out on. `email` is the only one so far. */
export const CHANNEL_IDS = ['email'] as const
export const ChannelIdSchema = z.enum(CHANNEL_IDS)
export type ChannelId = z.infer<typeof ChannelIdSchema>

/** One cell of the preferences: whether this event goes out on this channel. */
export const DeliverySchema = z.enum(['on', 'off'])
export type Delivery = z.infer<typeof DeliverySchema>

/** Every event key, stable forever: stored in preferences and in unsubscribe tokens. */
export const EVENT_KEYS = [
  'site.shared',
  'site.shared_via_group',
  'group.member_added',
  'comment.created',
  'comment.reply',
] as const
export const EventKeySchema = z.enum(EVENT_KEYS)
export type EventKey = z.infer<typeof EventKeySchema>

export type EventSection = 'sharing' | 'groups' | 'comments'

export interface EventDefinition {
  key: EventKey
  /** what the settings page and `fling notifications` call it */
  title: string
  /** one line under the title */
  description: string
  section: EventSection
  /** what a recipient gets until they choose otherwise */
  defaults: Record<ChannelId, Delivery>
  /** after a message about a site, the recipient's next batch for that site waits (the cool-down) */
  coolDown: boolean
  /** only on instances with this capability (e.g. `comments`) */
  capability?: string
}

/** The event catalogue, in the order clients list it. */
export const EVENT_CATALOGUE: readonly EventDefinition[] = [
  {
    key: 'site.shared',
    title: 'Someone shares a site with you',
    description: 'A site owner adds you to who may see their site.',
    section: 'sharing',
    defaults: { email: 'on' },
    coolDown: false,
  },
  {
    key: 'site.shared_via_group',
    title: 'Someone shares a site with a group you are in',
    description: 'A site owner adds one of your groups to who may see their site.',
    section: 'sharing',
    defaults: { email: 'on' },
    coolDown: false,
  },
  {
    key: 'group.member_added',
    title: 'Someone adds you to a group',
    description: "A group's owner adds you to it, opening the sites shared with it to you.",
    section: 'groups',
    defaults: { email: 'on' },
    coolDown: false,
  },
  {
    key: 'comment.created',
    title: 'Someone comments on your site',
    description: 'A new thread is started on a site you own.',
    section: 'comments',
    defaults: { email: 'on' },
    coolDown: true,
    capability: 'comments',
  },
  {
    key: 'comment.reply',
    title: 'Someone replies in your thread',
    description: 'A reply is added to a thread you started or replied in.',
    section: 'comments',
    defaults: { email: 'on' },
    coolDown: true,
    capability: 'comments',
  },
]

const BY_KEY = new Map<string, EventDefinition>(EVENT_CATALOGUE.map(e => [e.key, e]))

export const isEventKey = (value: string): value is EventKey => BY_KEY.has(value)
export const isChannelId = (value: string): value is ChannelId =>
  (CHANNEL_IDS as readonly string[]).includes(value)

/** The catalogue entry for a key. */
export function eventDefinition(key: EventKey): EventDefinition {
  return BY_KEY.get(key) as EventDefinition
}

/** The catalogue entries an instance with these capabilities has. */
export function catalogueFor(capabilities: Record<string, boolean>): EventDefinition[] {
  return EVENT_CATALOGUE.filter(e => !e.capability || capabilities[e.capability] === true)
}

/** A recipient's own choices: only the cells they set. */
export type PreferenceCells = Partial<Record<EventKey, Partial<Record<ChannelId, Delivery>>>>

/** What is stored per recipient (`USER#<email>/NOTIFYPREFS`): `muted` and the overrides. */
export interface NotificationPreferences {
  muted: boolean
  cells: PreferenceCells
}

/** No choices made: the catalogue's defaults apply. */
export const DEFAULT_PREFERENCES: NotificationPreferences = { muted: false, cells: {} }

/**
 * Whether `event` goes out on `channel` for a recipient with these preferences (null: none
 * stored). The first that applies: muted → off; their own cell; the catalogue's default.
 */
export function effectivePreference(
  prefs: NotificationPreferences | null,
  event: EventKey,
  channel: ChannelId
): Delivery {
  if (prefs?.muted) return 'off'
  return prefs?.cells[event]?.[channel] ?? eventDefinition(event).defaults[channel]
}

/**
 * Only the cells for events and channels the catalogue has, with a valid value: what a write
 * keeps, so a cell for an event that has left the catalogue is dropped on the next write.
 */
export function knownCells(cells: unknown): PreferenceCells {
  const out: PreferenceCells = {}
  if (!cells || typeof cells !== 'object') return out
  for (const [event, row] of Object.entries(cells as Record<string, unknown>)) {
    if (!isEventKey(event) || !row || typeof row !== 'object') continue
    const kept: Partial<Record<ChannelId, Delivery>> = {}
    for (const [channel, value] of Object.entries(row as Record<string, unknown>)) {
      if (isChannelId(channel) && DeliverySchema.safeParse(value).success) {
        kept[channel] = value as Delivery
      }
    }
    if (Object.keys(kept).length > 0) out[event] = kept
  }
  return out
}

/**
 * `PUT /api/me/notifications`: change `muted`, and any cells. A cell set to `null` goes back to
 * the catalogue's default. Unknown events or channels are refused.
 */
export const NotificationPreferencesUpdateSchema = z.object({
  muted: z.boolean().optional(),
  cells: z
    .partialRecord(EventKeySchema, z.partialRecord(ChannelIdSchema, DeliverySchema.nullable()))
    .optional(),
})
export type NotificationPreferencesUpdate = z.infer<typeof NotificationPreferencesUpdateSchema>

/** The preferences after an update: cells set to `null` are removed, the rest replaced. */
export function applyPreferencesUpdate(
  prefs: NotificationPreferences | null,
  update: NotificationPreferencesUpdate
): NotificationPreferences {
  const cells: PreferenceCells = structuredClone(knownCells(prefs?.cells))
  for (const [event, row] of Object.entries(update.cells ?? {})) {
    if (!isEventKey(event) || !row) continue
    const next: Partial<Record<ChannelId, Delivery>> = { ...cells[event] }
    for (const [channel, value] of Object.entries(row)) {
      if (!isChannelId(channel)) continue
      if (value === null || value === undefined) delete next[channel]
      else next[channel] = value
    }
    if (Object.keys(next).length > 0) cells[event] = next
    else delete cells[event]
  }
  return { muted: update.muted ?? prefs?.muted ?? false, cells }
}

const EventDefinitionSchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  section: z.string(),
  defaults: z.record(z.string(), DeliverySchema),
  coolDown: z.boolean(),
  capability: z.string().optional(),
})

/**
 * `GET /api/me/notifications` (and the PUT's answer): the channels that are on, the events this
 * instance has, `muted`, and every event × channel cell with its effective value (`cells`) and
 * whether the recipient set it themselves (`overrides`). Loose and keyed by string, so a client
 * shows events and channels it doesn't know yet.
 */
export const NotificationSettingsSchema = z.looseObject({
  channels: z.array(z.string()),
  events: z.array(EventDefinitionSchema),
  muted: z.boolean(),
  cells: z.record(z.string(), z.record(z.string(), DeliverySchema)),
  overrides: z.record(z.string(), z.record(z.string(), DeliverySchema)).default({}),
})
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>

/** The settings response for a recipient, on an instance with these channels and capabilities. */
export function notificationSettings(
  prefs: NotificationPreferences | null,
  instance: { channels: readonly ChannelId[]; capabilities: Record<string, boolean> }
): NotificationSettings {
  const events = catalogueFor(instance.capabilities)
  const cells: Record<string, Record<string, Delivery>> = {}
  const overrides: Record<string, Record<string, Delivery>> = {}
  const own = knownCells(prefs?.cells)
  for (const event of events) {
    cells[event.key] = Object.fromEntries(
      instance.channels.map(channel => [channel, effectivePreference(prefs, event.key, channel)])
    )
    const set = Object.entries(own[event.key] ?? {}).filter(([channel]) =>
      instance.channels.includes(channel as ChannelId)
    )
    if (set.length > 0) overrides[event.key] = Object.fromEntries(set)
  }
  return {
    channels: [...instance.channels],
    events: events.map(e => ({ ...e, defaults: { ...e.defaults } })),
    muted: prefs?.muted ?? false,
    cells,
    overrides,
  }
}

/** Where the web app lets someone choose what they hear about (Settings → Notifications). */
export const NOTIFICATION_SETTINGS_PATH = '/settings/notifications'

/**
 * The page an email's unsubscribe link opens (`?t=<token>`), on the app origin and answered by the
 * API: `GET` shows it, `POST` unsubscribes (the RFC 8058 one-click POST too).
 */
export const UNSUBSCRIBE_PATH = '/notifications/unsubscribe'

/** `GET /api/me/notifications/sent`: one message that went out to the caller, newest first. */
export const SentNotificationSchema = z.looseObject({
  id: z.string(),
  channel: z.string(),
  /** the events it told them about (several when folded) */
  eventKeys: z.array(z.string()),
  subject: z.string(),
  /** the provider's message id, when it gave one */
  providerId: z.string().nullable(),
  sentAt: z.string(),
})
export type SentNotification = z.infer<typeof SentNotificationSchema>
export const SentNotificationListSchema = z.object({ sent: z.array(SentNotificationSchema) })
export type SentNotificationList = z.infer<typeof SentNotificationListSchema>

/** How many sent messages `GET /api/me/notifications/sent` returns (they are kept 30 days). */
export const SENT_NOTIFICATIONS_MAX = 50

/** What the drainer counts per hour, as the admin's mail page shows it. */
export const MAIL_COUNTERS = ['sent', 'retrying', 'givenUp', 'suppressed', 'dropped'] as const
export type MailCounter = (typeof MAIL_COUNTERS)[number]

const MailCountsSchema = z.object({
  sent: z.number(),
  retrying: z.number(),
  givenUp: z.number(),
  suppressed: z.number(),
  dropped: z.number(),
})

/**
 * `GET /api/admin/mail` (admins only, on an instance with the `email` capability): the mail
 * settings, read only, and the last 24 hours of sending. No address but the instance's own
 * sender and reply-to, and no content.
 */
export const MailAdminSchema = z.object({
  config: z.object({
    driver: z.string(),
    from: z.string(),
    fromName: z.string(),
    replyTo: z.string().nullable(),
    configurationSet: z.string().nullable(),
  }),
  health: z.object({
    /** the first hour counted (UTC, `2026-10-28T14`) */
    since: z.string(),
    /** the hours with any activity, oldest first */
    hours: z.array(MailCountsSchema.extend({ hour: z.string() })),
    totals: MailCountsSchema,
    /** the latest failed sends, newest first */
    failures: z.array(
      z.object({
        at: z.string(),
        batchId: z.string(),
        eventKeys: z.array(z.string()),
        reason: z.string(),
        detail: z.string().nullable(),
      })
    ),
  }),
  /** test emails this admin may still send this hour, of `limit` */
  tests: z.object({ remaining: z.number(), limit: z.number() }),
})
export type MailAdmin = z.infer<typeof MailAdminSchema>

/** `POST /api/admin/mail/test`: send a test email to any address. */
export const MailTestRequestSchema = z.object({
  to: z.string().trim().toLowerCase().min(3).max(254),
})
export type MailTestRequest = z.infer<typeof MailTestRequestSchema>

/**
 * Its answer: the provider took it (with its message id, when it gives one), or why not
 * (`error`: the reason and the provider's code in words, e.g. `rejected: sender not verified`).
 */
export const MailTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), providerId: z.string().nullable(), subject: z.string() }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    detail: z.string().nullable(),
    error: z.string(),
  }),
])
export type MailTestResult = z.infer<typeof MailTestResultSchema>

/** Test emails an admin may send per hour. */
export const MAIL_TESTS_PER_HOUR = 10

/** One cell to change, as the CLI and the MCP tools take it: `default` goes back to the catalogue's. */
export const CellChangeSchema = z.object({
  event: EventKeySchema,
  channel: ChannelIdSchema,
  value: z.enum(['on', 'off', 'default']),
})
export type CellChange = z.infer<typeof CellChangeSchema>

/** The `PUT /api/me/notifications` body for `muted` and a list of cell changes. */
export function preferencesUpdateOf(change: {
  muted?: boolean
  cells?: readonly CellChange[]
}): NotificationPreferencesUpdate {
  const cells: NonNullable<NotificationPreferencesUpdate['cells']> = {}
  for (const c of change.cells ?? []) {
    cells[c.event] = { ...cells[c.event], [c.channel]: c.value === 'default' ? null : c.value }
  }
  return {
    ...(change.muted === undefined ? {} : { muted: change.muted }),
    ...(Object.keys(cells).length ? { cells } : {}),
  }
}

const SECTION_TITLES: Record<string, string> = {
  sharing: 'Sharing',
  groups: 'Groups',
  comments: 'Comments',
}

/** A section's heading; an unknown section is shown as its key. */
export const sectionTitle = (section: string) => SECTION_TITLES[section] ?? section

/**
 * The text of a `fling_notifications` result (both servers): muted or not, then each event with
 * its key and, per channel, its effective value (`(yours)` where the user set it).
 */
export function describeNotificationSettings(settings: NotificationSettings): string {
  const lines = [
    settings.muted
      ? 'All notifications are muted: nothing is sent, whatever the settings below say.'
      : `Notifications are on. Channels: ${settings.channels.join(', ')}.`,
  ]
  let section = ''
  for (const e of settings.events) {
    if (e.section !== section) {
      section = e.section
      lines.push('', `${sectionTitle(section)}:`)
    }
    const cells = settings.channels.map(ch => {
      const value = settings.cells[e.key]?.[ch] ?? 'off'
      const own = settings.overrides[e.key]?.[ch] !== undefined
      return `${ch} ${value}${own ? ' (yours)' : ''}`
    })
    lines.push(`- ${e.key}: ${e.title} — ${cells.join(', ')}`)
  }
  return lines.join('\n')
}

/** The text of what was sent to someone (`fling notifications sent`). */
export function describeSentNotifications(sent: readonly SentNotification[]): string {
  if (sent.length === 0) return 'Nothing was sent to you in the last 30 days.'
  return [
    `${sent.length} message(s) sent to you in the last 30 days, newest first:`,
    ...sent.map(
      s =>
        `- ${s.sentAt} ${s.channel}: ${s.subject} (${s.eventKeys.join(', ')})` +
        (s.providerId ? ` [${s.providerId}]` : '')
    ),
  ].join('\n')
}
