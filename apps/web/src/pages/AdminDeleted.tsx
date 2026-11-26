/**
 * Admin → Deleted (`/admin/deleted`; admins only, the API answers 404 to anyone else): the
 * deleted sites, and the Paths deleted on their own, whose files are still kept, a page at a time
 * (Load more), newest or oldest first, with a name filter, and a Restore and a Delete for good on each row. Both are the admin's, from
 * this browser session only (deletion.ts). Deleting for good asks first, removes the files from
 * storage (a site's Paths' with it) and can't be undone; it is refused while a restore is under
 * way or while the site is live. A restore: a site's asks for the name to restore it under, its own by default,
 * and offers the server's suggestions when that is taken. The result says what came back, who was
 * left out, whether the admin became its owner and which secrets its server waits for. Offered on
 * every instance: sites kept before it switched to hard deletes stay restorable.
 */
import {
  type DeletedOrder,
  type DeletedSite,
  type RestoreResult,
  recoverableDeletesOf,
} from '@fling/shared'
import {
  ArrowUturnLeftIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { useEffect, useId, useState } from 'react'
import { ConfirmModal } from '../components/ConfirmModal'
import { Modal } from '../components/Modal'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import { useAdminDeleted, useMe, usePurgeDeleted, useRestoreActions } from '../hooks/queries'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { showsAdmin } from '../lib/admin'
import { ApiError, errorMessage } from '../lib/api'
import {
  deletedLabel,
  purgeConfirmOf,
  purgedText,
  restoredHeadline,
  restoreNameOf,
  restoreNotes,
} from '../lib/deleted'
import { displayUrl, formatBytes, fullDate, timeAgo } from '../lib/format'
import { shownFolder } from '../lib/paths'

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={fullDate(iso)}>
      {timeAgo(iso)}
    </time>
  )
}

const rowKey = (d: DeletedSite) => `${d.siteId}:${d.pathId ?? ''}:${d.deletedAt}`

function DeletedTable({
  rows,
  onRestore,
  onPurge,
}: {
  rows: DeletedSite[]
  onRestore: (d: DeletedSite) => void
  onPurge: (d: DeletedSite) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Site</th>
            <th>Owner</th>
            <th>Deleted</th>
            <th>Kept</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(d => (
            <tr key={rowKey(d)}>
              <td className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{deletedLabel(d)}</span>
                  {d.kind === 'path' && <span className="badge badge-sm badge-outline">Path</span>}
                </div>
                {d.paths && d.paths.length > 0 && (
                  <div className="text-xs text-secondary">
                    With its Paths: {d.paths.map(p => shownFolder(p.folder)).join(', ')}
                  </div>
                )}
              </td>
              <td className="text-secondary text-sm">
                <span className="truncate">{d.owner}</span>
              </td>
              <td className="text-secondary">
                <div className="truncate text-xs">by {d.deletedBy}</div>
                <div className="text-xs">
                  <When iso={d.deletedAt} />
                </div>
              </td>
              <td className="text-secondary text-sm tabular-nums">about {formatBytes(d.bytes)}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1 whitespace-nowrap">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onRestore(d)}
                  >
                    <ArrowUturnLeftIcon className="size-4" aria-hidden />
                    Restore…
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-error"
                    onClick={() => onPurge(d)}
                  >
                    <TrashIcon className="size-4" aria-hidden />
                    Delete for good…
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A site's restore: under its own name unless the admin types another or picks a suggestion. */
function RestoreSiteModal({
  deleted,
  onClose,
  onRestored,
}: {
  deleted: DeletedSite | null
  onClose: () => void
  onRestored: (result: RestoreResult) => void
}) {
  const { site } = useRestoreActions()
  const [name, setName] = useState('')
  const formId = `restore-${useId()}`
  const original = deleted?.name ?? ''

  // biome-ignore lint/correctness/useExhaustiveDependencies: start afresh for each site chosen
  useEffect(() => {
    setName(original)
    site.reset()
  }, [deleted])

  const error = site.error
  const taken = error instanceof ApiError && error.code === 'name_taken'
  const close = () => {
    if (!site.isPending) onClose()
  }

  return (
    <Modal
      open={deleted !== null}
      onClose={close}
      title={`Restore ${original}`}
      closeButton={false}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={close} disabled={site.isPending}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-sm btn-primary"
            disabled={site.isPending || !name.trim()}
          >
            {site.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Restore'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={e => {
          e.preventDefault()
          if (!deleted) return
          site.mutate(
            { siteId: deleted.siteId, name: restoreNameOf(original, name) },
            { onSuccess: onRestored }
          )
        }}
      >
        <p>
          Its last live version goes live again, with its Paths deleted with it, its older versions,
          comments and form responses, and the people it was shared with who are still on this
          Fling. This is recorded, with your email.
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm">Restore it as</span>
          <input
            className="input input-sm w-full font-mono"
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Site name"
          />
        </label>
        {error && (
          <div role="alert" className="alert alert-error block space-y-2 text-sm">
            <p>{errorMessage(error)}</p>
            {taken && error.suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span>Use instead:</span>
                {error.suggestions.map(s => (
                  <button
                    key={s}
                    type="button"
                    className="btn btn-xs font-mono"
                    onClick={() => setName(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </form>
    </Modal>
  )
}

/** A Path deleted on its own: back into its site, under its own folder. */
function RestorePathModal({
  deleted,
  onClose,
  onRestored,
}: {
  deleted: DeletedSite | null
  onClose: () => void
  onRestored: (result: RestoreResult) => void
}) {
  const { path } = useRestoreActions()
  // biome-ignore lint/correctness/useExhaustiveDependencies: start afresh for each Path chosen
  useEffect(() => path.reset(), [deleted])
  const label = deleted ? deletedLabel(deleted) : ''
  return (
    <ConfirmModal
      isOpen={deleted !== null}
      title={`Restore ${label}?`}
      message={
        <div className="space-y-2">
          <p>
            Its last live version goes live again on {deleted?.name}, with its older versions, and
            the owners and publishers it had who are still on this Fling. {deleted?.name} must exist
            and the folder must be free. This is recorded, with your email.
          </p>
          {path.error && (
            <p role="alert" className="alert alert-error text-sm">
              {errorMessage(path.error)}
            </p>
          )}
        </div>
      }
      confirmText="Restore"
      isLoading={path.isPending}
      onCancel={onClose}
      onConfirm={() => {
        if (deleted?.pathId) {
          path.mutate({ siteId: deleted.siteId, pathId: deleted.pathId }, { onSuccess: onRestored })
        }
      }}
    />
  )
}

/** Delete a row for good: its files go from storage, so this asks first and can't be undone. */
function PurgeModal({
  deleted,
  onClose,
  onPurged,
}: {
  deleted: DeletedSite | null
  onClose: () => void
  onPurged: (d: DeletedSite) => void
}) {
  const purge = usePurgeDeleted()
  // biome-ignore lint/correctness/useExhaustiveDependencies: start afresh for each row chosen
  useEffect(() => purge.reset(), [deleted])
  const close = () => {
    if (!purge.isPending) onClose()
  }
  return (
    <ConfirmModal
      isOpen={deleted !== null}
      title="Delete for good"
      message={
        <div className="space-y-2">
          <p>{deleted ? purgeConfirmOf(deleted) : ''} This is recorded, with your email.</p>
          {purge.error && (
            <p role="alert" className="alert alert-error text-sm">
              {errorMessage(purge.error)}
            </p>
          )}
        </div>
      }
      confirmText="Delete for good"
      confirmButtonClass="btn-error"
      isLoading={purge.isPending}
      onCancel={close}
      onConfirm={() => {
        if (deleted) purge.mutate(deleted, { onSuccess: () => onPurged(deleted) })
      }}
    />
  )
}

function Purged({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div role="status" className="alert alert-success items-start text-sm">
      <p className="min-w-0 flex-1 font-medium">{text}</p>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <XMarkIcon className="size-4" />
      </button>
    </div>
  )
}

function Restored({ result, onDismiss }: { result: RestoreResult; onDismiss: () => void }) {
  return (
    <div role="status" className="alert alert-success items-start text-sm">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {restoredHeadline(result)}:{' '}
          <a className="link" href={result.url} target="_blank" rel="noreferrer">
            {displayUrl(result.url)}
          </a>
        </p>
        <ul className="space-y-0.5">
          {restoreNotes(result).map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <XMarkIcon className="size-4" />
      </button>
    </div>
  )
}

export default function AdminDeleted() {
  const { data: me } = useMe()
  const instance = useInstance()
  const allowed = showsAdmin(me)
  const [search, setSearch] = useState('')
  const name = useDebouncedValue(search.trim().toLowerCase())
  const [order, setOrder] = useState<DeletedOrder>('newest')
  const list = useAdminDeleted({ name, order }, allowed)
  const [restoring, setRestoring] = useState<DeletedSite | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [purging, setPurging] = useState<DeletedSite | null>(null)
  const [purged, setPurged] = useState<string | null>(null)

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  const restored = (r: RestoreResult) => {
    setRestoring(null)
    setPurged(null)
    setResult(r)
  }
  const onPurged = (d: DeletedSite) => {
    setPurging(null)
    setResult(null)
    setPurged(purgedText(d))
  }
  const rows = list.data?.pages.flatMap(p => p.deleted) ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Deleted"
          description="Sites and Paths people deleted whose files are still kept, newest or oldest first. Restore one to put it back online, or delete it for good."
        />
        <p className="text-sm text-secondary">
          {recoverableDeletesOf(instance)
            ? 'Deleting a site or a Path keeps its files, so an admin can restore it here.'
            : 'This Fling deletes sites for good, so only those deleted before that are kept.'}{' '}
          Kept files stay in storage until they are restored or deleted for good here. Sizes are a
          guide.
        </p>
      </div>

      {result && <Restored result={result} onDismiss={() => setResult(null)} />}
      {purged && <Purged text={purged} onDismiss={() => setPurged(null)} />}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="input input-sm min-w-0 flex-1 sm:w-80 sm:flex-none">
            <MagnifyingGlassIcon className="size-4 text-muted" />
            <input
              type="search"
              placeholder="Site name"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Show one site name's deletes"
            />
          </label>
          <select
            className="select select-sm w-auto shrink-0"
            aria-label="Order deleted sites by"
            value={order}
            onChange={e => setOrder(e.target.value === 'oldest' ? 'oldest' : 'newest')}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <div className="surface-panel !p-0 overflow-clip">
          {list.isPending ? (
            <div className="p-6 text-center">
              <span
                className="loading loading-spinner loading-sm text-muted"
                role="status"
                aria-label="Loading"
              />
            </div>
          ) : list.isError ? (
            <div className="p-6 text-sm text-error">{errorMessage(list.error)}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-secondary">
              <TrashIcon className="mx-auto mb-2 size-6 text-muted" />
              {name
                ? `Nothing deleted under the name “${name}” is kept.`
                : 'Nothing deleted is kept.'}
            </div>
          ) : (
            <DeletedTable rows={rows} onRestore={setRestoring} onPurge={setPurging} />
          )}
        </div>
        {list.hasNextPage && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'Load more'
            )}
          </button>
        )}
      </section>

      <RestoreSiteModal
        deleted={restoring?.kind === 'site' ? restoring : null}
        onClose={() => setRestoring(null)}
        onRestored={restored}
      />
      <RestorePathModal
        deleted={restoring?.kind === 'path' ? restoring : null}
        onClose={() => setRestoring(null)}
        onRestored={restored}
      />
      <PurgeModal deleted={purging} onClose={() => setPurging(null)} onPurged={onPurged} />
    </div>
  )
}
