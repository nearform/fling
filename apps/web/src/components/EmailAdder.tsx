/**
 * The input for adding people by email, to a site's audience or a group: Enter, a comma or the
 * Add button adds what is typed, and a pasted list adds at once. The caller owns the draft (it
 * leaves what wasn't added in it) and says what went wrong in `problem`, shown beneath with `hint`.
 *
 * It completes addresses from the instance's allowed email domains (`lib/email-complete.ts`). With
 * one domain the rest of the address shows as ghost text, which Tab takes (Enter takes it and
 * adds), and entries without a domain get it when added or pasted. With several, a list of
 * matching addresses opens under the input with the first one highlighted (an ARIA combobox:
 * arrows move, Tab fills in the highlighted one, Enter adds it, Escape closes). With none published there is no completion.
 *
 * With outside invitations on, it says that someone from outside is invited as a reviewer
 * (`outsideInviteNote`), except where only members may be added (`membersOnly`: a site's owners
 * and publishers).
 */
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useRef, useState } from 'react'
import { useInstance } from '../hooks/instance'
import { outsideInviteNote } from '../lib/audience'
import {
  acceptSuggestion,
  completeEntries,
  currentEntry,
  domainSuggestions,
  inlineCompletion,
} from '../lib/email-complete'

const NO_DOMAINS: readonly string[] = []

export function EmailAdder({
  id,
  draft,
  onDraftChange,
  onAdd,
  busy,
  problem,
  hint,
  label = 'Add people by email',
  membersOnly = false,
}: {
  id: string
  draft: string
  onDraftChange: (draft: string) => void
  onAdd: (text: string) => void
  busy: boolean
  problem: string | null
  hint?: ReactNode
  label?: string
  membersOnly?: boolean
}) {
  const instance = useInstance()
  const domains = instance?.auth.emailDomains ?? NO_DOMAINS
  const outside = membersOnly ? null : outsideInviteNote(instance)
  const [closed, setClosed] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const ghost = inlineCompletion(draft, domains)
  const options = domains.length > 1 ? domainSuggestions(currentEntry(draft).entry, domains) : []
  const listOpen = options.length > 0 && !closed
  const listId = `${id}-suggestions`
  // The highlighted option: the first until the arrows move it, kept in range as the list narrows.
  const current = listOpen ? Math.min(active, options.length - 1) : -1

  /** A new draft reopens the list, highlighting its first option again. */
  const change = (next: string) => {
    setClosed(false)
    setActive(0)
    onDraftChange(next)
  }
  // The combobox attributes, only where there is something to complete.
  const combobox =
    domains.length === 0
      ? {}
      : {
          role: 'combobox',
          'aria-autocomplete': domains.length === 1 ? ('inline' as const) : ('list' as const),
          'aria-expanded': domains.length > 1 && listOpen,
          ...(domains.length > 1 && { 'aria-controls': listId }),
          ...(current >= 0 && { 'aria-activedescendant': `${listId}-${current}` }),
        }

  const add = (text: string) => onAdd(completeEntries(text, domains))
  const pick = (address: string, andAdd: boolean) => {
    const next = acceptSuggestion(draft, address)
    if (andAdd) add(next)
    else change(next)
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const last = options.length - 1
      setActive(
        e.key === 'ArrowDown'
          ? current >= last
            ? 0
            : current + 1
          : current <= 0
            ? last
            : current - 1
      )
      return
    }
    if (listOpen && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setClosed(true)
      return
    }
    const chosen = current >= 0 ? options[current] : undefined
    if (e.key === 'Tab' && !e.shiftKey && (ghost || chosen)) {
      e.preventDefault()
      change(ghost ? `${draft}${ghost}` : acceptSuggestion(draft, chosen as string))
      return
    }
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault()
      if (chosen) pick(chosen, true)
      else add(ghost && e.key === 'Enter' ? `${draft}${ghost}` : draft)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      add(`${draft} ${text}`)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5">
        <label htmlFor={`${id}-add`} className="sr-only">
          {label}
        </label>
        {/* The list opens in the flow, under the input: a modal's scrolling body would clip it. */}
        <div className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            id={`${id}-add`}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            className="input input-sm w-full"
            placeholder="name@example.com, another@example.com"
            value={draft}
            {...combobox}
            aria-invalid={problem !== null}
            aria-describedby={`${id}-help`}
            onChange={e => change(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setClosed(true)}
          />
          {ghost && (
            // The typed text, invisible, then the rest of the address: lines up with the input's own.
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center overflow-clip whitespace-pre border border-transparent px-3 text-xs"
            >
              <span className="invisible">{draft}</span>
              <span className="text-muted">{ghost}</span>
            </span>
          )}
          {domains.length > 1 && (
            <div
              id={listId}
              role="listbox"
              aria-label="Suggested addresses"
              hidden={!listOpen}
              className="popover-surface mbs-1 max-h-48 overflow-y-auto rounded-box border p-1 text-sm"
            >
              {options.map((address, i) => (
                <div
                  key={address}
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  className={`cursor-pointer truncate rounded-field px-2 py-1 ${i === current ? 'bg-[var(--surface-active)]' : ''}`}
                  // Keep focus in the input, so the pick lands where the person is typing.
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pick(address, false)}
                  onMouseEnter={() => setActive(i)}
                >
                  {address}
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!draft.trim() || busy}
          onClick={() => add(draft)}
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
        {outside && <p className="text-muted">{outside}</p>}
      </div>
    </div>
  )
}
