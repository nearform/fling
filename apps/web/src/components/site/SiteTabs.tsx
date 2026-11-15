/**
 * The site page's tab strip, styled like the app's other tabs (`tabs tabs-border`). It follows the
 * WAI-ARIA tabs pattern: only the selected tab is in the Tab order, the arrow keys move between
 * tabs and select them, Home and End go to the first and last. The panel is `SiteTabPanel`.
 */
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { SITE_TAB_LABELS, type SiteTab } from '../../lib/site-tabs'

export const siteTabId = (tab: SiteTab) => `site-tab-${tab}`
const PANEL_ID = 'site-tabpanel'

export function SiteTabs({
  tabs,
  selected,
  onSelect,
  attention,
}: {
  tabs: readonly SiteTab[]
  selected: SiteTab
  onSelect: (tab: SiteTab) => void
  /** a tab with something waiting on the viewer, and what, for screen readers */
  attention?: Partial<Record<SiteTab, string>>
}) {
  const list = useRef<HTMLDivElement>(null)
  const move = (to: number) => {
    const tab = tabs[(to + tabs.length) % tabs.length]
    if (!tab) return
    onSelect(tab)
    list.current?.querySelector<HTMLButtonElement>(`#${siteTabId(tab)}`)?.focus()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const at = tabs.indexOf(selected)
    const to =
      e.key === 'ArrowRight'
        ? at + 1
        : e.key === 'ArrowLeft'
          ? at - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : null
    if (to === null) return
    e.preventDefault()
    move(to)
  }

  return (
    <div
      ref={list}
      role="tablist"
      className="tabs tabs-border flex-nowrap overflow-x-auto"
      aria-label="Site"
      onKeyDown={onKeyDown}
    >
      {tabs.map(tab => {
        const active = tab === selected
        const note = attention?.[tab]
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            id={siteTabId(tab)}
            aria-selected={active}
            aria-controls={PANEL_ID}
            tabIndex={active ? 0 : -1}
            className={`tab shrink-0 gap-1.5 ${active ? 'tab-active' : ''}`}
            onClick={() => onSelect(tab)}
          >
            {SITE_TAB_LABELS[tab]}
            {note && (
              <>
                <ExclamationTriangleIcon className="size-4 text-warning" aria-hidden="true" />
                <span className="sr-only">: {note}</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function SiteTabPanel({ tab, children }: { tab: SiteTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={PANEL_ID} aria-labelledby={siteTabId(tab)} className="space-y-4">
      {children}
    </div>
  )
}
