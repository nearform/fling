/**
 * Taking a Path away: archive (off the site, its URL 404s, its files and versions kept),
 * unarchive, and delete, which needs the folder typed: one an admin can recover where the
 * instance keeps deleted sites (`recoverableDeletes`), for good where it doesn't. The rest of the
 * site is untouched either way. After a delete the Path page has nothing left to show, so it goes back
 * to the site's page.
 */
import { deleteConfirmText, recoverableDeletesOf, type SitePath } from '@fling/shared'
import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInstance } from '../../hooks/instance'
import { usePathActions } from '../../hooks/queries'
import { shownFolder } from '../../lib/paths'
import { siteHref } from '../../lib/sites'
import { ConfirmModal } from '../ConfirmModal'
import { TypedDeleteModal } from './SiteDangerZone'
import { SiteSection } from './SiteSection'

export function PathDangerZone({ name, path }: { name: string; path: SitePath }) {
  const actions = usePathActions(name, path.folder)
  const recoverable = recoverableDeletesOf(useInstance())
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<'archive' | 'delete' | null>(null)
  const close = () => setDialog(null)
  const folder = shownFolder(path.folder)

  return (
    <SiteSection title="Danger zone" tone="danger">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-secondary">
          {path.archived
            ? 'Archived: off the site, with its files and versions kept. Unarchive it to serve it again.'
            : `Archive takes ${folder} off the site but keeps its files and versions.`}
        </p>
        {path.archived ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => actions.setArchived.mutate(false)}
            disabled={actions.setArchived.isPending}
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
          {recoverable
            ? `Delete takes ${folder} off the site. An admin can recover it.`
            : `Delete removes ${folder} and every version of it, for good.`}
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
        title={`Archive ${folder}?`}
        message={`${folder} goes off the site (its URL returns 404) but its files and versions are kept. The rest of the site stays as it is. Unarchive it any time.`}
        confirmText="Archive"
        confirmButtonClass="btn-warning"
        isLoading={actions.setArchived.isPending}
        onCancel={close}
        onConfirm={() => actions.setArchived.mutate(true, { onSettled: close })}
      />
      <TypedDeleteModal
        name={path.folder}
        title="Delete Path"
        label="Path folder"
        recoverable={recoverable}
        message={`${deleteConfirmText(recoverable, name, path.folder)} The rest of ${name} stays as it is.${recoverable ? '' : ' To keep the files, archive it instead.'}`}
        open={dialog === 'delete'}
        busy={actions.remove.isPending}
        onCancel={close}
        onConfirm={() =>
          actions.remove.mutate(undefined, {
            onSuccess: () => navigate(siteHref(name), { replace: true }),
            onSettled: close,
          })
        }
      />
    </SiteSection>
  )
}
