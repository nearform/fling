/**
 * Groups: every group on the instance, or only yours (kept in `?mine=1`), each linking to its
 * page, and a form to make one. Any member may use any group in a site's audience; only its owner
 * changes it. A new group's slug follows its name until it is edited by hand.
 */
import { GROUP_SLUG_MAX, GROUP_SLUG_RULES } from '@fling/shared'
import { PlusIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { type FormEvent, useId, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Modal } from '../components/Modal'
import { PageHeader } from '../components/PageHeader'
import { useCreateGroup, useGroups, useMe } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { peopleLabel } from '../lib/audience'
import { checkNewGroup, slugFromName } from '../lib/groups'

export default function Groups() {
  const [params, setParams] = useSearchParams()
  const mine = params.get('mine') === '1'
  const list = useGroups(mine)
  const { data: me } = useMe()
  const [creating, setCreating] = useState(false)

  const setMine = (next: boolean) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev)
        if (next) p.set('mine', '1')
        else p.delete('mine')
        return p
      },
      { replace: true }
    )

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Groups"
        description="Named lists of people to limit a private site to. Anyone signed in can use any group; only its owner can change it."
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="h-4 w-4" aria-hidden />
            New group
          </button>
        }
      />

      <div role="tablist" className="tabs tabs-border" aria-label="Which groups">
        <button
          type="button"
          role="tab"
          aria-selected={!mine}
          className={`tab ${mine ? '' : 'tab-active'}`}
          onClick={() => setMine(false)}
        >
          All
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mine}
          className={`tab ${mine ? 'tab-active' : ''}`}
          onClick={() => setMine(true)}
        >
          Mine
        </button>
      </div>

      <div className="surface-panel !p-0 overflow-hidden">
        {list.isPending ? (
          <div className="p-6 text-center">
            <span
              className="loading loading-spinner loading-sm text-muted"
              role="status"
              aria-label="Loading"
            />
          </div>
        ) : list.isError ? (
          <div className="flex items-center justify-between gap-3 p-6 text-sm text-error">
            {errorMessage(list.error)}
            <button type="button" className="btn btn-sm" onClick={() => list.refetch()}>
              Try again
            </button>
          </div>
        ) : list.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-secondary">
            <UserGroupIcon className="mx-auto mb-2 h-6 w-6 text-muted" aria-hidden />
            {mine ? "You haven't made a group yet." : 'No groups yet.'} Make one to limit a site to
            a team in one step.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Members</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map(g => (
                  <tr key={g.slug}>
                    <td className="text-sm">
                      <Link
                        to={`/groups/${encodeURIComponent(g.slug)}`}
                        className="link link-hover font-medium"
                      >
                        {g.name}
                      </Link>
                      {g.name !== g.slug && (
                        <span className="ml-1.5 font-mono text-xs text-secondary">{g.slug}</span>
                      )}
                    </td>
                    <td className="text-secondary">{peopleLabel(g.size)}</td>
                    <td className="text-secondary break-all">
                      {g.owner === me?.email ? 'You' : g.owner}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewGroupModal open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

/** Slug, name and (optionally) the first members; on success, the new group's page. */
function NewGroupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateGroup()
  const navigate = useNavigate()
  const id = useId()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [members, setMembers] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const close = () => {
    setName('')
    setSlug('')
    setSlugEdited(false)
    setMembers('')
    setProblem(null)
    create.reset()
    onClose()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const checked = checkNewGroup({ slug, name, members })
    if (!checked.ok) {
      setProblem(checked.problem)
      return
    }
    setProblem(null)
    create.mutate(
      { slug: checked.slug, name: checked.name, members: checked.members },
      {
        onSuccess: group => {
          close()
          navigate(`/groups/${encodeURIComponent(group.slug)}`)
        },
        onError: error => setProblem(errorMessage(error)),
      }
    )
  }

  return (
    <Modal open={open} onClose={close} title="New group">
      <form className="space-y-3" onSubmit={submit}>
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
        <label className="block space-y-1">
          <span className="text-sm font-medium text-base-content">Members (optional)</span>
          <textarea
            className="textarea textarea-sm w-full"
            rows={3}
            value={members}
            placeholder="name@example.com, another@example.com"
            onChange={e => setMembers(e.target.value)}
          />
          <span className="block text-xs text-muted">
            Separate addresses with commas, spaces or new lines. You can add more later.
          </span>
        </label>
        {problem && (
          <p className="text-sm text-error" role="alert">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-sm" onClick={close} disabled={create.isPending}>
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
