/**
 * A Path's files and history, as the site's Versions section shows the site's: the files being
 * served, then every version of the Path, newest first, with who published it, its files on
 * demand and a restore for any but the current one, which serves it at the Path alone. Restoring
 * is for whoever publishes to the Path (`canRestore`); an archived Path waits to be unarchived.
 */
import type { PathDetail } from '@fling/shared'
import { Fragment, useState } from 'react'
import { usePathActions } from '../../hooks/queries'
import { formatBytes, fullDate, shortVersion, timeAgo } from '../../lib/format'
import { VersionFiles } from '../VersionFiles'
import { SiteSection } from './SiteSection'

export function PathVersions({
  name,
  served,
  path,
  canRestore,
}: {
  name: string
  /** the site is served (not archived): the current version's files link to the Path's URL */
  served: boolean
  path: PathDetail
  canRestore: boolean
}) {
  const { restoreVersion } = usePathActions(name, path.folder)
  const [filesOf, setFilesOf] = useState<string | null>(null)
  const servedUrl = served && !path.archived ? path.url : undefined

  return (
    <SiteSection
      title="Versions"
      description="Every fling to this Path is a version. Restore one to serve it here; the rest of the site stays as it is."
    >
      {path.currentVersionId && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Current files</h3>
          <VersionFiles
            name={name}
            versionId={path.currentVersionId}
            folder={path.folder}
            siteUrl={servedUrl}
          />
        </div>
      )}

      {path.versions.length === 0 ? (
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
                {path.versions.map(version => {
                  const current = version.id === path.currentVersionId
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
                        <td className="text-end whitespace-nowrap space-x-1">
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
                            canRestore && (
                              <button
                                type="button"
                                className="btn btn-xs"
                                disabled={restoreVersion.isPending || path.archived}
                                onClick={() => restoreVersion.mutate(version.id)}
                              >
                                Restore
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} className="p-2">
                            <VersionFiles
                              name={name}
                              versionId={version.id}
                              folder={path.folder}
                              siteUrl={current ? servedUrl : undefined}
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
