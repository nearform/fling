/**
 * The site's files and history: the files being served, then every version, newest first, with
 * who published it, its files on demand and a restore (rollback) for any but the current one. An
 * archived site keeps its versions but can't be pointed at another until it is unarchived.
 */
import type { SiteDetail } from '@fling/shared'
import { Fragment, useState } from 'react'
import { useSiteActions } from '../../hooks/queries'
import { formatBytes, fullDate, shortVersion, timeAgo } from '../../lib/format'
import { VersionFiles } from '../VersionFiles'
import { SiteSection } from './SiteSection'

export function SiteVersions({ site }: { site: SiteDetail }) {
  const { restoreVersion } = useSiteActions(site.name)
  const [filesOf, setFilesOf] = useState<string | null>(null)

  return (
    <SiteSection title="Versions" description="Every fling is a version. Restore one to serve it.">
      {site.currentVersionId && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Current files</h3>
          <VersionFiles
            name={site.name}
            versionId={site.currentVersionId}
            siteUrl={site.archived ? undefined : site.url}
          />
        </div>
      )}

      {site.versions.length === 0 ? (
        <p className="text-sm text-muted">No versions yet.</p>
      ) : (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">History</h3>
          <div className="surface-inset overflow-x-auto">
            <table className="table table-xs">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Flung</th>
                  <th>Files</th>
                  <th>Size</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {site.versions.map(version => {
                  const current = version.id === site.currentVersionId
                  const open = filesOf === version.id
                  return (
                    <Fragment key={version.id}>
                      <tr>
                        <td>
                          <code className="text-xs" title={version.id}>
                            {shortVersion(version.id)}
                          </code>
                        </td>
                        <td title={fullDate(version.createdAt)}>
                          {timeAgo(version.createdAt)}
                          {version.publishedBy && (
                            <span className="text-muted"> by {version.publishedBy}</span>
                          )}
                        </td>
                        <td className="tabular-nums">{version.fileCount}</td>
                        <td className="tabular-nums">{formatBytes(version.totalBytes)}</td>
                        <td className="text-right whitespace-nowrap space-x-1">
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            aria-expanded={open}
                            onClick={() => setFilesOf(open ? null : version.id)}
                          >
                            Files
                          </button>
                          {current ? (
                            <span className="badge badge-sm tone-primary">Current</span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={restoreVersion.isPending || site.archived}
                              onClick={() => restoreVersion.mutate(version.id)}
                            >
                              Restore
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} className="p-2">
                            <VersionFiles
                              name={site.name}
                              versionId={version.id}
                              siteUrl={current && !site.archived ? site.url : undefined}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SiteSection>
  )
}
