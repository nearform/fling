/**
 * Admin → Settings (`/admin/settings`; admins only, the API answers 404 to anyone else): the
 * instance's configuration as it runs, read only, in groups. Each key shows its value and whether
 * the deployment set it or it is the default; secrets show only whether they are set. Changing
 * any of it is a deploy, so each group links to the deploy guides.
 */
import type { AdminSecret, AdminSetting } from '@fling/shared'
import { AdminTabs } from '../components/AdminTabs'
import { PageHeader } from '../components/PageHeader'
import { useAdminSettings, useMe } from '../hooks/queries'
import { settingGroups, settingText, showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'

function SettingRow({ setting }: { setting: AdminSetting }) {
  const text = settingText(setting.value)
  return (
    <tr>
      <td className="font-mono text-xs whitespace-nowrap align-top">{setting.key}</td>
      <td className="min-w-0 break-words">{text ?? <span className="text-muted">Not set</span>}</td>
      <td className="text-right align-top">
        {setting.set ? (
          <span className="badge badge-sm badge-soft">set</span>
        ) : (
          <span className="badge badge-sm badge-ghost text-muted">default</span>
        )}
      </td>
    </tr>
  )
}

function SecretRow({ secret }: { secret: AdminSecret }) {
  return (
    <tr>
      <td className="font-mono text-xs whitespace-nowrap">{secret.name}</td>
      <td className="text-secondary">Secret: value never shown</td>
      <td className="text-right">
        {secret.set ? (
          <span className="badge badge-sm badge-soft">set</span>
        ) : (
          <span className="badge badge-sm badge-ghost text-muted">not set</span>
        )}
      </td>
    </tr>
  )
}

export default function AdminSettings() {
  const { data: me } = useMe()
  const allowed = showsAdmin(me)
  const settings = useAdminSettings(allowed)

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <AdminTabs />
        <PageHeader
          title="Settings"
          description="How this instance is configured, read only. Values come from its deployment; change them there and redeploy."
        />
      </div>
      {settings.isPending ? (
        <div className="surface-panel text-center">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading"
          />
        </div>
      ) : settings.isError ? (
        <div className="surface-panel text-sm text-error">{errorMessage(settings.error)}</div>
      ) : (
        settingGroups(settings.data).map(g => (
          <section key={g.group} id={g.group} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <h2 className="text-base font-semibold">{g.title}</h2>
              <p className="text-xs text-secondary">
                Deploy guide:{' '}
                <a className="link" href={g.aws} target="_blank" rel="noreferrer">
                  AWS
                </a>
                {' · '}
                <a className="link" href={g.cloudflare} target="_blank" rel="noreferrer">
                  Cloudflare
                </a>
              </p>
            </div>
            <div className="surface-panel !p-0 overflow-x-auto">
              <table className="table table-sm">
                <tbody>
                  {g.settings.map(s => (
                    <SettingRow key={s.key} setting={s} />
                  ))}
                  {g.secrets.map(s => (
                    <SecretRow key={s.name} secret={s} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  )
}
