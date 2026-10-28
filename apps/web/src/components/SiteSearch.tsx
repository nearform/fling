/**
 * The Sites page's search box. `/` focuses it from anywhere on the page (unless you're already
 * typing somewhere); Escape clears it, and a second Escape on an empty box leaves it.
 */
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useEffect, useRef } from 'react'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

export function SiteSearch({
  value,
  onChange,
  className = '',
  placeholder = 'Search sites…',
  label = 'Search sites by name, URL or share link',
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  placeholder?: string
  label?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTypingTarget(e.target) || document.querySelector('dialog[open]')) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <label className={`input input-sm flex items-center gap-2 ${className}`}>
      <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        className="grow [&::-webkit-search-cancel-button]:hidden"
        placeholder={placeholder}
        aria-label={label}
        aria-keyshortcuts="/"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          if (value) onChange('')
          else e.currentTarget.blur()
        }}
      />
      {value ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-square h-5 min-h-5 w-5"
          aria-label="Clear the search"
          title="Clear (Esc)"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <kbd className="kbd kbd-xs text-muted" aria-hidden>
          /
        </kbd>
      )}
    </label>
  )
}
