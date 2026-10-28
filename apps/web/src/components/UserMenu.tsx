/**
 * Header avatar dropdown: who you are, your connections, your notifications (on an instance that
 * has them), sign out. Theme lives in `ThemeToggle`.
 */
import { ArrowRightStartOnRectangleIcon, BellIcon, KeyIcon } from '@heroicons/react/24/outline'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { useLogout, useMe } from '../hooks/queries'
import { initials } from '../lib/format'
import { NOTIFICATION_SETTINGS_PATH, showsNotifications } from '../lib/notifications'

export function UserMenu() {
  const { data: user } = useMe()
  const logout = useLogout()
  const instance = useInstance()
  const ref = useRef<HTMLDetailsElement>(null)
  if (!user) return null

  const close = () => ref.current?.removeAttribute('open')

  return (
    <details ref={ref} className="dropdown dropdown-end">
      <summary
        className="btn btn-ghost btn-sm btn-circle avatar list-none"
        aria-label="Your account"
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            className="w-7 h-7 rounded-full"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="w-7 h-7 rounded-full grid place-items-center text-xs font-semibold tone-primary">
            {initials(user.name, user.email)}
          </span>
        )}
      </summary>
      <ul className="dropdown-content popover-surface z-50 mt-1 w-64 p-1.5 space-y-0.5">
        <li className="px-2.5 py-2">
          <div className="text-sm font-medium truncate">{user.name}</div>
          <div className="text-xs text-muted truncate">{user.email}</div>
        </li>
        <li className="border-t border-[color:var(--border-subtle)] my-1" />
        <li>
          <Link
            to="/connections"
            onClick={close}
            className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
          >
            <KeyIcon className="w-4 h-4" /> Connections
          </Link>
        </li>
        {showsNotifications(instance) && (
          <li>
            <Link
              to={NOTIFICATION_SETTINGS_PATH}
              onClick={close}
              className="nav-item flex items-center gap-2 px-2.5 py-1.5 text-sm"
            >
              <BellIcon className="w-4 h-4" /> Notifications
            </Link>
          </li>
        )}
        <li className="border-t border-[color:var(--border-subtle)] my-1" />
        <li>
          <button
            type="button"
            className="nav-item flex w-full items-center gap-2 px-2.5 py-1.5 text-sm"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <ArrowRightStartOnRectangleIcon className="w-4 h-4" /> Sign out
          </button>
        </li>
      </ul>
    </details>
  )
}

export default UserMenu
