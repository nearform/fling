/**
 * A group in a list of people (a site's audience): tinted, with the group icon, its name and how
 * many people it holds, so it never reads as one address. The name opens the group; its owner also
 * gets an Edit button. A deleted group says so and only offers removal.
 */
import { PencilSquareIcon, UserGroupIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { peopleLabel } from '../lib/audience'

export function GroupChip({
  name,
  size,
  deleted = false,
  onOpen,
  onEdit,
  onRemove,
  removeLabel,
  disabled = false,
}: {
  name: string
  size: number
  deleted?: boolean
  onOpen?: () => void
  /** shown for the group's owner */
  onEdit?: () => void
  onRemove?: () => void
  removeLabel?: string
  disabled?: boolean
}) {
  return (
    <span className="badge h-auto max-w-full min-w-0 gap-1 border-[var(--tone-primary-border)] bg-[var(--tone-primary-surface)] py-0.5 text-[var(--text-primary)]">
      <UserGroupIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {deleted ? (
        <span title="Its owner deleted it: it lets nobody in, so only you can open the site through it">
          A deleted group
        </span>
      ) : (
        <>
          {onOpen ? (
            <button
              type="button"
              className="link link-hover min-w-0 truncate font-semibold"
              title={`Show the group ${name}`}
              onClick={onOpen}
            >
              {name}
            </button>
          ) : (
            <span className="min-w-0 truncate font-semibold">{name}</span>
          )}
          <span className="shrink-0 rounded-full bg-base-100 px-1.5 text-xs tabular-nums text-secondary">
            {peopleLabel(size)}
          </span>
        </>
      )}
      {onEdit && !deleted && (
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-circle h-4 min-h-4 w-4 shrink-0"
          aria-label={`Edit the group ${name}`}
          title={`Edit the group ${name}`}
          onClick={onEdit}
        >
          <PencilSquareIcon className="h-3 w-3" aria-hidden />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-circle h-4 min-h-4 w-4 shrink-0"
          aria-label={removeLabel ?? `Remove the group ${name}`}
          title={removeLabel ?? `Remove the group ${name}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <XMarkIcon className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  )
}
