/**
 * Admin → Invitations (`/admin/invitations`; admins only, on an instance with the `invites`
 * capability; the API answers 404 to anyone else): invite someone outside the email policy as a
 * member, which emails them a sign-in link at once; the invitation directory, searched by address
 * prefix and paged, with each person's role (a guest came in by a share or a group), who invited
 * them, and whether they have signed in; and Revoke, with a confirmation, which ends their access
 * on their next request.
 */
import type { AdminInvitation } from '@fling/shared'
import {
  EnvelopeIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  UserPlusIcon,
} from '@heroicons/react/24/outline'
import { type FormEvent, useDeferredValue, useState } from 'react'
import { AdminTabs } from '../components/AdminTabs'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import { useAdminInvitations, useInvitationActions, useMe } from '../hooks/queries'
import { invitationStatus, showsInvitationsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'

const VIA: Record<AdminInvitation['via'], string> = {
  admin: 'by an admin',
  share: 'by a share',
  group: 'by a group',
}

function InviteForm() {
  const [email, setEmail] = useState('')
  const { invite } = useInvitationActions()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const to = email.trim()
    if (to) invite.mutate(to, { onSuccess: r => r.sent && setEmail('') })
  }
  const result = invite.data
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Invite someone</h2>
        <p className="text-sm text-secondary">
          They join as a member, like anyone the sign-in allowlist admits, and get an email with a
          sign-in link that works once, within 7 days. A guest invited this way becomes a member.
        </p>
      </div>
      <div className="surface-panel space-y-3">
        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <label className="input input-sm min-w-0 flex-1 basis-64">
            <EnvelopeIcon className="size-4 text-muted" />
            <input
              type="email"
              required
              placeholder="someone@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              aria-label="Invite this address"
            />
          </label>
          <button type="submit" className="btn btn-sm btn-primary" disabled={invite.isPending}>
            {invite.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <PaperAirplaneIcon className="size-4" />
            )}
            Invite
          </button>
        </form>
        {invite.isError && (
          <div role="alert" className="alert alert-error text-sm">
            {errorMessage(invite.error)}
          </div>
        )}
        {result &&
          (result.sent ? (
            <div role="status" className="alert alert-success text-sm">
              Invited {result.invitation.email}: the sign-in link is on its way.
            </div>
          ) : (
            <div role="alert" className="alert alert-warning text-sm">
              Invited {result.invitation.email}, but the email was not sent: {result.error}
            </div>
          ))}
      </div>
    </section>
  )
}

function When({ iso }: { iso: string }) {
  return <span title={fullDate(iso)}>{timeAgo(iso)}</span>
}

function InvitationsTable({
  invitations,
  onRevoke,
}: {
  invitations: AdminInvitation[]
  onRevoke: (i: AdminInvitation) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Address</th>
            <th>Invited</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations.map(i => (
            <tr key={i.email}>
              <td className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{i.email}</span>
                  <span
                    className={`badge badge-sm ${i.role === 'guest' ? 'badge-ghost' : 'badge-outline'}`}
                  >
                    {i.role === 'guest' ? 'Guest' : 'Member'}
                  </span>
                </div>
              </td>
              <td className="text-secondary">
                <div className="truncate text-xs">
                  {VIA[i.via]}, {i.invitedBy}
                </div>
                <div className="text-xs">
                  <When iso={i.createdAt} />
                </div>
              </td>
              <td className="text-secondary text-sm">
                {invitationStatus(i)}
                {i.revokedAt && (
                  <span className="text-xs">
                    {' '}
                    <When iso={i.revokedAt} />
                  </span>
                )}
              </td>
              <td className="text-right">
                {!i.revokedAt && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onRevoke(i)}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminInvitations() {
  const { data: me } = useMe()
  const instance = useInstance()
  const shown = showsInvitationsAdmin(me, instance)
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim().toLowerCase())
  const list = useAdminInvitations(q, shown)
  const { revoke } = useInvitationActions()
  const [pending, setPending] = useState<AdminInvitation | null>(null)

  if (!shown) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins, on an instance with outside invitations on.'}
      </div>
    )
  }
  const rows = list.data?.pages.flatMap(p => p.invitations) ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <AdminTabs />
        <PageHeader
          title="Invitations"
          description="People from outside the sign-in allowlist: members an admin invited, and guests who came in by a share or a group and review only what is shared with them."
        />
      </div>

      <InviteForm />

      <section className="space-y-3">
        <label className="input input-sm w-full sm:w-80">
          <MagnifyingGlassIcon className="size-4 text-muted" />
          <input
            type="search"
            placeholder="Address starts with…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search invitations by address"
          />
        </label>
        <div className="surface-panel !p-0 overflow-clip">
          {list.isPending ? (
            <div className="p-6 text-center">
              <span className="loading loading-spinner loading-sm text-muted" />
            </div>
          ) : list.isError ? (
            <div className="p-6 text-sm text-error">{errorMessage(list.error)}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-secondary">
              <UserPlusIcon className="mx-auto mb-2 size-6 text-muted" />
              {q ? `No invited address starts with “${q}”.` : 'Nobody has been invited yet.'}
            </div>
          ) : (
            <InvitationsTable invitations={rows} onRevoke={setPending} />
          )}
        </div>
        {list.hasNextPage && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'Load more'
            )}
          </button>
        )}
      </section>

      <ConfirmModal
        isOpen={pending !== null}
        title={`Revoke ${pending?.email ?? ''}'s invitation?`}
        message={
          <div className="space-y-2">
            <p>
              <strong>{pending?.email}</strong> can no longer sign in, and their sessions, API keys
              and app connections stop working on their next request.
            </p>
            <p className="text-sm text-secondary">
              The invitation is kept as the record. Someone may share with them again later, which
              invites them again as a guest. This is recorded, with your email.
            </p>
          </div>
        }
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={revoke.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) revoke.mutate(pending.email, { onSettled: () => setPending(null) })
        }}
      />
    </div>
  )
}
