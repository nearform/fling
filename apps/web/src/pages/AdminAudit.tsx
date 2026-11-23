/**
 * Admin → Audit (`/admin/audit`; admins only, the API answers 404 to anyone else): the
 * latest entries of the audit log (audit.ts), newest first: impersonations, invitations, admins'
 * changes to other people's sites and what they opened of restricted ones, and the route table
 * format chosen.
 */
import type { AuditEntry } from '@fling/shared'
import { PageHeader } from '../components/PageHeader'
import { useAdminAudit, useMe } from '../hooks/queries'
import { showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'

function When({ iso }: { iso: string }) {
  return <span title={fullDate(iso)}>{timeAgo(iso)}</span>
}

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  'impersonation.start': 'started impersonating',
  'impersonation.stop': 'stopped impersonating',
  'invitation.create': 'invited',
  'invitation.revoke': 'revoked the invitation of',
  'site.change': 'changed',
  'site.open': 'opened',
  'site.server_published': 'published a site server on',
  'viewer.resolved': 'resolved a viewer id on',
  'routes.format': 'chose the route table format',
  'usage.view_counting': 'turned view counting',
}

/** What an admin did to someone else's site (a policy action), as a verb for its name. */
const CHANGE_LABEL: Record<string, string> = {
  'site.visibility': 'changed who can open',
  'site.audience': 'changed the audience of',
  'site.settings': 'changed the settings of',
  'site.archive': 'archived or unarchived',
  'site.rollback': 'rolled back',
  'site.delete': 'deleted',
  'share.create': 'made a share link for',
  'share.revoke': 'revoked the share link of',
  'comment.delete': 'deleted a comment on',
}

const labelOf = (e: AuditEntry) => (e.change && CHANGE_LABEL[e.change]) ?? ACTION_LABEL[e.action]

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
                <span className="font-medium">{e.actor}</span> {labelOf(e)}{' '}
                <span className="font-medium">{e.target}</span>
                {e.owner && <span className="text-secondary">, {e.owner}’s site</span>}
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

export default function AdminAudit() {
  const { data: me } = useMe()

  if (!me || !showsAdmin(me)) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Audit"
          description="What admins did, kept for 180 days: every impersonation's start and stop, every invitation made or revoked, what they changed on other people's sites or opened of their restricted ones, and the route table format they chose."
        />
      </div>
      <AuditLog />
    </div>
  )
}
