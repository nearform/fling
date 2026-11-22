/**
 * Admin → Settings (`/admin/settings`; admins only, the API answers 404 to anyone else): the
 * instance's configuration as it runs, read only, in groups. Each key shows its value and whether
 * the deployment set it or it is the default; secrets show only whether they are set. Changing
 * any of it is a deploy, so each group links to the deploy guides. Above them, the route table:
 * how full the store is where it has a limit, and the format the API writes, which an admin
 * chooses here (route-format.ts).
 */
import type { AdminRouteTable, AdminSecret, AdminSetting, RouteFormat } from '@fling/shared'
import { AdminTabs } from '../components/AdminTabs'
import { PageHeader } from '../components/PageHeader'
import { useAdminRouteTable, useAdminSettings, useMe, useSetRouteFormat } from '../hooks/queries'
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

const FORMAT_NAMES: Record<RouteFormat, string> = { json: 'JSON', compact: 'Compact' }

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`

function RouteTablePanel({ data }: { data: AdminRouteTable }) {
  const choose = useSetRouteFormat()
  const other: RouteFormat = data.format === 'json' ? 'compact' : 'json'
  const rewrite = data.rewrite
  const share = data.usage ? data.usage.bytes / data.usage.limitBytes : 0
  return (
    <section id="route-table" className="space-y-3">
      <h2 className="text-base font-semibold">Route table</h2>
      <div className="surface-panel space-y-3 text-sm">
        {data.usage && (
          <div className="space-y-1">
            <p>
              {megabytes(data.usage.bytes)} of {megabytes(data.usage.limitBytes)} used (
              {Math.round(share * 100)}%)
            </p>
            <progress
              className={`progress w-full ${share >= 0.7 ? 'progress-warning' : ''}`}
              value={data.usage.bytes}
              max={data.usage.limitBytes}
            />
          </div>
        )}
        <p>
          Format: <strong>{FORMAT_NAMES[data.format]}</strong>
          {data.setBy && data.setAt && (
            <span className="text-secondary">
              {' '}
              (chosen by {data.setBy}, {new Date(data.setAt).toLocaleString()})
            </span>
          )}
        </p>
        {rewrite &&
          (rewrite.finishedAt ? (
            <p className="text-secondary">
              Every site's routes are in this format ({rewrite.sites} rewritten, finished{' '}
              {new Date(rewrite.finishedAt).toLocaleString()}).
            </p>
          ) : (
            <p className="text-secondary">
              Maintenance is rewriting every site's routes into this format: {rewrite.sites} done so
              far.
            </p>
          ))}
        <p className="text-secondary">
          Compact takes about a third of the space. Releases before 0.16.0 read only JSON: before
          rolling back to one, choose JSON and wait until the rewrite has finished.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={choose.isPending}
          onClick={() => {
            if (window.confirm(`Write ${FORMAT_NAMES[other]} and rewrite every site's routes?`)) {
              choose.mutate(other)
            }
          }}
        >
          Switch to {FORMAT_NAMES[other]}
        </button>
        {choose.isError && <p className="text-error">{errorMessage(choose.error)}</p>}
      </div>
    </section>
  )
}

export default function AdminSettings() {
  const { data: me } = useMe()
  const allowed = showsAdmin(me)
  const settings = useAdminSettings(allowed)
  const routes = useAdminRouteTable(allowed)

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
        <>
          {routes.data && <RouteTablePanel data={routes.data} />}
          {settingGroups(settings.data).map(g => (
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
          ))}
        </>
      )}
    </div>
  )
}
