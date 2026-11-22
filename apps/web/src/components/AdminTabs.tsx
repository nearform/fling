/**
 * Admin's pages, as a menu down the left of each of them (`AdminLayout`, the route around every
 * admin page): Users, Invitations on an instance with outside invitations on, Mail on one that
 * sends email, Usage on one with metrics, Audit, Routes and Settings. Only admins see the menu; to anyone else each page says
 * it is for admins.
 */
import {
  ChartBarSquareIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  EnvelopeIcon,
  MapIcon,
  UserPlusIcon,
  UsersIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useMe } from '../hooks/queries'
import {
  ADMIN_AUDIT_PATH,
  ADMIN_INVITATIONS_PATH,
  ADMIN_ROUTES_PATH,
  ADMIN_SETTINGS_PATH,
  ADMIN_USERS_PATH,
  showsAdmin,
  showsInvitationsAdmin,
} from '../lib/admin'
import { ADMIN_MAIL_PATH, showsMailAdmin } from '../lib/notifications'
import { ADMIN_USAGE_PATH, showsUsageAdmin } from '../lib/usage'

export interface AdminTab {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export const ADMIN_USERS_TAB: AdminTab = { to: ADMIN_USERS_PATH, label: 'Users', icon: UsersIcon }
export const ADMIN_INVITATIONS_TAB: AdminTab = {
  to: ADMIN_INVITATIONS_PATH,
  label: 'Invitations',
  icon: UserPlusIcon,
}
export const ADMIN_MAIL_TAB: AdminTab = { to: ADMIN_MAIL_PATH, label: 'Mail', icon: EnvelopeIcon }
export const ADMIN_USAGE_TAB: AdminTab = {
  to: ADMIN_USAGE_PATH,
  label: 'Usage',
  icon: ChartBarSquareIcon,
}
export const ADMIN_AUDIT_TAB: AdminTab = {
  to: ADMIN_AUDIT_PATH,
  label: 'Audit',
  icon: ClipboardDocumentListIcon,
}
export const ADMIN_ROUTES_TAB: AdminTab = { to: ADMIN_ROUTES_PATH, label: 'Routes', icon: MapIcon }
export const ADMIN_SETTINGS_TAB: AdminTab = {
  to: ADMIN_SETTINGS_PATH,
  label: 'Settings',
  icon: Cog6ToothIcon,
}

export function adminTabsFor(mail: boolean, invites = false, usage = false): AdminTab[] {
  return [
    ADMIN_USERS_TAB,
    ...(invites ? [ADMIN_INVITATIONS_TAB] : []),
    ...(mail ? [ADMIN_MAIL_TAB] : []),
    ...(usage ? [ADMIN_USAGE_TAB] : []),
    ADMIN_AUDIT_TAB,
    ADMIN_ROUTES_TAB,
    ADMIN_SETTINGS_TAB,
  ]
}

function AdminNav() {
  const { data: me } = useMe()
  const instance = useInstance()
  const { pathname } = useLocation()
  const tabs = adminTabsFor(
    showsMailAdmin(me, instance),
    showsInvitationsAdmin(me, instance),
    showsUsageAdmin(me, instance)
  )
  return (
    <nav className="w-44 flex-none space-y-0.5" aria-label="Admin">
      {tabs.map(tab => (
        <NavLink
          key={tab.to}
          to={tab.to}
          data-active={pathname === tab.to}
          className="nav-item flex items-center gap-2.5 px-2.5 py-1.5"
        >
          <tab.icon className="w-[18px] h-[18px] flex-shrink-0" />
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}

/**
 * The menu beside the page where there is room for both, and above it where there is not: it
 * wraps, so no breakpoint decides.
 */
export function AdminLayout() {
  const { data: me } = useMe()
  if (!showsAdmin(me)) return <Outlet />
  return (
    <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-x-10 gap-y-6">
      <AdminNav />
      <div className="min-w-0 flex-1 basis-[36rem]">
        <Outlet />
      </div>
    </div>
  )
}
