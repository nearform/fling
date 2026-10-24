/**
 * One site, compact: name, visibility and URL on the first line, when it was updated and the
 * disclosures on the second, and the less-used actions behind a "more" menu. Visibility and the
 * share link (Sharing), the current files and the version history fold away until asked for.
 * Archived sites are offline, so they only offer restore and delete.
 */
import type { Site } from '@fling/shared'
import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  EllipsisVerticalIcon,
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  NoSymbolIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useSiteActions, useSiteDetail } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { displayUrl, formatBytes, fullDate, shortVersion, timeAgo } from '../lib/format'
import { audienceFor, DEFAULT_INSTANCE_NAME } from '../lib/instance'
import { reviewHref } from '../lib/review'
import { showToast } from '../lib/toast'
import { ConfirmModal } from './ConfirmModal'
import { CopyButton } from './CopyButton'
import { Modal } from './Modal'
import { VersionFiles } from './VersionFiles'

type Dialog = 'refresh-share' | 'revoke-share' | 'archive' | 'delete' | null
type Panel = 'sharing' | 'files' | 'versions'

export function VisibilityBadge({ visibility }: { visibility: Site['visibility'] }) {
  const audience = audienceFor(useInstance())
  return visibility === 'public' ? (
    <span className="badge badge-sm tone-info gap-1" title="Anyone with the URL can open it">
      <GlobeAltIcon className="h-3 w-3" /> Public
    </span>
  ) : (
    <span className="badge badge-sm tone-primary gap-1" title={`Private: open to ${audience}`}>
      <LockClosedIcon className="h-3 w-3" /> Sign-in required
    </span>
  )
}

export function SiteCard({ site }: { site: Site }) {
  const instance = useInstance()
  const actions = useSiteActions(site.name)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [open, setOpen] = useState<Record<Panel, boolean>>({
    sharing: false,
    files: false,
    versions: false,
  })
  const id = useId()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const close = () => setDialog(null)
  const toggle = (panel: Panel) => setOpen(o => ({ ...o, [panel]: !o[panel] }))

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

  const copyShare = async (shareUrl: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      showToast('Share link copied')
    } catch {
      showToast('Could not copy — open Sharing and copy the link by hand', 'warning')
    }
  }

  /** For people to comment: anyone signed in who can open the site. */
  const copyReviewLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${reviewHref(site.name)}`)
      showToast('Review link copied — anyone who can open the site can comment')
    } catch {
      showToast('Could not copy the review link', 'warning')
    }
  }

  const disclosure = (panel: Panel, label: string) => (
    <button
      type="button"
      className="btn btn-ghost btn-xs h-6 min-h-6 gap-0.5 px-1.5 font-normal"
      aria-expanded={open[panel]}
      aria-controls={`${id}-${panel}`}
      onClick={() => toggle(panel)}
    >
      {label}
      <ChevronDownIcon
        className={`h-3 w-3 transition-transform ${open[panel] ? 'rotate-180' : ''}`}
        aria-hidden
      />
    </button>
  )

  return (
    <article className="surface-panel px-4 py-2.5">
      <div className="flex items-start gap-2">
        {/* Line 1: name, badges, URL */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h2 className="text-base font-medium leading-tight break-all">{site.name}</h2>
          {site.archived ? (
            <span className="badge badge-sm badge-ghost">Archived</span>
          ) : (
            <VisibilityBadge visibility={site.visibility} />
          )}
          {site.shareUrl && !site.archived && (
            <span className="badge badge-sm badge-ghost gap-1" title="Has a share link">
              <LinkIcon className="h-3 w-3" aria-hidden />
              Shared
            </span>
          )}
          {site.spa && (
            <span className="badge badge-sm badge-ghost" title="Unknown paths serve /index.html">
              SPA
            </span>
          )}
          <span className="flex min-w-0 max-w-full items-center">
            {site.archived ? (
              <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
            ) : (
              <a
                href={site.url}
                target="_blank"
                rel="noreferrer"
                className="link link-hover inline-flex min-w-0 items-center gap-1 text-sm"
              >
                <span className="truncate">{displayUrl(site.url)}</span>
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <CopyButton
              text={site.url}
              label={`Copy the URL of ${site.name}`}
              className="btn btn-ghost btn-xs btn-square h-6 min-h-6 w-6 shrink-0"
            />
          </span>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          {reviewable && (
            <Link
              to={reviewHref(site.name)}
              className="btn btn-ghost btn-xs h-6 min-h-6 gap-1 px-1.5 font-normal"
              title="Open the site with its comments"
            >
              <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden />
              Review
            </Link>
          )}
          {site.archived && (
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => actions.unarchive.mutate(undefined)}
              disabled={actions.unarchive.isPending}
            >
              <ArchiveBoxXMarkIcon className="h-3.5 w-3.5" aria-hidden />
              Unarchive
            </button>
          )}
          <ActionsMenu label={`More actions for ${site.name}`}>
            {close => (
              <>
                {!site.archived && (
                  <>
                    <MenuItem
                      icon={site.visibility === 'public' ? LockClosedIcon : GlobeAltIcon}
                      disabled={actions.setVisibility.isPending}
                      onClick={() => {
                        close()
                        actions.setVisibility.mutate(
                          site.visibility === 'public' ? 'private' : 'public'
                        )
                      }}
                    >
                      {site.visibility === 'public' ? 'Make private' : 'Make public'}
                    </MenuItem>
                    {site.shareUrl ? (
                      <MenuItem
                        icon={ClipboardDocumentIcon}
                        onClick={() => {
                          close()
                          if (site.shareUrl) copyShare(site.shareUrl)
                        }}
                      >
                        Copy share link
                      </MenuItem>
                    ) : (
                      <MenuItem
                        icon={LinkIcon}
                        disabled={actions.share.isPending}
                        onClick={() => {
                          close()
                          createShare(false)
                        }}
                      >
                        Create share link
                      </MenuItem>
                    )}
                    {reviewable && (
                      <MenuItem
                        icon={ChatBubbleLeftRightIcon}
                        onClick={() => {
                          close()
                          copyReviewLink()
                        }}
                      >
                        Copy review link
                      </MenuItem>
                    )}
                    <li className="my-1 border-t border-[color:var(--border-subtle)]" />
                    <MenuItem
                      icon={ArchiveBoxArrowDownIcon}
                      onClick={() => {
                        close()
                        setDialog('archive')
                      }}
                    >
                      Archive…
                    </MenuItem>
                  </>
                )}
                <MenuItem
                  icon={TrashIcon}
                  className="text-error"
                  onClick={() => {
                    close()
                    setDialog('delete')
                  }}
                >
                  Delete…
                </MenuItem>
              </>
            )}
          </ActionsMenu>
        </div>
      </div>

      {/* Line 2: meta + disclosures, full width under the actions */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-secondary">
        <span className="mr-1">
          <span className="max-sm:sr-only">Updated </span>
          <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
          <span className="max-sm:hidden">
            {' · '}
            <code className="text-xs" title={site.currentVersionId ?? undefined}>
              {shortVersion(site.currentVersionId)}
            </code>
          </span>
        </span>
        {!site.archived && disclosure('sharing', 'Sharing')}
        {site.currentVersionId && disclosure('files', 'Files')}
        {disclosure('versions', 'Versions')}
      </div>

      {open.sharing && !site.archived && (
        <div id={`${id}-sharing`} className="mt-2 grid gap-2 md:grid-cols-2">
          {/* Visibility */}
          <div className="surface-inset space-y-0.5 px-3 py-2">
            <label className="flex cursor-pointer items-center justify-between gap-3">
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
                : `Private: open to ${audienceFor(instance)}.`}
            </p>
          </div>

          {/* Share link */}
          <div className="surface-inset space-y-0.5 px-3 py-2">
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
                Lets anyone with the link open the site without signing in — for people who can’t
                sign in.
              </p>
            )}
          </div>
        </div>
      )}
      {open.files && site.currentVersionId && (
        <div id={`${id}-files`} className="mt-2">
          <VersionFiles
            name={site.name}
            versionId={site.currentVersionId}
            siteUrl={site.archived ? undefined : site.url}
          />
        </div>
      )}
      {open.versions && (
        <div id={`${id}-versions`} className="mt-2">
          <Versions site={site} />
        </div>
      )}

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
        message={`The link stops working straight away. People signed in to ${instance?.name ?? DEFAULT_INSTANCE_NAME} can still open the site if it is private.`}
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

/**
 * A "⋮" dropdown on a native <details>, so it opens with Enter/Space like any disclosure. Escape,
 * a click outside or tabbing away closes it; Escape hands focus back to the trigger.
 */
function ActionsMenu({
  label,
  children,
}: {
  label: string
  children: (close: () => void) => ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const close = () => ref.current?.removeAttribute('open')

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) ref.current?.removeAttribute('open')
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [isOpen])

  return (
    <details
      ref={ref}
      className="dropdown dropdown-end"
      onToggle={e => setIsOpen(e.currentTarget.open)}
      onKeyDown={e => {
        if (e.key === 'Escape' && ref.current?.open) {
          e.stopPropagation()
          close()
          ref.current.querySelector('summary')?.focus()
        }
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close()
      }}
    >
      <summary
        className="btn btn-ghost btn-xs btn-square h-6 min-h-6 w-6 list-none"
        aria-label={label}
        title="More actions"
      >
        <EllipsisVerticalIcon className="h-4 w-4" aria-hidden />
      </summary>
      <ul className="dropdown-content popover-surface z-30 mt-1 w-56 space-y-0.5 p-1.5">
        {children(close)}
      </ul>
    </details>
  )
}

function MenuItem({
  icon: Icon,
  className = '',
  disabled,
  onClick,
  children,
}: {
  icon: typeof TrashIcon
  className?: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <li>
      <button
        type="button"
        className={`nav-item flex w-full items-center gap-2 px-2.5 py-1.5 text-sm ${className}`}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {children}
      </button>
    </li>
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
