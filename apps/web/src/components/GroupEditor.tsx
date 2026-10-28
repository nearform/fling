/**
 * The group editor: a modal over whatever opened it (the Groups list, a site's Access section).
 *
 * Creating: a name, a slug that follows the name until it is edited by hand, and members, with a
 * note linking to any group that already holds exactly those people. The opener may offer one
 * step after creating (`offer`, a checkbox that starts ticked), such as naming the new group in a
 * site's audience; `onCreated` hears whether it was kept.
 *
 * Opening a group: every member of the instance sees its name, owner and members. Its owner
 * (`canManage`) also renames it, adds and removes members (each change saved at once) and deletes
 * it, after a confirmation, which takes it out of the audiences that name it (a site keeps its
 * restriction).
 */
import {
  GROUP_MEMBERS_MAX,
  GROUP_SLUG_MAX,
  GROUP_SLUG_RULES,
  type GroupDetail,
} from '@fling/shared'
import { ExclamationTriangleIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline'
import { type FormEvent, useId, useState } from 'react'
import { useCreateGroup, useGroup, useGroupActions, useGroupsWithMembers } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'
import { addToGroup, peopleLabel } from '../lib/audience'
import { checkNewGroup, slugFromName } from '../lib/groups'
import { ConfirmModal } from './ConfirmModal'
import { EmailAdder } from './EmailAdder'
import { EmailBadge } from './EmailBadge'
import { Modal } from './Modal'

/** What the editor shows: a new group (optionally with its first members), or one group. */
export type GroupEditorTarget =
  | { mode: 'create'; members?: string[] }
  | { mode: 'open'; slug: string }

/** The step offered after creating, for these members; null: none. */
export type CreateOffer = (members: readonly string[]) => { label: string; hint?: string } | null

export interface GroupEditorProps {
  /** null: closed */
  target: GroupEditorTarget | null
  onClose: () => void
  offer?: CreateOffer
  /** after creating; `accepted`: the offer was shown and kept ticked */
  onCreated?: (group: GroupDetail, accepted: boolean) => void
}

const keyOf = (t: GroupEditorTarget) =>
  t.mode === 'open' ? `open:${t.slug}` : `create:${(t.members ?? []).join(',')}`

export function GroupEditor({ target, ...props }: GroupEditorProps) {
  return target ? <Editor key={keyOf(target)} target={target} {...props} /> : null
}

function Editor({
  target,
  onClose,
  offer,
  onCreated,
}: GroupEditorProps & { target: GroupEditorTarget }) {
  // The create form links to a group that already holds its people: the editor turns to it.
  const [view, setView] = useState(target)
  return view.mode === 'create' ? (
    <CreateGroup
      members={view.members ?? []}
      onClose={onClose}
      onOpenGroup={slug => setView({ mode: 'open', slug })}
      offer={offer}
      onCreated={onCreated}
    />
  ) : (
    <OpenGroup slug={view.slug} onClose={onClose} />
  )
}

function CreateGroup({
  members: initial,
  onClose,
  onOpenGroup,
  offer,
  onCreated,
}: {
  members: string[]
  onClose: () => void
  onOpenGroup: (slug: string) => void
  offer?: CreateOffer
  onCreated?: (group: GroupDetail, accepted: boolean) => void
}) {
  const create = useCreateGroup()
  const id = useId()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [members, setMembers] = useState<string[]>(initial)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [membersProblem, setMembersProblem] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(true)
  const twins = useGroupsWithMembers(members).data ?? []
  const extra = offer?.(members) ?? null

  const add = (text: string) => {
    const { emails, invalid, overflow } = addToGroup(members, text)
    setMembers(emails)
    setDraft([...invalid, ...overflow].join(', '))
    setMembersProblem(
      overflow.length
        ? `A group holds at most ${GROUP_MEMBERS_MAX} people.`
        : invalid.length
          ? `Not an email address: ${invalid.join(', ')}`
          : null
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // What is still in the input counts, as if Add had been pressed.
    const checked = checkNewGroup({ slug, name, members: [...members, draft].join(' ') })
    if (!checked.ok) {
      setProblem(checked.problem)
      return
    }
    setProblem(null)
    const keep = extra !== null && accepted
    create.mutate(
      { slug: checked.slug, name: checked.name, members: checked.members },
      {
        onSuccess: group => {
          onClose()
          onCreated?.(group, keep)
        },
        onError: error => setProblem(errorMessage(error)),
      }
    )
  }

  return (
    <Modal open onClose={onClose} title="New group" className="max-w-lg">
      <form id={`${id}-form`} className="space-y-3" onSubmit={submit}>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-base-content">Name</span>
          <input
            className="input input-sm w-full"
            value={name}
            autoComplete="off"
            placeholder="Design team"
            onChange={e => {
              setName(e.target.value)
              if (!slugEdited) setSlug(slugFromName(e.target.value))
            }}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-base-content">Slug</span>
          <input
            className="input input-sm w-full font-mono"
            value={slug}
            maxLength={GROUP_SLUG_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder="design"
            aria-describedby={`${id}-slug-help`}
            onChange={e => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
          />
          <span id={`${id}-slug-help`} className="block text-xs text-muted">
            How the CLI and Claude name it: {GROUP_SLUG_RULES}. It can't be changed later.
          </span>
        </label>
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-base-content">
            Members {members.length > 0 && <span className="text-muted">· {members.length}</span>}
          </span>
          {members.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Members">
              {members.map(email => (
                <li key={email} className="max-w-full">
                  <EmailBadge
                    email={email}
                    onRemove={() => setMembers(members.filter(m => m !== email))}
                  />
                </li>
              ))}
            </ul>
          )}
          <EmailAdder
            id={id}
            label="Add members by email"
            draft={draft}
            onDraftChange={setDraft}
            onAdd={add}
            busy={create.isPending}
            problem={membersProblem}
            hint={members.length === 0 ? 'You can add people later too.' : undefined}
          />
          {twins.length > 0 && (
            <p className="tone-warning flex items-start gap-1.5 rounded-box border px-2.5 py-1.5 text-xs">
              <ExclamationTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {twins.length === 1
                  ? 'A group with exactly these people already exists: '
                  : 'Groups with exactly these people already exist: '}
                {twins.map((g, i) => (
                  <span key={g.slug}>
                    {i > 0 && ', '}
                    <button
                      type="button"
                      className="link font-semibold"
                      onClick={() => onOpenGroup(g.slug)}
                    >
                      {g.name}
                    </button>
                  </span>
                ))}
                . You can use it instead of making another.
              </span>
            </p>
          )}
        </div>
        {extra && (
          <label className="flex cursor-pointer items-start gap-2 text-sm text-base-content">
            <input
              type="checkbox"
              className="checkbox checkbox-sm checkbox-primary mt-0.5"
              checked={accepted}
              onChange={e => setAccepted(e.target.checked)}
            />
            <span>
              {extra.label}
              {extra.hint && <span className="block text-xs text-muted">{extra.hint}</span>}
            </span>
          </label>
        )}
        {problem && (
          <p className="text-sm text-error" role="alert">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            disabled={create.isPending}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={create.isPending}>
            {create.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              'Create group'
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function OpenGroup({ slug, onClose }: { slug: string; onClose: () => void }) {
  const detail = useGroup(slug, true)
  const [deleting, setDeleting] = useState(false)
  const group = detail.data

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={group?.name ?? 'Group'}
        className="max-w-lg"
        actions={
          <div className="flex w-full items-center justify-between gap-2">
            {group?.canManage ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost text-error"
                onClick={() => setDeleting(true)}
              >
                <TrashIcon className="h-4 w-4" aria-hidden />
                Delete…
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Done
            </button>
          </div>
        }
      >
        {detail.isPending ? (
          <div className="grid place-items-center py-6">
            <span
              className="loading loading-spinner loading-sm text-muted"
              role="status"
              aria-label="Loading"
            />
          </div>
        ) : detail.isError ? (
          detail.error instanceof ApiError && detail.error.status === 404 ? (
            <p>No group is called “{slug}”. Its owner may have deleted it.</p>
          ) : (
            <div className="flex items-center justify-between gap-3 text-error" role="alert">
              {errorMessage(detail.error)}
              <button type="button" className="btn btn-sm" onClick={() => detail.refetch()}>
                Try again
              </button>
            </div>
          )
        ) : group ? (
          <GroupBody group={group} />
        ) : null}
      </Modal>
      {/* A sibling, not a child: a dialog's close event would otherwise reach the editor's own. */}
      {group?.canManage && (
        <DeleteGroup
          group={group}
          open={deleting}
          onCancel={() => setDeleting(false)}
          onDeleted={onClose}
        />
      )}
    </>
  )
}

function GroupBody({ group }: { group: GroupDetail }) {
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        <span className="font-mono">{group.slug}</span>
        <span aria-hidden>·</span>
        <span>{peopleLabel(group.size)}</span>
        <span aria-hidden>·</span>
        {group.canManage ? (
          <span>Owned by you</span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1">
            Owned by <EmailBadge email={group.owner} size="sm" />
          </span>
        )}
      </p>
      {group.canManage && <GroupName group={group} />}
      <GroupMembers group={group} />
      {!group.canManage && (
        <p className="text-xs text-muted">
          Only its owner can change this group. You can still limit your sites to it.
        </p>
      )}
    </div>
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
    <form className="space-y-1" onSubmit={submit}>
      <label htmlFor={`${id}-name`} className="block text-sm font-medium text-base-content">
        Name
      </label>
      <div className="flex gap-1.5">
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
      </div>
    </form>
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
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-base-content">Members</span>
      {group.members.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Members">
          {group.members.map(person => (
            <li key={person.email} className="max-w-full">
              <EmailBadge
                email={person.email}
                known={person.known}
                disabled={changeMembers.isPending}
                onRemove={group.canManage ? () => remove(person.email) : undefined}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p>No members yet.</p>
      )}
      {group.canManage && (
        <EmailAdder
          id={id}
          label="Add members by email"
          draft={draft}
          onDraftChange={setDraft}
          onAdd={add}
          busy={changeMembers.isPending}
          problem={problem}
          hint="Someone you remove can still open the group's sites for up to 5 minutes."
        />
      )}
    </div>
  )
}

function DeleteGroup({
  group,
  open,
  onCancel,
  onDeleted,
}: {
  group: GroupDetail
  open: boolean
  onCancel: () => void
  onDeleted: () => void
}) {
  const { remove } = useGroupActions(group.slug)
  return (
    <ConfirmModal
      isOpen={open}
      title={`Delete ${group.name}?`}
      message="Sites whose audience names this group keep their restriction, and anyone it let in loses access. A site limited to this group alone stays open to its owner only, until they change who can see it."
      confirmText="Delete group"
      confirmButtonClass="btn-error"
      isLoading={remove.isPending}
      onCancel={onCancel}
      onConfirm={() =>
        remove.mutate(undefined, {
          onSuccess: () => {
            onCancel()
            onDeleted()
          },
          onError: onCancel,
        })
      }
    />
  )
}
