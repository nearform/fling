/**
 * Groups: every group on the instance, or only yours (kept in `?mine=1`). A row opens the group
 * in the group editor, kept in `?edit=<slug>` so it can be linked to; "New group" opens the editor
 * to make one, and then shows it. Any member may use any group in a site's audience; only its
 * owner changes it.
 */
import { PlusIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EmailBadge } from '../components/EmailBadge'
import { GroupEditor, type GroupEditorTarget } from '../components/GroupEditor'
import { PageHeader } from '../components/PageHeader'
import { useGroups, useMe } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import { peopleLabel } from '../lib/audience'

export default function Groups() {
  const [params, setParams] = useSearchParams()
  const mine = params.get('mine') === '1'
  const list = useGroups(mine)
  const { data: me } = useMe()
  const editing = params.get('edit')
  const [creating, setCreating] = useState(false)
  const target: GroupEditorTarget | null = creating
    ? { mode: 'create' }
    : editing
      ? { mode: 'open', slug: editing }
      : null

  const setParam = (key: string, value: string | null, replace = true) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev)
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace }
    )
  const setMine = (next: boolean) => setParam('mine', next ? '1' : null)
  /** Opening a group is a step Back undoes; closing it isn't. */
  const open = (slug: string | null) => setParam('edit', slug, slug === null)

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
                      <button
                        type="button"
                        className="link link-hover text-left font-medium"
                        onClick={() => open(g.slug)}
                      >
                        {g.name}
                      </button>
                      {g.name !== g.slug && (
                        <span className="ms-1.5 font-mono text-xs text-secondary">{g.slug}</span>
                      )}
                    </td>
                    <td className="text-secondary">{peopleLabel(g.size)}</td>
                    <td className="max-w-64">
                      {g.owner === me?.email ? (
                        <span className="text-secondary">You</span>
                      ) : (
                        <EmailBadge email={g.owner} size="sm" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <GroupEditor
        target={target}
        onClose={() => (creating ? setCreating(false) : open(null))}
        onCreated={group => open(group.slug)}
      />
    </div>
  )
}
