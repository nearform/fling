/**
 * The site page's Logs panel (`servers` capability), for the site's owners and publishers and for
 * admins (`site.logs`): the server's last hour, oldest first. A request line is one Fling wrote
 * for a request it passed the server (method, path, status, time to answer, the viewer id); an
 * output line is something the server printed. Each line names its version. People appear as
 * viewer ids, never emails; an admin can resolve one (audited as `viewer.resolved`).
 *
 * Refresh asks once; Follow asks every 2 s and keeps the newest line in view.
 */
import type { ServerLogLine } from '@fling/shared'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef, useState } from 'react'
import { useResolveViewer, useServerLogs } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { shortVersion } from '../../lib/format'
import { logTime } from '../../lib/servers'
import { SiteSection } from './SiteSection'

export function SiteLogs({
  name,
  currentVersionId,
  admin,
}: {
  name: string
  currentVersionId: string | null
  /** an admin: viewer ids can be resolved */
  admin: boolean
}) {
  const [follow, setFollow] = useState(false)
  const logs = useServerLogs(name, true, follow)
  const resolve = useResolveViewer(name)
  const [resolved, setResolved] = useState<Record<string, string | null>>({})
  const box = useRef<HTMLDivElement>(null)
  const lines = logs.data ?? []

  // While following, keep the newest line in view.
  const count = lines.length
  useEffect(() => {
    if (follow && count > 0 && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [follow, count])

  const whoIs = (id: string) =>
    resolve.mutate(id, { onSuccess: found => setResolved(r => ({ ...r, [id]: found.email })) })

  return (
    <SiteSection
      title="Logs"
      description="The server’s last hour: every request Fling passed it, and what it printed. People appear as viewer ids, the same for one person on this site and different on every other."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => logs.refetch()}
          disabled={logs.isFetching}
        >
          <ArrowPathIcon
            className={`h-4 w-4 ${logs.isFetching ? 'animate-spin' : ''}`}
            aria-hidden
          />
          Refresh
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="toggle toggle-sm"
            checked={follow}
            onChange={e => setFollow(e.target.checked)}
          />
          Follow
        </label>
        <span className="text-xs text-muted tabular-nums" aria-live="polite">
          {logs.data && `${count} line${count === 1 ? '' : 's'}`}
        </span>
      </div>

      {logs.isError ? (
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(logs.error)}
        </div>
      ) : logs.isPending ? (
        <p className="text-sm text-muted">Loading the log…</p>
      ) : count === 0 ? (
        <p className="text-sm text-muted">Nothing in the last hour.</p>
      ) : (
        <div
          ref={box}
          className="surface-inset max-h-96 overflow-auto font-mono text-xs"
          role="log"
          aria-label="Server log"
        >
          <table className="table table-xs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Version</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={`${line.at}-${i}`} className="align-top">
                  <td className="whitespace-nowrap text-muted" title={line.at}>
                    {logTime(line.at)}
                  </td>
                  <td className="whitespace-nowrap">
                    <span
                      className={line.versionId === currentVersionId ? '' : 'text-muted'}
                      title={`Version ${line.versionId}${line.versionId === currentVersionId ? ' (current)' : ''}`}
                    >
                      {shortVersion(line.versionId)}
                    </span>
                  </td>
                  <td className="min-w-0">
                    {line.kind === 'request' ? (
                      <RequestLine
                        line={line}
                        admin={admin}
                        resolved={resolved}
                        resolving={resolve.isPending ? resolve.variables : undefined}
                        onResolve={whoIs}
                      />
                    ) : (
                      <span
                        className={`whitespace-pre-wrap break-all ${line.level === 'error' ? 'text-error' : ''}`}
                      >
                        {line.text}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SiteSection>
  )
}

function RequestLine({
  line,
  admin,
  resolved,
  resolving,
  onResolve,
}: {
  line: ServerLogLine
  admin: boolean
  resolved: Record<string, string | null>
  resolving: string | undefined
  onResolve: (id: string) => void
}) {
  const status = line.status ?? 0
  const viewer = line.viewer ?? null
  return (
    <span className="flex flex-wrap items-baseline gap-x-3">
      <span className="break-all">
        <span className="font-semibold">{line.method}</span> {line.path}
      </span>
      <span className={status >= 500 ? 'text-error' : status >= 400 ? 'text-warning' : ''}>
        {status}
      </span>
      <span className="text-muted tabular-nums">{Math.round(line.ms ?? 0)} ms</span>
      {viewer === null ? (
        <span className="text-muted" title="No viewer: a public site or a share link">
          no viewer
        </span>
      ) : viewer in resolved ? (
        <span>
          {viewer}{' '}
          <span className="text-secondary">
            ({resolved[viewer] ?? 'no member of this Fling now'})
          </span>
        </span>
      ) : admin ? (
        <button
          type="button"
          className="link link-hover"
          title="Show whose viewer id this is (recorded in the audit log)"
          disabled={resolving === viewer}
          onClick={() => onResolve(viewer)}
        >
          {viewer}
        </button>
      ) : (
        <span>{viewer}</span>
      )}
    </span>
  )
}
