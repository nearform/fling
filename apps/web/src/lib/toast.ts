/**
 * A tiny toast queue (agentic-mapper uses zustand; Fling has no store, so this is a plain external
 * store read with `useSyncExternalStore`). Problems and short confirmations only.
 */
import { useSyncExternalStore } from 'react'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: number
  message: string
  type: ToastType
  /**
   * A colour shown as a dot instead of the icon (a person, in review mode). Such a toast is not
   * a live region itself: the page that shows it announces the message in its own.
   */
  dot?: string
  /** a link the reader may follow, opened in a new tab (http and https only) */
  action?: { label: string; href: string }
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function dismissToast(id: number): void {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

export function showToast(
  message: string,
  type: ToastType = 'success',
  duration = 4000,
  opts: { dot?: string; action?: { label: string; href: string } } = {}
): void {
  const id = nextId++
  const action = opts.action && /^https?:\/\//i.test(opts.action.href) ? opts.action : undefined
  toasts = [
    ...toasts,
    { id, message, type, ...(opts.dot ? { dot: opts.dot } : {}), ...(action ? { action } : {}) },
  ]
  emit()
  if (duration > 0) setTimeout(() => dismissToast(id), duration)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts
  )
}
