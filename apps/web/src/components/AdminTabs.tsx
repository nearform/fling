/** Admin's pages as tabs (Users, and Mail on an instance that sends email); none with only one. */
import { NavLink } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useMe } from '../hooks/queries'
import { ADMIN_USERS_PATH } from '../lib/admin'
import { ADMIN_MAIL_PATH, showsMailAdmin } from '../lib/notifications'

export interface AdminTab {
  to: string
  label: string
}

export const ADMIN_USERS_TAB: AdminTab = { to: ADMIN_USERS_PATH, label: 'Users' }
export const ADMIN_MAIL_TAB: AdminTab = { to: ADMIN_MAIL_PATH, label: 'Mail' }

export function adminTabsFor(mail: boolean): AdminTab[] {
  return mail ? [ADMIN_USERS_TAB, ADMIN_MAIL_TAB] : [ADMIN_USERS_TAB]
}

export function AdminTabs() {
  const { data: me } = useMe()
  const instance = useInstance()
  const tabs = adminTabsFor(showsMailAdmin(me, instance))
  if (tabs.length < 2) return null
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
