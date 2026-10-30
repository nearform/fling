/**
 * Who holds the site (the `siteRoles` capability): its owners, who all have every right over it,
 * and its publishers, who publish and roll back but change nothing else. Each list is people and
 * groups (`PeoplePicker`), saved whole on every change, as the Access section's list is. Owners
 * and admins change them; a publisher sees them read-only. A site keeps at least one person as an
 * owner (`last_owner`), and only members of the instance hold a role (`email_not_allowed`), never a
 * guest; naming a group trusts whoever manages it, so the section says so. Taking yourself out of
 * the owners asks first, since the site may then leave your list.
 */
import {
  OWNER_EMAILS_MAX,
  OWNER_GROUPS_MAX,
  PUBLISHER_EMAILS_MAX,
  PUBLISHER_GROUPS_MAX,
  type SiteDetail,
  type SiteRoleMembers,
} from '@fling/shared'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInstance } from '../../hooks/instance'
import { useMe, useSiteActions } from '../../hooks/queries'
import { ApiError } from '../../lib/api'
import { peopleErrorMessage } from '../../lib/audience'
import { DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { ConfirmModal } from '../ConfirmModal'
import { PeoplePicker } from '../PeoplePicker'
import { SiteSection } from './SiteSection'

type Which = 'owners' | 'publishers'
type List = { emails: string[]; groups: string[] }

/** Why a role change was refused (the server names the addresses and groups it refused). */
function roleErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'last_owner') {
    return 'The site needs at least one person as an owner: add another before removing the last.'
  }
  return peopleErrorMessage(error)
}

export function SiteTeam({ site }: { site: SiteDetail }) {
  const instance = useInstance()
  const instanceName = instance?.name ?? DEFAULT_INSTANCE_NAME
  const groupsOn = instance?.capabilities.groups === true
  const actions = useSiteActions(site.name)
  const { data: me } = useMe()
  const navigate = useNavigate()
  const [problems, setProblems] = useState<Record<Which, string | null>>({
    owners: null,
    publishers: null,
  })
  /** The owners without the user, waiting for them to confirm. */
  const [leaving, setLeaving] = useState<List | null>(null)
  if (!site.owners) return null
  const owners = site.owners
  const publishers: SiteRoleMembers = site.publishers ?? { emails: [], groups: [] }
  const editable = site.role === 'owner' || site.role === 'admin'
  const busy = actions.setRoles.isPending
  const setProblem = (which: Which) => (problem: string | null) =>
    setProblems(p => ({ ...p, [which]: problem }))

  const save = async (which: Which, next: List): Promise<boolean> => {
    setProblem(which)(null)
    try {
      await actions.setRoles.mutateAsync({ [which]: next })
      return true
    } catch (error) {
      setProblem(which)(roleErrorMessage(error))
      return false
    }
  }

  const changeOwners = async (next: List) => {
    const mine = me?.email
    // Asked only when someone else stays an owner: otherwise the server refuses (`last_owner`).
    const leaves = mine && owners.emails.some(e => e.email === mine) && !next.emails.includes(mine)
    if (leaves && next.emails.length > 0) {
      setLeaving(next)
      return false
    }
    return save('owners', next)
  }

  const lists = [
    {
      which: 'owners' as const,
      title: 'Owners',
      description:
        'Publish, change who can open it and its settings, its owners and publishers, and delete it.',
      members: owners,
      emailsMax: OWNER_EMAILS_MAX,
      groupsMax: OWNER_GROUPS_MAX,
      onChange: changeOwners,
      hint: 'A site always keeps at least one person as an owner.',
    },
    {
      which: 'publishers' as const,
      title: 'Publishers',
      description: 'Publish new versions and roll back, but change nothing else.',
      members: publishers,
      emailsMax: PUBLISHER_EMAILS_MAX,
      groupsMax: PUBLISHER_GROUPS_MAX,
      onChange: (next: List) => save('publishers', next),
      hint: 'Someone who is also an owner stays an owner.',
    },
  ]

  return (
    <SiteSection
      title="Owners and publishers"
      description={
        editable
          ? `Only people who can sign in to ${instanceName} may own or publish this site.`
          : 'You publish this site. Its owners decide who owns and publishes it.'
      }
    >
      {lists.map(list => (
        <div key={list.which} className="flex flex-col gap-1.5">
          <div>
            <h3 className="text-sm font-medium">{list.title}</h3>
            <p className="text-xs text-muted">{list.description}</p>
          </div>
          <PeoplePicker
            emails={list.members.emails}
            named={list.members.groups}
            emailsMax={list.emailsMax}
            groupsMax={list.groupsMax}
            groupsOn={groupsOn}
            what={list.which}
            busy={busy}
            readOnly={!editable}
            problem={problems[list.which]}
            onProblem={setProblem(list.which)}
            onChange={list.onChange}
            hint={list.hint}
          />
        </div>
      ))}
      {editable && groupsOn && (
        <p className="flex items-start gap-1 text-xs text-muted">
          <ExclamationTriangleIcon className="mbs-px h-3.5 w-3.5 shrink-0" aria-hidden />
          Naming a group trusts whoever manages it: anyone they add to the group owns or publishes
          this site too.
        </p>
      )}
      <ConfirmModal
        isOpen={leaving !== null}
        title="Stop owning this site?"
        message="You will no longer be able to change it, and it leaves your sites unless you publish it or are in one of its groups."
        confirmText="Remove me"
        confirmButtonClass="btn-warning"
        isLoading={busy}
        onCancel={() => setLeaving(null)}
        onConfirm={async () => {
          const next = leaving
          setLeaving(null)
          if (next && (await save('owners', next))) navigate('/')
        }}
      />
    </SiteSection>
  )
}
