import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export interface Breadcrumb {
  to: string
  label: string
}

/**
 * Page title row: optional breadcrumbs back up the app, a modest title, a description,
 * right-aligned actions.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  breadcrumbs?: Breadcrumb[]
}) {
  return (
    <div className="mb-6 space-y-1">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="breadcrumbs py-0 text-xs text-secondary">
          <ul>
            {breadcrumbs.map(crumb => (
              <li key={crumb.to}>
                <Link to={crumb.to} className="link link-hover">
                  {crumb.label}
                </Link>
              </li>
            ))}
            <li aria-current="page" className="min-w-0 truncate">
              {title}
            </li>
          </ul>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-all">{title}</h1>
          {description && <p className="mt-1 text-sm text-secondary">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
