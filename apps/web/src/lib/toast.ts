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

export function showToast(message: string, type: ToastType = 'success', duration = 4000): void {
  const id = nextId++
  toasts = [...toasts, { id, message, type }]
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
