import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeAltIcon,
  KeyIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/outline'
import { LabsHeader } from '@nearform/labs-ui-components/labs-header'
import type { ComponentType } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useBooleanPreference } from '../hooks/useLocalStoragePreference'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Sites', icon: GlobeAltIcon },
  { to: '/get-started', label: 'Get started', icon: RocketLaunchIcon },
  { to: '/connections', label: 'Connections', icon: KeyIcon },
]

/** `/` matches only itself; every other path matches itself and its descendants. */
export function isPathActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/'
  return pathname === to || pathname.startsWith(`${to}/`)
}

/** Close the mobile drawer after navigating (the desktop drawer is always open). */
function closeMobileDrawer() {
  const toggle = document.getElementById('drawer-toggle') as HTMLInputElement | null
  if (toggle && window.innerWidth < 1024) toggle.checked = false
}

export default function SideNav() {
  const { pathname } = useLocation()
  const [isCollapsed, setIsCollapsed] = useBooleanPreference('sideNavCollapsed', false)

  return (
    <aside
      className={`app-nav h-full text-base-content border-r flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* The Nearform Labs row (@nearform/labs-ui-components): mark, app name, and the Labs app
          switcher. h-14 with its own bottom border, so the seam lines up with the top bar's. */}
      <LabsHeader
        name="Fling"
        current="fling"
        collapsed={isCollapsed}
        renderHomeLink={({ children, ...props }) => (
          <Link to="/" {...props}>
            {children}
          </Link>
        )}
      />

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5" aria-label="Main">
        {NAV_ITEMS.map(item => (
          <div key={item.to} className="relative group">
            <NavLink
              to={item.to}
              onClick={closeMobileDrawer}
              data-active={isPathActive(pathname, item.to)}
              className={`nav-item flex items-center gap-2.5 ${
                isCollapsed ? 'justify-center px-3 py-2.5' : 'px-2.5 py-1.5'
              }`}
              aria-label={isCollapsed ? item.label : undefined}
            >
              <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
              {!isCollapsed && <span className="flex-1">{item.label}</span>}
            </NavLink>
            {isCollapsed && (
              <div className="hidden md:block absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                <div className="popover-surface px-3 py-2 text-sm whitespace-nowrap">
                  {item.label}
                </div>
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="p-3 hidden lg:block border-t border-[color:var(--border-subtle)]">
        <button
          type="button"
          onClick={() => setIsCollapsed(c => !c)}
          className={`btn btn-ghost btn-sm w-full ${isCollapsed ? 'btn-square' : 'justify-start gap-2'}`}
          title={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {isCollapsed ? (
            <ChevronRightIcon className="w-4 h-4" />
          ) : (
            <>
              <ChevronLeftIcon className="w-4 h-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
