/**
 * Picking people and groups for a list on a site: its audience (`SiteAccess`) or its owners and
 * publishers (`SiteTeam`). `GroupPicker` is the groups a list names, each opening in the group
 * editor (with Edit for the user's own), a picker over every group on the instance (any member may
 * name any group) up to the list's cap, and "New group". `PeoplePicker` is a whole list: the
 * addresses (each marked until it has signed in, and as a guest), the groups, and the address
 * field; every change sends the whole list to `onChange`, which saves it and says whether it was
 * taken. Read-only, it lists them with nothing to change.
 */
import type { AudienceEmail, AudienceGroup } from '@fling/shared'
import { PlusIcon } from '@heroicons/react/24/outline'
import { type ReactNode, useId, useState } from 'react'
import { useGroups, useMe } from '../hooks/queries'
import { addEmails, peopleLabel } from '../lib/audience'
import { EmailAdder } from './EmailAdder'
import { EmailBadge } from './EmailBadge'
import { GroupChip } from './GroupChip'
import { GroupEditor, type GroupEditorTarget } from './GroupEditor'

export function GroupPicker({
  named,
  max,
  listLabel,
  busy,
  onChange,
  onOpen,
  onNew,
}: {
  named: readonly AudienceGroup[]
  /** the most groups the list names */
  max: number
  /** what the list of groups is, for assistive technology: "Groups who can open it" */
  listLabel: string
  busy: boolean
  onChange: (slugs: string[]) => void
  onOpen: (slug: string) => void
  onNew: () => void
}) {
  const all = useGroups(false)
  const { data: me } = useMe()
  const slugs = named.map(g => g.slug)
  const choices = (all.data ?? []).filter(g => !slugs.includes(g.slug))
  const owned = new Set((all.data ?? []).filter(g => g.owner === me?.email).map(g => g.slug))
  const full = slugs.length >= max
  const id = useId()

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {named.length > 0 && (
        <ul className="contents" aria-label={listLabel}>
          {named.map(g => (
            <li key={g.slug} className="max-w-full">
              <GroupChip
                name={g.name}
                size={g.size}
                deleted={g.deleted}
                onOpen={() => onOpen(g.slug)}
                onEdit={owned.has(g.slug) ? () => onOpen(g.slug) : undefined}
                onRemove={() => onChange(slugs.filter(s => s !== g.slug))}
                removeLabel={g.deleted ? 'Remove the deleted group' : `Remove the group ${g.name}`}
                disabled={busy}
              />
            </li>
          ))}
        </ul>
      )}
      {!full && choices.length > 0 && (
        <>
          <label htmlFor={`${id}-group`} className="sr-only">
            Add a group
          </label>
          <select
            id={`${id}-group`}
            className="select select-sm w-auto"
            value=""
            disabled={busy}
            onChange={e => e.target.value && onChange([...slugs, e.target.value])}
          >
            <option value="">Add a group…</option>
            {choices.map(g => (
              <option key={g.slug} value={g.slug}>
                {`${g.name}${g.name !== g.slug ? ` (${g.slug})` : ''} · ${peopleLabel(g.size)}`}
              </option>
            ))}
          </select>
        </>
      )}
      <button type="button" className="btn btn-xs btn-ghost" onClick={onNew}>
        <PlusIcon className="h-3.5 w-3.5" aria-hidden />
        New group
      </button>
      {full && <span className="text-xs text-muted">A site can name at most {max} groups.</span>}
    </div>
  )
}

export function PeoplePicker({
  emails: listed,
  named,
  emailsMax,
  groupsMax,
  groupsOn,
  what,
  busy,
  readOnly = false,
  problem,
  onProblem,
  onChange,
  hint,
}: {
  emails: readonly AudienceEmail[]
  named: readonly AudienceGroup[]
  emailsMax: number
  groupsMax: number
  groupsOn: boolean
  /** what the list holds, for labels: "owners", "publishers" */
  what: string
  busy: boolean
  /** only list them: nothing to add or remove */
  readOnly?: boolean
  problem: string | null
  onProblem: (problem: string | null) => void
  onChange: (next: { emails: string[]; groups: string[] }) => Promise<boolean>
  hint?: ReactNode
}) {
  const emails = listed.map(e => e.email)
  const slugs = named.map(g => g.slug)
  const [draft, setDraft] = useState('')
  const [editor, setEditor] = useState<GroupEditorTarget | null>(null)
  const id = useId()

  const commit = async (next: { emails?: string[]; groups?: string[] }, left: string[] = []) => {
    const taken = await onChange({ emails: next.emails ?? emails, groups: next.groups ?? slugs })
    if (taken) setDraft(left.join(', '))
    return taken
  }

  const add = (text: string) => {
    const { emails: next, invalid, overflow } = addEmails(emails, text, emailsMax)
    const note = overflow.length
      ? `A site has at most ${emailsMax} ${what} addresses.`
      : invalid.length
        ? `Not an email address: ${invalid.join(', ')}`
        : null
    const left = [...invalid, ...overflow]
    if (next.length === emails.length) {
      setDraft(left.join(', '))
      onProblem(note)
      return
    }
    void commit({ emails: next }, left).then(taken => taken && onProblem(note))
  }

  if (readOnly) {
    return listed.length + named.length === 0 ? (
      <p className="text-sm text-muted">Nobody yet.</p>
    ) : (
      <ul className="flex flex-wrap gap-1.5" aria-label={`The site's ${what}`}>
        {listed.map(person => (
          <li key={person.email} className="max-w-full">
            <EmailBadge email={person.email} known={person.known} guest={person.guest} />
          </li>
        ))}
        {named.map(g => (
          <li key={g.slug} className="max-w-full">
            <GroupChip name={g.name} size={g.size} deleted={g.deleted} />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {listed.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`People who are ${what}`}>
          {listed.map(person => (
            <li key={person.email} className="max-w-full">
              <EmailBadge
                email={person.email}
                known={person.known}
                guest={person.guest}
                disabled={busy}
                onRemove={() => void commit({ emails: emails.filter(e => e !== person.email) })}
              />
            </li>
          ))}
        </ul>
      )}
      {groupsOn && (
        <GroupPicker
          named={named}
          max={groupsMax}
          listLabel={`Groups who are ${what}`}
          busy={busy}
          onChange={groups => void commit({ groups })}
          onOpen={slug => setEditor({ mode: 'open', slug })}
          onNew={() => setEditor({ mode: 'create' })}
        />
      )}
      <EmailAdder
        id={id}
        draft={draft}
        onDraftChange={setDraft}
        onAdd={add}
        busy={busy}
        problem={problem}
        hint={hint}
        label={`Add ${what} by email`}
        membersOnly
      />
      <GroupEditor
        target={editor}
        onClose={() => setEditor(null)}
        offer={() =>
          groupsOn && slugs.length < groupsMax ? { label: `Make this group ${what}` } : null
        }
        onCreated={(group, accepted) => {
          if (accepted) void commit({ groups: [...slugs, group.slug] })
        }}
      />
    </div>
  )
}
