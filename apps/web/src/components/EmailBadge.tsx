/**
 * An email address as a badge, wherever people are listed (an audience, a group's members, an
 * owner): the local part in semibold and the `@domain` muted, so a list reads by name. A long
 * address truncates the domain first, then the name, and shows in full on hover. Optional: a
 * marker for someone who hasn't signed in yet, and a remove button named for the address.
 */
import { XMarkIcon } from '@heroicons/react/24/outline'
import { splitEmail } from '../lib/groups'

export function EmailBadge({
  email,
  known = true,
  onRemove,
  removeLabel = `Remove ${email}`,
  disabled = false,
  size = 'md',
}: {
  email: string
  /** false: marked "hasn't signed in yet" */
  known?: boolean
  onRemove?: () => void
  removeLabel?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  const { local, domain } = splitEmail(email)
  return (
    <span
      className={`badge h-auto max-w-full min-w-0 gap-1 border-[var(--border-default)] bg-[var(--surface-panel)] py-0.5 font-normal ${size === 'sm' ? 'badge-sm' : ''}`}
    >
      <span className="flex min-w-0" title={email}>
        <span className="truncate font-semibold text-base-content">{local}</span>
        {domain && <span className="min-w-[4ch] shrink-[4] truncate text-muted">{domain}</span>}
      </span>
      {!known && (
        <span className="shrink-0 text-xs text-muted" title="They haven't signed in yet">
          · hasn’t signed in yet
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-circle h-4 min-h-4 w-4 shrink-0"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={disabled}
          onClick={onRemove}
        >
          <XMarkIcon className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  )
}
