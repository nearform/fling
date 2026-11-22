/**
 * Admin → Users (admins only; the API answers 404 to anyone else): every user of the instance, by
 * email, searched by email prefix and paged with "Load more"; Impersonate (with a confirmation)
 * on everyone but yourself and other admins; guests marked (invited from outside by a share or a
 * group). Each user's Sites link opens All sites narrowed to the sites they own or publish. The
 * last sign-in is to the day: the users index is written once a day per user, not on every sign-in
 * (store/records.ts `upsertUser`). What admins did is on Admin → Audit.
 */
import type { AdminUser } from '@fling/shared'
import { EyeIcon, MagnifyingGlassIcon, UsersIcon } from '@heroicons/react/24/outline'
import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader } from '../components/PageHeader'
import { useAdminUsers, useImpersonation, useMe } from '../hooks/queries'
import { allSitesOf, impersonateBlocked, showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { daysAgo, fullDate, timeAgo, utcDate } from '../lib/format'

function When({ iso, never = '—' }: { iso: string | null; never?: string }) {
  if (!iso) return <span className="text-muted">{never}</span>
  return <span title={fullDate(iso)}>{timeAgo(iso)}</span>
}

/** A last sign-in, kept to the day (UTC): "today", "yesterday", "3 days ago", then a date. */
function OnDay({ iso, never }: { iso: string | null; never: string }) {
  if (!iso) return <span className="text-muted">{never}</span>
  return <span title={utcDate(iso)}>{daysAgo(iso)}</span>
}

function UsersTable({
  users,
  blocked,
  onImpersonate,
}: {
  users: AdminUser[]
  blocked: (u: AdminUser) => string | null
  onImpersonate: (u: AdminUser) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Created</th>
            <th>Last sign-in</th>
            <th className="text-right">Sites</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => {
            const why = blocked(u)
            return (
              <tr key={u.email}>
                <td className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{u.name}</span>
                    {u.admin && <span className="badge badge-sm badge-outline">Admin</span>}
                    {u.guest && (
                      <span
                        className="badge badge-sm badge-ghost"
                        title="Invited from outside by a share or a group: reviews only what is shared with them"
                      >
                        Guest
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-secondary">{u.email}</div>
                </td>
                <td className="text-secondary">
                  <When iso={u.createdAt} />
                </td>
                <td className="text-secondary">
                  <OnDay iso={u.lastSignInAt} never="Unknown" />
                </td>
                <td className="text-right">
                  <Link
                    className="link link-hover text-sm"
                    to={allSitesOf(u.email)}
                    aria-label={`Sites ${u.email} owns or publishes`}
                  >
                    Sites
                  </Link>
                </td>
                <td className="text-right">
                  {why ? (
                    <span className="text-xs text-muted">{why}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onImpersonate(u)}
                    >
                      <EyeIcon className="size-4" />
                      Impersonate
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminUsers() {
  const { data: me } = useMe()
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim().toLowerCase())
  const users = useAdminUsers(q, showsAdmin(me))
  const { start } = useImpersonation()
  const [pending, setPending] = useState<AdminUser | null>(null)

  if (!me || !showsAdmin(me)) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }
  const rows = users.data?.pages.flatMap(p => p.users) ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Users"
          description="Everyone who has signed in to this instance. Impersonate someone to see and do what they do, for up to an hour."
        />
      </div>

      <section className="space-y-3">
        <label className="input input-sm w-full sm:w-80">
          <MagnifyingGlassIcon className="size-4 text-muted" />
          <input
            type="search"
            placeholder="Email starts with…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search users by email"
          />
        </label>
        <div className="surface-panel !p-0 overflow-clip">
          {users.isPending ? (
            <div className="p-6 text-center">
              <span className="loading loading-spinner loading-sm text-muted" />
            </div>
          ) : users.isError ? (
            <div className="p-6 text-sm text-error">{errorMessage(users.error)}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-secondary">
              <UsersIcon className="mx-auto mb-2 size-6 text-muted" />
              {q ? `No users' email starts with “${q}”.` : 'No users yet.'}
            </div>
          ) : (
            <UsersTable
              users={rows}
              blocked={u => impersonateBlocked(me, u)}
              onImpersonate={setPending}
            />
          )}
        </div>
        {users.hasNextPage && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => users.fetchNextPage()}
            disabled={users.isFetchingNextPage}
          >
            {users.isFetchingNextPage ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'Load more'
            )}
          </button>
        )}
      </section>

      <ConfirmModal
        isOpen={pending !== null}
        title={`Impersonate ${pending?.name ?? ''}?`}
        message={
          <div className="space-y-2">
            <p>
              You will see Fling as <strong>{pending?.email}</strong> sees it, and what you do to
              their sites and comments is done as them, for up to an hour.
            </p>
            <p className="text-sm text-secondary">
              You can't create CLI logins or connect apps for them. This is recorded, with your
              email.
            </p>
          </div>
        }
        confirmText="Impersonate"
        confirmButtonClass="btn-warning"
        isLoading={start.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) start.mutate(pending.email, { onError: () => setPending(null) })
        }}
      />
    </div>
  )
}
