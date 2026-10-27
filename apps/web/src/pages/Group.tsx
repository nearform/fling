/**
 * One group: its name, owner and members. Every member of the instance sees it; its owner
 * (`canManage`) also renames it, adds and removes members, and deletes it, which takes it out of
 * the audiences that name it (a site keeps its restriction). An unknown group is the 404 page.
 */
import { GROUP_MEMBERS_MAX, type GroupDetail } from '@fling/shared'
import { PencilSquareIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { type FormEvent, useId, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ConfirmModal } from '../components/ConfirmModal'
import { EmailAdder } from '../components/EmailAdder'
import { NotFound } from '../components/NotFound'
import { PageHeader } from '../components/PageHeader'
import { SiteSection } from '../components/site/SiteSection'
import { useGroup, useGroupActions } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'
import { addToGroup, peopleLabel } from '../lib/audience'

export default function Group() {
  const { slug = '' } = useParams()
  const detail = useGroup(slug, slug !== '')

  if (detail.isPending) {
    return (
      <div className="grid place-items-center py-12">
        <span
          className="loading loading-spinner loading-md text-muted"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />
    return (
      <div className="mx-auto max-w-4xl">
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(detail.error)}
          <button type="button" className="btn btn-sm" onClick={() => detail.refetch()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const group = detail.data
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        breadcrumbs={[{ to: '/groups', label: 'Groups' }]}
        title={group.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span className="font-mono">{group.slug}</span>
            <span aria-hidden>·</span>
            <span>{peopleLabel(group.size)}</span>
            <span aria-hidden>·</span>
            <span className="break-all">
              {group.canManage ? 'Owned by you' : `Owned by ${group.owner}`}
            </span>
          </span>
        }
      />
      <GroupMembers group={group} />
      {group.canManage ? (
        <>
          <GroupName group={group} />
          <GroupDangerZone group={group} />
        </>
      ) : (
        <p className="text-sm text-secondary">
          Only {group.owner} can change this group. You can still limit your sites to it.
        </p>
      )}
    </div>
  )
}

function GroupMembers({ group }: { group: GroupDetail }) {
  const { changeMembers } = useGroupActions(group.slug)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const id = useId()
  const emails = group.members.map(m => m.email)

  const add = (text: string) => {
    const { emails: next, invalid, overflow } = addToGroup(emails, text)
    const note = overflow.length
      ? `A group holds at most ${GROUP_MEMBERS_MAX} people.`
      : invalid.length
        ? `Not an email address: ${invalid.join(', ')}`
        : null
    const left = [...invalid, ...overflow]
    const added = next.slice(emails.length)
    if (added.length === 0) {
      setDraft(left.join(', '))
      setProblem(note)
      return
    }
    changeMembers.mutate(
      { add: added },
      {
        onSuccess: () => {
          setDraft(left.join(', '))
          setProblem(note)
        },
        onError: error => setProblem(errorMessage(error)),
      }
    )
  }

  const remove = (email: string) =>
    changeMembers.mutate(
      { remove: [email] },
      { onSuccess: () => setProblem(null), onError: error => setProblem(errorMessage(error)) }
    )

  return (
    <SiteSection title="Members" description="Who a site limited to this group lets in.">
      {group.members.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Members">
          {group.members.map(person => (
            <li key={person.email} className="badge badge-ghost h-auto gap-1 py-0.5">
              <span className="break-all">{person.email}</span>
              {!person.known && <span className="text-muted">· hasn’t signed in yet</span>}
              {group.canManage && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-circle h-4 min-h-4 w-4"
                  aria-label={`Remove ${person.email}`}
                  title={`Remove ${person.email}`}
                  disabled={changeMembers.isPending}
                  onClick={() => remove(person.email)}
                >
                  <XMarkIcon className="h-3 w-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-secondary">No members yet.</p>
      )}
      {group.canManage && (
        <EmailAdder
          id={id}
          draft={draft}
          onDraftChange={setDraft}
          onAdd={add}
          busy={changeMembers.isPending}
          problem={problem}
          hint="Someone you remove can still open the group's sites for up to 15 minutes."
        />
      )}
    </SiteSection>
  )
}

function GroupName({ group }: { group: GroupDetail }) {
  const { rename } = useGroupActions(group.slug)
  const [name, setName] = useState(group.name)
  const id = useId()
  const trimmed = name.trim()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (trimmed && trimmed !== group.name) rename.mutate(trimmed)
  }

  return (
    <SiteSection title="Name" description="What people see when they pick the group.">
      <form className="flex gap-1.5" onSubmit={submit}>
        <label htmlFor={`${id}-name`} className="sr-only">
          Group name
        </label>
        <input
          id={`${id}-name`}
          className="input input-sm min-w-0 flex-1"
          value={name}
          autoComplete="off"
          onChange={e => setName(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-sm"
          disabled={!trimmed || trimmed === group.name || rename.isPending}
        >
          <PencilSquareIcon className="h-4 w-4" aria-hidden />
          Rename
        </button>
      </form>
    </SiteSection>
  )
}

function GroupDangerZone({ group }: { group: GroupDetail }) {
  const { remove } = useGroupActions(group.slug)
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)

  return (
    <SiteSection title="Danger zone" tone="danger">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-secondary">
          Delete removes the group. Sites whose audience names it keep their restriction, and anyone
          it let in loses access.
        </p>
        <button
          type="button"
          className="btn btn-sm btn-outline btn-error"
          onClick={() => setConfirming(true)}
        >
          <TrashIcon className="h-4 w-4" aria-hidden />
          Delete…
        </button>
      </div>
      <ConfirmModal
        isOpen={confirming}
        title={`Delete ${group.name}?`}
        message="Sites whose audience names this group keep their restriction, and anyone it let in loses access. A site limited to this group alone stays open to its owner only, until they change who can see it."
        confirmText="Delete group"
        confirmButtonClass="btn-error"
        isLoading={remove.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => navigate('/groups'),
            onSettled: () => setConfirming(false),
          })
        }
      />
    </SiteSection>
  )
}
