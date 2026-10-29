/**
 * Taking a site away: archive (offline, files and versions kept), unarchive, and delete for good,
 * which needs the name typed. After a delete the page has nothing left to show, so it goes back
 * to the list it came from (`home`).
 */
import type { Site } from '@fling/shared'
import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSiteActions } from '../../hooks/queries'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../Modal'
import { SiteSection } from './SiteSection'

export function SiteDangerZone({ site, home = '/' }: { site: Site; home?: string }) {
  const actions = useSiteActions(site.name)
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<'archive' | 'delete' | null>(null)
  const close = () => setDialog(null)

  return (
    <SiteSection title="Danger zone" tone="danger">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-secondary">
          {site.archived
            ? 'Archived: offline, with its files and versions kept. Unarchive it to serve it again.'
            : 'Archive takes the site offline but keeps its files and versions.'}
        </p>
        {site.archived ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => actions.unarchive.mutate(undefined)}
            disabled={actions.unarchive.isPending}
          >
            <ArchiveBoxXMarkIcon className="h-4 w-4" aria-hidden />
            Unarchive
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setDialog('archive')}>
            <ArchiveBoxArrowDownIcon className="h-4 w-4" aria-hidden />
            Archive…
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] pt-3">
        <p className="min-w-0 text-sm text-secondary">
          Delete removes the site, every version and its share link, for good.
        </p>
        <button
          type="button"
          className="btn btn-sm btn-outline btn-error"
          onClick={() => setDialog('delete')}
        >
          <TrashIcon className="h-4 w-4" aria-hidden />
          Delete…
        </button>
      </div>

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
        onConfirm={() =>
          actions.remove.mutate(undefined, {
            onSuccess: () => navigate(home, { replace: true }),
            onSettled: close,
          })
        }
      />
    </SiteSection>
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
