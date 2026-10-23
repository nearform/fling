/**
 * One site: its URL, visibility, share link, current version and actions, with the version
 * history behind a disclosure. Archived sites are offline, so they only offer restore and delete.
 */
import type { Site } from '@fling/shared'
import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  NoSymbolIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { Fragment, useState } from 'react'
import { useSiteActions, useSiteDetail } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { displayUrl, formatBytes, fullDate, shortVersion, timeAgo } from '../lib/format'
import { showToast } from '../lib/toast'
import { ConfirmModal } from './ConfirmModal'
import { CopyButton } from './CopyButton'
import { Modal } from './Modal'
import { VersionFiles } from './VersionFiles'

type Dialog = 'refresh-share' | 'revoke-share' | 'archive' | 'delete' | null

export function VisibilityBadge({ visibility }: { visibility: Site['visibility'] }) {
  return visibility === 'public' ? (
    <span className="badge badge-sm tone-info gap-1" title="Anyone with the URL can open it">
      <GlobeAltIcon className="h-3 w-3" /> Public
    </span>
  ) : (
    <span className="badge badge-sm tone-primary gap-1" title="Signed-in Nearformers only">
      <LockClosedIcon className="h-3 w-3" /> Nearformers only
    </span>
  )
}

export function SiteCard({ site }: { site: Site }) {
  const actions = useSiteActions(site.name)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const close = () => setDialog(null)

  const createShare = (rotating: boolean) =>
    actions.share.mutate(undefined, {
      onSuccess: async ({ shareUrl }) => {
        close()
        try {
          await navigator.clipboard.writeText(shareUrl)
          showToast(rotating ? 'New share link copied' : 'Share link created and copied')
        } catch {
          showToast(rotating ? 'Share link refreshed' : 'Share link created')
        }
      },
    })

  return (
    <article className="surface-panel space-y-4">
      {/* Name, badges, actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg leading-tight break-all">{site.name}</h2>
            {site.archived ? (
              <span className="badge badge-sm badge-ghost">Archived</span>
            ) : (
              <VisibilityBadge visibility={site.visibility} />
            )}
            {site.spa && (
              <span className="badge badge-sm badge-ghost" title="Unknown paths serve /index.html">
                SPA
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 min-w-0">
            {site.archived ? (
              <span className="text-sm text-muted truncate">{displayUrl(site.url)}</span>
            ) : (
              <a
                href={site.url}
                target="_blank"
                rel="noreferrer"
                className="link link-hover text-sm truncate inline-flex items-center gap-1"
              >
                {displayUrl(site.url)}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
              </a>
            )}
            <CopyButton text={site.url} label="Copy URL" />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {site.archived ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => actions.unarchive.mutate(undefined)}
              disabled={actions.unarchive.isPending}
            >
              <ArchiveBoxXMarkIcon className="h-4 w-4" />
              Unarchive
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setDialog('archive')}
            >
              <ArchiveBoxArrowDownIcon className="h-4 w-4" />
              Archive
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost text-error"
            onClick={() => setDialog('delete')}
          >
            <TrashIcon className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>

      {!site.archived && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Visibility */}
          <div className="surface-inset p-3 space-y-1">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <span className="text-sm font-medium">Public</span>
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-primary"
                checked={site.visibility === 'public'}
                disabled={actions.setVisibility.isPending}
                onChange={e =>
                  actions.setVisibility.mutate(e.target.checked ? 'public' : 'private')
                }
              />
            </label>
            <p className="text-xs text-muted">
              {site.visibility === 'public'
                ? 'Anyone with the URL can open it.'
                : 'Only signed-in Nearformers can open it.'}
            </p>
          </div>

          {/* Share link */}
          <div className="surface-inset p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Share link</span>
              {site.shareUrl ? (
                <span className="flex gap-0.5">
                  <CopyButton text={site.shareUrl} label="Copy share link" />
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square"
                    title="Refresh the share link"
                    aria-label="Refresh the share link"
                    onClick={() => setDialog('refresh-share')}
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-square text-error"
                    title="Revoke the share link"
                    aria-label="Revoke the share link"
                    onClick={() => setDialog('revoke-share')}
                  >
                    <NoSymbolIcon className="h-4 w-4" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => createShare(false)}
                  disabled={actions.share.isPending}
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  Create
                </button>
              )}
            </div>
            {site.shareUrl ? (
              <a
                href={site.shareUrl}
                target="_blank"
                rel="noreferrer"
                className="link link-hover block truncate font-mono text-xs"
              >
                {displayUrl(site.shareUrl)}
              </a>
            ) : (
              <p className="text-xs text-muted">
                Lets anyone open the site without signing in — for people outside Nearform.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Meta + files / versions disclosures */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-secondary">
        <span>
          Updated <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
          {' · '}
          version <code className="text-xs">{shortVersion(site.currentVersionId)}</code>
        </span>
        <span className="flex gap-1">
          {site.currentVersionId && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              aria-expanded={showFiles}
              onClick={() => setShowFiles(v => !v)}
            >
              Files
              <ChevronDownIcon
                className={`h-3.5 w-3.5 transition-transform ${showFiles ? 'rotate-180' : ''}`}
              />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            aria-expanded={showVersions}
            onClick={() => setShowVersions(v => !v)}
          >
            Versions
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform ${showVersions ? 'rotate-180' : ''}`}
            />
          </button>
        </span>
      </div>
      {showFiles && site.currentVersionId && (
        <VersionFiles
          name={site.name}
          versionId={site.currentVersionId}
          siteUrl={site.archived ? undefined : site.url}
        />
      )}
      {showVersions && <Versions site={site} />}

      <ConfirmModal
        isOpen={dialog === 'refresh-share'}
        title="Refresh the share link?"
        message="You'll get a new link. The old link stops working straight away, so anyone you sent it to will need the new one."
        confirmText="Refresh link"
        confirmButtonClass="btn-warning"
        isLoading={actions.share.isPending}
        onCancel={close}
        onConfirm={() => createShare(true)}
      />
      <ConfirmModal
        isOpen={dialog === 'revoke-share'}
        title="Revoke the share link?"
        message="The link stops working straight away. Nearformers can still open the site if it is private."
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={actions.revokeShare.isPending}
        onCancel={close}
        onConfirm={() => actions.revokeShare.mutate(undefined, { onSettled: close })}
      />
      <ConfirmModal
        isOpen={dialog === 'archive'}
        title={`Archive ${site.name}?`}
        message="The site goes offline (its URL and share link return 404) but its files and versions are kept. Unarchive it any time."
        confirmText="Archive"
        confirmButtonClass="btn-warning"
        isLoading={actions.archive.isPending}
        onCancel={close}
        onConfirm={() => actions.archive.mutate(undefined, { onSettled: close })}
      />
      <DeleteSiteModal
        name={site.name}
        open={dialog === 'delete'}
        busy={actions.remove.isPending}
        onCancel={close}
        onConfirm={() => actions.remove.mutate(undefined, { onSettled: close })}
      />
    </article>
  )
}

function Versions({ site }: { site: Site }) {
  const detail = useSiteDetail(site.name, true)
  const { restoreVersion } = useSiteActions(site.name)
  const [filesOf, setFilesOf] = useState<string | null>(null)

  if (detail.isPending) {
    return (
      <div className="py-3 text-center">
        <span className="loading loading-spinner loading-sm text-muted" />
      </div>
    )
  }
  if (detail.isError) return <p className="text-sm text-error">{errorMessage(detail.error)}</p>
  if (detail.data.versions.length === 0) {
    return <p className="text-sm text-muted">No versions yet.</p>
  }

  return (
    <div className="surface-inset overflow-x-auto">
      <table className="table table-sm">
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
          {detail.data.versions.map(version => {
            const current = version.id === detail.data.currentVersionId
            const open = filesOf === version.id
            return (
              <Fragment key={version.id}>
                <tr>
                  <td>
                    <code className="text-xs" title={version.id}>
                      {shortVersion(version.id)}
                    </code>
                  </td>
                  <td title={fullDate(version.createdAt)}>{timeAgo(version.createdAt)}</td>
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
  )
}

/** Delete for good: the name must be typed to confirm. */
function DeleteSiteModal({
  name,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string
  open: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === name
  const cancel = () => {
    setTyped('')
    onCancel()
  }

  return (
    <Modal
      open={open}
      onClose={cancel}
      title={`Delete ${name}?`}
      closeButton={false}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form={`delete-${name}`}
            className="btn btn-sm btn-error"
            disabled={!matches || busy}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : 'Delete for good'}
          </button>
        </>
      }
    >
      <form
        id={`delete-${name}`}
        className="space-y-3"
        onSubmit={e => {
          e.preventDefault()
          if (matches) onConfirm()
        }}
      >
        <p>
          This removes the site, every version and its share link. The URL stops working and this
          cannot be undone. To keep the files, archive it instead.
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm">
            Type <code className="font-semibold text-base-content">{name}</code> to confirm
          </span>
          <input
            className="input input-sm w-full font-mono"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Site name"
          />
        </label>
      </form>
    </Modal>
  )
}
