/**
 * What the notification settings and the admin's mail page show, as plain functions (tested).
 * The matrix is built from the server's settings (its catalogue and the channels that are on), so
 * a new event or channel needs no change here.
 */
import {
  type InstanceMetadata,
  type Me,
  type NotificationPreferencesUpdate,
  type NotificationSettings,
  sectionTitle,
} from '@fling/shared'
import { showsAdmin } from './admin'

export { NOTIFICATION_SETTINGS_PATH } from '@fling/shared'

/** Admin → Mail. */
export const ADMIN_MAIL_PATH = '/admin/mail'

type Capabilities = Pick<InstanceMetadata, 'capabilities'> | null | undefined

/** Whether the account menu offers Notifications: the instance has them on. */
export const showsNotifications = (instance: Capabilities) =>
  instance?.capabilities.notifications === true

/**
 * Whether the settings page lists the mail sent to the person: never while an admin impersonates
 * them (admins never read other people's mail; the API refuses it), nor before `me` is known.
 */
export const showsSentMail = (me: Pick<Me, 'impersonator'> | null | undefined) =>
  me != null && !me.impersonator

/** Whether Admin offers Mail: an admin, in their own session, on an instance that sends email. */
export const showsMailAdmin = (me: Me | null | undefined, instance: Capabilities) =>
  showsAdmin(me) && instance?.capabilities.email === true

type Event = NotificationSettings['events'][number]

/** The events grouped by section, in the server's order. */
export function matrixSections(
  settings: Pick<NotificationSettings, 'events'>
): { section: string; title: string; events: Event[] }[] {
  const out: { section: string; title: string; events: Event[] }[] = []
  for (const event of settings.events) {
    const last = out.at(-1)
    if (last && last.section === event.section) last.events.push(event)
    else out.push({ section: event.section, title: sectionTitle(event.section), events: [event] })
  }
  return out
}

export interface CellState {
  /** the effective value (muted aside) */
  on: boolean
  /** the user chose it, rather than the default */
  own: boolean
  /** the catalogue's default for this event and channel */
  defaultOn: boolean
}

export function cellState(settings: NotificationSettings, event: string, channel: string) {
  const def = settings.events.find(e => e.key === event)?.defaults[channel] ?? 'off'
  const own = settings.overrides[event]?.[channel]
  return {
    on: (own ?? def) === 'on',
    own: own !== undefined,
    defaultOn: def === 'on',
  } satisfies CellState
}

/**
 * The update for switching a cell to `on`: back to the default (null) when that is the default,
 * so "yours" marks only the choices that differ from it.
 */
export function cellUpdate(
  state: Pick<CellState, 'defaultOn'>,
  event: string,
  channel: string,
  on: boolean
): NotificationPreferencesUpdate {
  const value = on === state.defaultOn ? null : on ? 'on' : 'off'
  return { cells: { [event]: { [channel]: value } } } as NotificationPreferencesUpdate
}

/** A channel's column heading: `email` → `Email`. */
export const channelLabel = (channel: string) =>
  channel.charAt(0).toUpperCase() + channel.slice(1).replace(/[_-]+/g, ' ')

/** Event keys as the user reads them: the catalogue's titles, or the key when it is unknown. */
export function eventTitles(settings: Pick<NotificationSettings, 'events'> | undefined) {
  const titles = new Map(settings?.events.map(e => [e.key, e.title]))
  return (keys: readonly string[]) => keys.map(k => titles.get(k) ?? k)
}

/** An hour the drainer counted (`2026-10-28T14`, UTC) as a Date. */
export const hourDate = (hour: string) => new Date(`${hour}:00:00.000Z`)
