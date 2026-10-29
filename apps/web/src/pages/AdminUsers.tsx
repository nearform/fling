/**
 * Admin → Users (admins only; the API answers 404 to anyone else): every user of the instance, by
 * email, searched by email prefix and paged with "Load more"; Impersonate (with a confirmation)
 * on everyone but yourself and other admins; guests marked (invited from outside by a share or a
 * group); and the latest impersonations and invitations, from the audit log.
 */
import type { AdminUser, AuditEntry } from '@fling/shared'
import { EyeIcon, MagnifyingGlassIcon, UsersIcon } from '@heroicons/react/24/outline'
import { useDeferredValue, useState } from 'react'
import { AdminTabs } from '../components/AdminTabs'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader } from '../components/PageHeader'
import { useAdminAudit, useAdminUsers, useImpersonation, useMe } from '../hooks/queries'
import { impersonateBlocked, showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'

function When({ iso, never = '—' }: { iso: string | null; never?: string }) {
  if (!iso) return <span className="text-muted">{never}</span>
  return <span title={fullDate(iso)}>{timeAgo(iso)}</span>
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
                  <When iso={u.lastSignInAt} never="Unknown" />
                </td>
                <td className="text-right tabular-nums">{u.siteCount}</td>
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

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  'impersonation.start': 'started impersonating',
  'impersonation.stop': 'stopped impersonating',
  'invitation.create': 'invited',
  'invitation.revoke': 'revoked the invitation of',
}

/** How an invitation came about, after its target: " as a guest, by sharing". */
function invitedHow(e: AuditEntry): string {
  if (e.action !== 'invitation.create') return ''
  const role = e.role === 'guest' ? ' as a guest' : e.role === 'member' ? ' as a member' : ''
  const via = e.via === 'share' ? ', by sharing a site' : e.via === 'group' ? ', by a group' : ''
  return `${role}${via}`
}

function AuditLog() {
  const audit = useAdminAudit()
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Recent activity</h2>
        <p className="text-sm text-secondary">
          Every impersonation's start and stop, and every invitation made or revoked, kept for 180
          days.
        </p>
      </div>
      <div className="surface-panel">
        {audit.isPending ? (
          <span className="loading loading-spinner loading-sm text-muted" />
        ) : audit.isError ? (
          <p className="text-sm text-error">{errorMessage(audit.error)}</p>
        ) : audit.data.length === 0 ? (
          <p className="text-sm text-secondary">Nothing yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {audit.data.map(e => (
              <li key={e.id}>
                <span className="font-medium">{e.actor}</span> {ACTION_LABEL[e.action]}{' '}
                <span className="font-medium">{e.target}</span>
                {invitedHow(e)}
                {e.lapsed && <span className="text-secondary"> (it had lapsed)</span>}
                <span className="text-secondary">
                  {' · '}
                  <When iso={e.at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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
        <AdminTabs />
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

      <AuditLog />

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
