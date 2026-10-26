import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { dismissToast, type ToastType, useToasts } from '../lib/toast'

const icons: Record<ToastType, typeof CheckCircleIcon> = {
  success: CheckCircleIcon,
  info: InformationCircleIcon,
  error: ExclamationCircleIcon,
  warning: ExclamationTriangleIcon,
}

// Built from a prop → safelisted via `@source inline` in index.css
const alertClass: Record<ToastType, string> = {
  success: 'alert-success',
  info: 'alert-info',
  error: 'alert-error',
  warning: 'alert-warning',
}

/** Bottom-right stack. Mount once. */
export function Toasts() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="toast toast-end toast-bottom z-50">
      {toasts.map(toast => {
        const Icon = icons[toast.type]
        return (
          <div
            key={toast.id}
            className={`alert ${alertClass[toast.type]} toast-in`}
            role={toast.dot ? undefined : toast.type === 'error' ? 'alert' : 'status'}
          >
            {toast.dot ? (
              <span
                className="toast-dot"
                style={{ backgroundColor: toast.dot }}
                aria-hidden="true"
              />
            ) : (
              <Icon className="h-5 w-5 shrink-0" />
            )}
            <span className="text-sm">{toast.message}</span>
            {toast.action && (
              <a
                href={toast.action.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
                onClick={() => dismissToast(toast.id)}
              >
                {toast.action.label}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
