/**
 * Copies text to the clipboard. The Clipboard API exists only in secure contexts (https or
 * localhost), so on an instance served over plain http (local dev on fling.lvh.me, a private
 * network) it falls back to a selected, off-screen textarea and `execCommand('copy')`, which
 * browsers still honour during a click. Rejects when neither works.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const focused = document.activeElement as HTMLElement | null
  try {
    area.select()
    if (!document.execCommand('copy')) throw new Error('copy refused')
  } finally {
    area.remove()
    focused?.focus()
  }
}
