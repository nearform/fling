/**
 * Settings → Notifications (`/settings/notifications`, where every email's footer links): what the
 * instance tells you about, as a matrix built from the server's catalogue (a section per group of
 * events, a row per event, a column per channel that is on), a switch that mutes everything, and
 * what was sent to you in the last 30 days. Only on an instance with the `notifications`
 * capability. While an admin impersonates you, it is read only (your preferences are your consent)
 * and leaves out what was sent to you (admins never read other people's mail).
 */
import type { NotificationSettings } from '@fling/shared'
import { BellSlashIcon, EnvelopeIcon } from '@heroicons/react/24/outline'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import {
  useMe,
  useNotificationSettings,
  useSentNotifications,
  useUpdateNotifications,
} from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'
import {
  cellState,
  cellUpdate,
  channelLabel,
  eventTitles,
  matrixSections,
  showsNotifications,
  showsSentMail,
} from '../lib/notifications'

function Loading() {
  return (
    <div className="p-6 text-center">
      <span
        className="loading loading-spinner loading-sm text-muted"
        role="status"
        aria-label="Loading"
      />
    </div>
  )
}

function Matrix({ settings, readOnly }: { settings: NotificationSettings; readOnly: boolean }) {
  const update = useUpdateNotifications()
  const disabled = readOnly || update.isPending
  return (
    <div className="surface-panel !p-0 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Tell me when</th>
            {settings.channels.map(channel => (
              <th key={channel} className="w-24 text-center">
                {channelLabel(channel)}
              </th>
            ))}
          </tr>
        </thead>
        {matrixSections(settings).map(section => (
          <tbody key={section.section}>
            <tr>
              <th
                colSpan={settings.channels.length + 1}
                scope="rowgroup"
                className="pbs-5 text-xs font-semibold uppercase tracking-wide text-muted"
              >
                {section.title}
              </th>
            </tr>
            {section.events.map(event => (
              <tr key={event.key} className={settings.muted ? 'opacity-60' : undefined}>
                <td className="min-w-0">
                  <div className="font-medium">{event.title}</div>
                  <div className="text-xs text-secondary">{event.description}</div>
                </td>
                {settings.channels.map(channel => {
                  const state = cellState(settings, event.key, channel)
                  return (
                    <td key={channel} className="text-center">
                      <div className="inline-flex flex-col items-center gap-1">
                        <input
                          type="checkbox"
                          className="toggle toggle-sm toggle-primary"
                          checked={state.on}
                          disabled={disabled}
                          aria-label={`${channelLabel(channel)}: ${event.title}`}
                          onChange={e =>
                            update.mutate(cellUpdate(state, event.key, channel, e.target.checked))
                          }
                        />
                        {state.own && (
                          <span
                            className="text-xs text-muted"
                            title={`The default is ${state.defaultOn ? 'on' : 'off'}`}
                          >
                            Your choice
                          </span>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function MuteSwitch({ settings, readOnly }: { settings: NotificationSettings; readOnly: boolean }) {
  const update = useUpdateNotifications()
  return (
    <div className="surface-panel">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">Mute everything</span>
          <span className="block text-xs text-secondary">
            {settings.muted
              ? 'Nothing is sent to you. Your choices below are kept for when you unmute.'
              : 'Stop every notification at once, keeping your choices below.'}
          </span>
        </span>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={settings.muted}
          disabled={readOnly || update.isPending}
          onChange={e => update.mutate({ muted: e.target.checked })}
        />
      </label>
    </div>
  )
}

function Sent({ settings }: { settings: NotificationSettings | undefined }) {
  const sent = useSentNotifications(true)
  const titles = eventTitles(settings)
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">What was sent to you</h2>
        <p className="text-sm text-secondary">The last 30 days, newest first.</p>
      </div>
      <div className="surface-panel !p-0 overflow-clip">
        {sent.isPending ? (
          <Loading />
        ) : sent.isError ? (
          <div className="p-6 text-sm text-error">{errorMessage(sent.error)}</div>
        ) : sent.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-secondary">
            <EnvelopeIcon className="mx-auto mbe-2 size-6 text-muted" />
            Nothing was sent to you in the last 30 days.
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--border-subtle)]">
            {sent.data.map(s => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 break-words font-medium">{s.subject}</span>
                <span className="text-xs text-secondary">
                  {channelLabel(s.channel)} · {titles(s.eventKeys).join(', ')} ·{' '}
                  <span title={fullDate(s.sentAt)}>{timeAgo(s.sentAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

export default function Notifications() {
  const instance = useInstance()
  const { data: me } = useMe()
  const on = showsNotifications(instance)
  const settings = useNotificationSettings(on)
  const readOnly = Boolean(me?.impersonator)

  if (!on) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        <BellSlashIcon className="mx-auto mbe-2 size-6 text-muted" />
        {instance ? `${instance.name} sends no notifications.` : 'Loading…'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        title="Notifications"
        description={`What ${instance?.name ?? 'Fling'} tells you about, and how. Anything you have not chosen follows the default.`}
      />
      {readOnly && (
        <div role="note" className="alert alert-warning text-sm">
          You are viewing as {me?.email}. Their notification settings can't be changed while you
          impersonate them.
        </div>
      )}
      {settings.isPending ? (
        <div className="surface-panel !p-0">
          <Loading />
        </div>
      ) : settings.isError ? (
        <div className="surface-panel text-sm text-error">{errorMessage(settings.error)}</div>
      ) : (
        <section className="space-y-3">
          <MuteSwitch settings={settings.data} readOnly={readOnly} />
          <Matrix settings={settings.data} readOnly={readOnly} />
        </section>
      )}
      {showsSentMail(me) ? (
        <Sent settings={settings.data} />
      ) : (
        me && (
          <p className="text-sm text-secondary">
            What was sent to {me.email} is not shown while you impersonate them.
          </p>
        )
      )}
    </div>
  )
}
