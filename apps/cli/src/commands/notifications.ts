/**
 * `fling notifications …`: what the Fling tells you about, and how. The events and channels come
 * from the server (its catalogue), so a new event needs no CLI change. `set` changes one event on
 * one channel (`default`: back to the catalogue's), `mute` and `unmute` switch everything, and
 * `sent` lists what was sent to you in the last 30 days. Only on a Fling with the `notifications`
 * capability.
 */
import { type CellChange, type NotificationSettings, sectionTitle } from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { CliError } from '../errors.ts'
import {
  getNotifications,
  listSentNotifications,
  notificationsEnabled,
  setNotifications,
} from '../sites.ts'
import { formatDate, renderTable } from '../utils/output.ts'

const VALUES = ['on', 'off', 'default'] as const

/** The client and the instance's name, unless the stored instance says it has no notifications. */
function notificationsClient(ctx: CommandContext) {
  const instance = ctx.config.instance
  if (instance && !notificationsEnabled(instance)) {
    throw new CliError(`${instance.name} has no notifications`)
  }
  return { client: requireClient(ctx), name: instance?.name ?? 'This Fling' }
}

/** The matrix: one row per event, a column per channel; `*` marks a value you chose. */
export function renderSettings(settings: NotificationSettings): string {
  const marked = (key: string, channel: string) => {
    const value = settings.cells[key]?.[channel] ?? 'off'
    return settings.overrides[key]?.[channel] !== undefined ? `${value}*` : value
  }
  const table = renderTable(settings.events, [
    { header: 'SECTION', value: e => sectionTitle(e.section) },
    { header: 'EVENT', value: e => e.key },
    ...settings.channels.map(channel => ({
      header: channel.toUpperCase(),
      value: (e: { key: string }) => marked(e.key, channel),
    })),
    { header: 'WHEN', value: e => e.title },
  ])
  const lines = [table, '', chalk.dim('* your choice; the rest are the defaults')]
  if (settings.muted) {
    lines.unshift(
      chalk.yellow(
        'Muted: nothing is sent, whatever the table says (`fling notifications unmute` to undo).'
      ),
      ''
    )
  }
  return lines.join('\n')
}

export async function runNotifications(ctx: CommandContext): Promise<void> {
  const { client, name } = notificationsClient(ctx)
  const settings = await getNotifications(client, name)
  ctx.out.data(settings, () => renderSettings(settings))
}

export async function runNotificationsSet(
  ctx: CommandContext,
  event: string,
  channel: string,
  value: string
): Promise<void> {
  const { client, name } = notificationsClient(ctx)
  if (!(VALUES as readonly string[]).includes(value)) {
    throw new CliError(`"${value}" is not on, off or default`)
  }
  // The server's catalogue, not this CLI's: it may know events this version does not.
  const current = await getNotifications(client, name)
  if (!current.events.some(e => e.key === event)) {
    throw new CliError(`${name} has no event "${event}"`, {
      hint: `Events: ${current.events.map(e => e.key).join(', ')}.`,
    })
  }
  if (!current.channels.includes(channel)) {
    throw new CliError(`${name} has no channel "${channel}"`, {
      hint: `Channels: ${current.channels.join(', ')}.`,
    })
  }
  const settings = await setNotifications(
    client,
    { cells: [{ event, channel, value } as CellChange] },
    name
  )
  const now = settings.cells[event]?.[channel] ?? 'off'
  ctx.log.success(
    value === 'default'
      ? `${event} on ${channel} is back to the default (${now})`
      : `${event} on ${channel} is ${now}`
  )
  if (settings.muted) ctx.log.warn('Everything is muted, so nothing is sent until you unmute.')
  ctx.out.data(settings, () => renderSettings(settings))
}

export async function runNotificationsMute(ctx: CommandContext, muted: boolean): Promise<void> {
  const { client, name } = notificationsClient(ctx)
  const settings = await setNotifications(client, { muted }, name)
  ctx.log.success(
    muted ? `Muted: ${name} sends you nothing` : `Unmuted: ${name} sends what the table says`
  )
  if (ctx.json) ctx.out.data(settings, () => '')
}

export async function runNotificationsSent(ctx: CommandContext): Promise<void> {
  const { client, name } = notificationsClient(ctx)
  const sent = await listSentNotifications(client, name)
  ctx.out.data({ sent }, () =>
    sent.length
      ? renderTable(sent, [
          { header: 'SENT', value: s => formatDate(s.sentAt) },
          { header: 'CHANNEL', value: s => s.channel },
          { header: 'SUBJECT', value: s => s.subject },
          { header: 'EVENTS', value: s => s.eventKeys.join(', ') },
        ])
      : chalk.dim('Nothing was sent to you in the last 30 days.')
  )
}
