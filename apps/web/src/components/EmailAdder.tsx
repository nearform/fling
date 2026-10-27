/**
 * The input for adding people by email, to a site's audience or a group: Enter, a comma or the
 * Add button adds what is typed, and a pasted list adds at once. The caller owns the draft (it
 * leaves what wasn't added in it) and says what went wrong in `problem`, shown beneath with `hint`.
 */
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react'

export function EmailAdder({
  id,
  draft,
  onDraftChange,
  onAdd,
  busy,
  problem,
  hint,
  label = 'Add people by email',
}: {
  id: string
  draft: string
  onDraftChange: (draft: string) => void
  onAdd: (text: string) => void
  busy: boolean
  problem: string | null
  hint?: ReactNode
  label?: string
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault()
      onAdd(draft)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      onAdd(`${draft} ${text}`)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <label htmlFor={`${id}-add`} className="sr-only">
          {label}
        </label>
        <input
          id={`${id}-add`}
          type="text"
          inputMode="email"
          autoComplete="off"
          className="input input-sm min-w-0 flex-1"
          placeholder="name@example.com, another@example.com"
          value={draft}
          aria-invalid={problem !== null}
          aria-describedby={`${id}-help`}
          onChange={e => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={!draft.trim() || busy}
          onClick={() => onAdd(draft)}
        >
          Add
        </button>
      </div>
      <div id={`${id}-help`} className="space-y-0.5 text-xs">
        {problem && (
          <p className="text-error" role="alert">
            {problem}
          </p>
        )}
        {hint && <p className="text-muted">{hint}</p>}
      </div>
    </div>
  )
}
