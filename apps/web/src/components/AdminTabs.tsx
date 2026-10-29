/** Admin's pages as tabs: Users, Mail on an instance that sends email, and Settings. */
import { NavLink } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useMe } from '../hooks/queries'
import { ADMIN_SETTINGS_PATH, ADMIN_USERS_PATH } from '../lib/admin'
import { ADMIN_MAIL_PATH, showsMailAdmin } from '../lib/notifications'

export interface AdminTab {
  to: string
  label: string
}

export const ADMIN_USERS_TAB: AdminTab = { to: ADMIN_USERS_PATH, label: 'Users' }
export const ADMIN_MAIL_TAB: AdminTab = { to: ADMIN_MAIL_PATH, label: 'Mail' }
export const ADMIN_SETTINGS_TAB: AdminTab = { to: ADMIN_SETTINGS_PATH, label: 'Settings' }

export function adminTabsFor(mail: boolean): AdminTab[] {
  return mail
    ? [ADMIN_USERS_TAB, ADMIN_MAIL_TAB, ADMIN_SETTINGS_TAB]
    : [ADMIN_USERS_TAB, ADMIN_SETTINGS_TAB]
}

export function AdminTabs() {
  const { data: me } = useMe()
  const instance = useInstance()
  const tabs = adminTabsFor(showsMailAdmin(me, instance))
  return (
    <nav className="tabs tabs-border" aria-label="Admin">
      {tabs.map(tab => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
