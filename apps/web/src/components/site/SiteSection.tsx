import type { ReactNode } from 'react'

/** One titled panel of the site page. */
export function SiteSection({
  title,
  description,
  tone,
  children,
}: {
  title: string
  description?: ReactNode
  /** `danger`: an error-coloured border, for actions that take the site away */
  tone?: 'danger'
  children: ReactNode
}) {
  const id = `site-section-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section
      aria-labelledby={id}
      className={`surface-panel space-y-3 ${tone === 'danger' ? 'border-error/40' : ''}`}
    >
      <div>
        <h2 id={id} className="text-base font-medium">
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  )
}
