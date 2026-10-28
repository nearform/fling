import type { InstanceMetadata, Me } from '@fling/shared'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeAltIcon,
  KeyIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useMe } from '../hooks/queries'
import { useBooleanPreference } from '../hooks/useLocalStoragePreference'
import { ADMIN_USERS_PATH, showsAdmin } from '../lib/admin'
import { DEFAULT_INSTANCE_NAME } from '../lib/instance'
import { LogoMark } from './LogoMark'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
  /** the paths it is active on, when wider than `to` (Admin: every admin page) */
  match?: string
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Sites', icon: GlobeAltIcon },
  { to: '/connections', label: 'Connections', icon: KeyIcon },
]

/** Get started, always last: a guide people come back to rarely once they have a site. */
export const GET_STARTED_NAV_ITEM: NavItem = {
  to: '/get-started',
  label: 'Get started',
  icon: RocketLaunchIcon,
}

/** Admin (Users first, then Mail), for admins in their own session. */
export const ADMIN_NAV_ITEM: NavItem = {
  to: ADMIN_USERS_PATH,
  label: 'Admin',
  icon: ShieldCheckIcon,
  match: '/admin',
}

/** Groups, after Sites, on an instance with the `groups` capability. */
export const GROUPS_NAV_ITEM: NavItem = { to: '/groups', label: 'Groups', icon: UserGroupIcon }

/**
 * The side nav's items for this user: everyone's (with Groups where the instance has them), then
 * Admin for admins, then Get started.
 */
export function navItemsFor(
  me: Me | null | undefined,
  instance?: Pick<InstanceMetadata, 'capabilities'> | null
): NavItem[] {
  const [first, ...rest] = NAV_ITEMS
  const items =
    instance?.capabilities.groups === true && first ? [first, GROUPS_NAV_ITEM, ...rest] : NAV_ITEMS
  return [...items, ...(showsAdmin(me) ? [ADMIN_NAV_ITEM] : []), GET_STARTED_NAV_ITEM]
}

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
  const instance = useInstance()
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const { data: me } = useMe()

  return (
    <aside
      className={`app-nav h-full text-base-content border-r flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* Brand row: mark + app name. h-14 with its own bottom border, so the seam lines up with
          the top bar's. */}
      <Link
        to="/"
        aria-label={`${name} home`}
        className={`h-14 flex-none flex items-center gap-2.5 border-b border-[var(--border-default)] ${
          isCollapsed ? 'justify-center px-3' : 'px-4'
        }`}
      >
        <LogoMark className="w-6 h-6" />
        {!isCollapsed && <span className="font-semibold tracking-tight">{name}</span>}
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5" aria-label="Main">
        {navItemsFor(me, instance).map(item => (
          <div key={item.to} className="relative group">
            <NavLink
              to={item.to}
              onClick={closeMobileDrawer}
              data-active={isPathActive(pathname, item.match ?? item.to)}
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
