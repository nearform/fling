/**
 * The site page's Server section (`servers` capability), while the current version has a site
 * server: that it answers `/api/*` on the site's address, whether it can reach the internet
 * (`serversEgress`), the limits it runs with (those an admin raised marked), how many requests it
 * had in the last hour (from its log, for those who may read it), and whether an admin stopped it.
 *
 * Admins also get the kill switch (stop, which makes `/api/*` answer 503, and start) and the
 * site's limits, through PUT /api/admin/sites/:name/server; both are on the audit log.
 */
import type { SiteDetail, SiteServer as SiteServerState } from '@fling/shared'
import {
  AdjustmentsHorizontalIcon,
  ExclamationTriangleIcon,
  PlayIcon,
  StopIcon,
} from '@heroicons/react/24/outline'
import { type ReactNode, useId, useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useAdminServer, useServerLogs } from '../../hooks/queries'
import { LIMITS, type LimitKey, parseLimit, requestCounts } from '../../lib/servers'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../Modal'
import { SiteSection } from './SiteSection'

export function SiteServer({
  site,
  server,
  logs,
  admin,
}: {
  site: SiteDetail
  server: SiteServerState
  /** the caller may read the server's log (`site.logs`): the request counts come from it */
  logs: boolean
  /** an admin: the kill switch and the limits */
  admin: boolean
}) {
  const instance = useInstance()
  const egress = instance?.capabilities.serversEgress === true
  const log = useServerLogs(site.name, logs && !site.archived)
  const counts = log.data ? requestCounts(log.data) : null
  const setServer = useAdminServer(site.name)
  const [dialog, setDialog] = useState<'stop' | 'limits' | null>(null)
  const close = () => setDialog(null)

  return (
    <SiteSection
      title="Server"
      description="This site runs its own server: Fling passes it every request to /api/* on the site’s address, after the same sign-in checks as the pages."
    >
      {server.stopped && (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <ExclamationTriangleIcon className="size-5" aria-hidden="true" />
          <span>
            Stopped by an admin: /api/* answers 503 until it is started again. The pages are still
            served.
          </span>
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <Row label="Answers">
          <code className="text-xs">{`${site.url.replace(/\/$/, '')}/api/*`}</code>
        </Row>
        <Row label="Outbound network">
          {egress
            ? 'Open: it can call other services on the internet'
            : 'None: it can’t call other services'}
        </Row>
        {logs && !site.archived && (
          <Row label="Last hour">
            {counts ? (
              <span className="tabular-nums">
                {counts.requests} request{counts.requests === 1 ? '' : 's'}
                {counts.errors > 0 && (
                  <span className="text-error">
                    , {counts.errors} server error{counts.errors === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted">{log.isError ? 'Not available' : 'Counting…'}</span>
            )}
          </Row>
        )}
      </dl>

      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">Limits</h3>
        <div className="surface-inset w-fit max-w-full overflow-x-auto">
          <table className="table table-xs w-auto">
            <tbody>
              {LIMITS.map(limit => (
                <tr key={limit.key}>
                  <td className="text-secondary">
                    {limit.label}
                    {limit.note && <span className="text-muted"> ({limit.note})</span>}
                  </td>
                  <td className="tabular-nums">
                    {limit.format(server.limits[limit.key])}
                    {server.raised[limit.key] !== undefined && (
                      <span className="badge badge-xs badge-ghost ml-2">Set by an admin</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!admin && <p className="text-xs text-muted">Only an admin can change these.</p>}
      </div>

      {admin && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] pt-3">
          <p className="min-w-0 text-sm text-secondary">
            As an admin you can stop this server or change its limits. Both are recorded in the
            audit log.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" onClick={() => setDialog('limits')}>
              <AdjustmentsHorizontalIcon className="h-4 w-4" aria-hidden />
              Limits…
            </button>
            {server.stopped ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={setServer.isPending}
                onClick={() => setServer.mutate({ stopped: false })}
              >
                <PlayIcon className="h-4 w-4" aria-hidden />
                Start
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-outline btn-error"
                onClick={() => setDialog('stop')}
              >
                <StopIcon className="h-4 w-4" aria-hidden />
                Stop…
              </button>
            )}
          </div>
        </div>
      )}

      {admin && (
        <>
          <ConfirmModal
            isOpen={dialog === 'stop'}
            title={`Stop ${site.name}’s server?`}
            message="Every request to /api/* answers 503 until an admin starts it again. The pages are still served, and its owners can’t start it themselves."
            confirmText="Stop the server"
            confirmButtonClass="btn-error"
            isLoading={setServer.isPending}
            onCancel={close}
            onConfirm={() => setServer.mutate({ stopped: true }, { onSettled: close })}
          />
          <LimitsModal
            open={dialog === 'limits'}
            server={server}
            busy={setServer.isPending}
            onCancel={close}
            onSave={limits => setServer.mutate({ limits }, { onSuccess: close })}
          />
        </>
      )}
    </SiteSection>
  )
}

/**
 * An admin's limits for one site: each field holds the site's own value, blank for the
 * instance's (shown as the placeholder). Saving sends every field: blank puts it back.
 */
function LimitsModal({
  open,
  server,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean
  server: SiteServerState
  busy: boolean
  onCancel: () => void
  onSave: (limits: Record<LimitKey, number | null>) => void
}) {
  const id = useId()
  const initial = () =>
    Object.fromEntries(LIMITS.map(l => [l.key, String(server.raised[l.key] ?? '')])) as Record<
      LimitKey,
      string
    >
  const [values, setValues] = useState(initial)
  const [shownFor, setShownFor] = useState(open)
  // Start from the site's values each time the dialog opens.
  if (open !== shownFor) {
    setShownFor(open)
    if (open) setValues(initial())
  }
  const parsed = LIMITS.map(l => [l.key, parseLimit(values[l.key])] as const)
  const invalid = parsed.filter(([, v]) => v === undefined).map(([k]) => k)
  /** what the instance gives when the site sets none: the limit now, unless it's the site's own */
  const instanceValue = (key: LimitKey) =>
    server.raised[key] === undefined ? String(server.limits[key]) : 'the instance’s'

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Server limits for this site"
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form={id}
            className="btn btn-sm btn-primary"
            disabled={busy || invalid.length > 0}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : 'Save limits'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="space-y-3"
        onSubmit={e => {
          e.preventDefault()
          if (invalid.length > 0) return
          onSave(Object.fromEntries(parsed) as Record<LimitKey, number | null>)
        }}
      >
        <p className="text-sm text-secondary">
          Leave a field blank to use the instance’s limit. The server runs with the new limits
          straight away.
        </p>
        {LIMITS.map(limit => (
          <label key={limit.key} className="block space-y-1">
            <span className="text-sm">
              {limit.label} <span className="text-muted">({limit.unit})</span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              className={`input input-sm w-full ${invalid.includes(limit.key) ? 'input-error' : ''}`}
              placeholder={instanceValue(limit.key)}
              value={values[limit.key]}
              onChange={e => setValues({ ...values, [limit.key]: e.target.value })}
            />
          </label>
        ))}
        {invalid.length > 0 && (
          <p className="text-xs text-error" role="alert">
            A limit is a whole number above zero, or blank.
          </p>
        )}
      </form>
    </Modal>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-secondary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}
