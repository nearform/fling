/**
 * The owners and publishers lists of a site or of one of its Paths: each list is people and groups
 * (`PeoplePicker`), saved whole on every change, read-only unless `editable`. A refusal shows
 * under the list it came from (`last_owner`, refused addresses, unknown groups). Taking yourself
 * out of the owners asks first (`leave`), as you may lose what the role gave you; naming a group
 * trusts whoever manages it, so the lists say so.
 */
import {
  OWNER_EMAILS_MAX,
  OWNER_GROUPS_MAX,
  PUBLISHER_EMAILS_MAX,
  PUBLISHER_GROUPS_MAX,
  type SiteRoleInput,
  type SiteRoleMembers,
} from '@fling/shared'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { type ReactNode, useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useMe } from '../../hooks/queries'
import { ApiError } from '../../lib/api'
import { peopleErrorMessage } from '../../lib/audience'
import { ConfirmModal } from '../ConfirmModal'
import { PeoplePicker } from '../PeoplePicker'

type Which = 'owners' | 'publishers'
type List = { emails: string[]; groups: string[] }

/** What each list is for, and a hint under it. */
export interface RoleCopy {
  description: string
  hint?: ReactNode
}

/** Why a role change was refused (the server names the addresses and groups it refused). */
function roleErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'last_owner') {
    return 'The site needs at least one person as an owner: add another before removing the last.'
  }
  return peopleErrorMessage(error)
}

export function RoleLists({
  owners,
  publishers,
  editable,
  busy,
  save,
  copy,
  groupWarning,
  leave,
}: {
  owners: SiteRoleMembers
  publishers: SiteRoleMembers
  editable: boolean
  busy: boolean
  /** saves the whole new list; rejects with the server's refusal */
  save: (change: { owners?: SiteRoleInput; publishers?: SiteRoleInput }) => Promise<unknown>
  copy: Record<Which, RoleCopy>
  /** under the lists while groups can be named */
  groupWarning: string
  /** asked before the reader takes themselves out of the owners; `after` runs once they have */
  leave?: { title: string; message: string; after: () => void }
}) {
  const instance = useInstance()
  const groupsOn = instance?.capabilities.groups === true
  const { data: me } = useMe()
  const [problems, setProblems] = useState<Record<Which, string | null>>({
    owners: null,
    publishers: null,
  })
  /** The owners without the user, waiting for them to confirm. */
  const [leaving, setLeaving] = useState<List | null>(null)
  const setProblem = (which: Which) => (problem: string | null) =>
    setProblems(p => ({ ...p, [which]: problem }))

  const commit = async (which: Which, next: List): Promise<boolean> => {
    setProblem(which)(null)
    try {
      await save({ [which]: next })
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
    if (leave && leaves && next.emails.length > 0) {
      setLeaving(next)
      return false
    }
    return commit('owners', next)
  }

  const lists = [
    {
      which: 'owners' as const,
      title: 'Owners',
      members: owners,
      emailsMax: OWNER_EMAILS_MAX,
      groupsMax: OWNER_GROUPS_MAX,
      onChange: changeOwners,
    },
    {
      which: 'publishers' as const,
      title: 'Publishers',
      members: publishers,
      emailsMax: PUBLISHER_EMAILS_MAX,
      groupsMax: PUBLISHER_GROUPS_MAX,
      onChange: (next: List) => commit('publishers', next),
    },
  ]

  return (
    <>
      {lists.map(list => (
        <div key={list.which} className="flex flex-col gap-1.5">
          <div>
            <h3 className="text-sm font-medium">{list.title}</h3>
            <p className="text-xs text-muted">{copy[list.which].description}</p>
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
            hint={copy[list.which].hint}
          />
        </div>
      ))}
      {editable && groupsOn && (
        <p className="flex items-start gap-1 text-xs text-muted">
          <ExclamationTriangleIcon className="mbs-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {groupWarning}
        </p>
      )}
      {leave && (
        <ConfirmModal
          isOpen={leaving !== null}
          title={leave.title}
          message={leave.message}
          confirmText="Remove me"
          confirmButtonClass="btn-warning"
          isLoading={busy}
          onCancel={() => setLeaving(null)}
          onConfirm={async () => {
            const next = leaving
            setLeaving(null)
            if (next && (await commit('owners', next))) leave.after()
          }}
        />
      )}
    </>
  )
}
