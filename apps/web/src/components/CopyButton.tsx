import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { useEffect, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { showToast } from '../lib/toast'

/** Copies `text`; the icon flips to a tick for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'btn btn-ghost btn-xs btn-square',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await copyText(text)
      setCopied(true)
    } catch {
      showToast('Could not copy — select the text and copy it by hand', 'warning')
    }
  }

  return (
    <button type="button" className={className} onClick={copy} title={label} aria-label={label}>
      {copied ? (
        <CheckIcon className="h-4 w-4 text-success" />
      ) : (
        <ClipboardDocumentIcon className="h-4 w-4" />
      )}
    </button>
  )
}

/** A one-line shell command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="surface-inset flex items-center gap-2 py-1.5 pr-1.5 pl-3">
      <code className="flex-1 overflow-x-auto whitespace-nowrap text-sm">
        <span className="text-muted select-none">$ </span>
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  )
}
