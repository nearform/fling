/**
 * Who can open the site, as one radio group from narrowest to widest: only you, specific people
 * and teams, everyone signed in, or anyone (the access levels in @fling/shared's access.ts, with
 * `groups` and `people` folded into one option, since one audience holds both). The chosen option
 * is the site's level. Only you, everyone and public save as soon as they are chosen (asking first
 * when that clears a list of people and teams); people and teams opens its pickers beneath it, and
 * a site moving to it saves with Save, since an audience names at least one person or team. While
 * it is the site's level, every edit to the list saves at once, as the rest of the page does. Below
 * the group, a secondary block: the share link (create, copy, refresh, revoke), which opens the
 * site to anyone with the link whatever the level. Refreshing and revoking break the link people
 * already have, so they ask first. Groups open in the group editor from the pickers: to see one,
 * to change one the user owns, or to make one (from scratch, or from the listed people, to use in
 * their place).
 *
 * An instance without the `accessLevels` capability has no "only you": the other options save
 * through `visibility` and `audience` instead.
 */
import {
  type AccessLevel,
  AUDIENCE_EMAILS_MAX,
  AUDIENCE_GROUPS_MAX,
  type AudienceEmail,
  type AudienceGroup,
  allowedAccountsPhrase,
  needsAudience,
  type SiteWithAudience,
  siteAccessLevel,
} from '@fling/shared'
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  NoSymbolIcon,
  PlusIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { useId, useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useGroups, useGroupsWithMembers, useMe, useSiteActions } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { addToAudience, audienceWho, peopleErrorMessage, peopleLabel } from '../../lib/audience'
import { copyText } from '../../lib/clipboard'
import { displayUrl } from '../../lib/format'
import { type AudienceEdit, sameMembers, swapEmailsForGroup } from '../../lib/groups'
import { DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { showToast } from '../../lib/toast'
import { ConfirmModal } from '../ConfirmModal'
import { CopyButton } from '../CopyButton'
import { EmailAdder } from '../EmailAdder'
import { EmailBadge } from '../EmailBadge'
import { GroupChip } from '../GroupChip'
import { type CreateOffer, GroupEditor, type GroupEditorTarget } from '../GroupEditor'
import { SiteSection } from './SiteSection'

/** An option of the radio group: an access level, with `groups` and `people` as one. */
export type AccessChoice = 'only_me' | 'audience' | 'members' | 'public'

export const choiceOf = (level: AccessLevel): AccessChoice =>
  needsAudience(level) ? 'audience' : (level as AccessChoice)

/** The level of a list of people and teams: `people` when it names an address, else `groups`. */
export const audienceLevel = (audience: { emails: readonly unknown[] }): AccessLevel =>
  audience.emails.length > 0 ? 'people' : 'groups'

type Audience = { emails: string[]; groups: string[] }

const sizeOf = (a: { emails: readonly unknown[]; groups: readonly unknown[] }) =>
  a.emails.length + a.groups.length

export function SiteAccess({ site }: { site: SiteWithAudience }) {
  const instance = useInstance()
  const levels = instance?.capabilities.accessLevels === true
  const audiences = instance?.capabilities.audiences === true
  const groupsOn = instance?.capabilities.groups === true
  const actions = useSiteActions(site.name)
  const allGroups = useGroups(false)
  const id = useId()

  const current = choiceOf(siteAccessLevel(site))
  /** An option chosen but not saved yet: only people and teams waits, for its list and Save. */
  const [chosen, setChosen] = useState<AccessChoice | null>(null)
  const shown = chosen ?? current
  /** The list being made while moving to people and teams (by slug), before Save. */
  const [draft, setDraft] = useState<Audience>({ emails: [], groups: [] })
  const [problem, setProblem] = useState<string | null>(null)
  /** Asking before a list of people and teams is cleared: choosing only you or everyone. */
  const [confirmClear, setConfirmClear] = useState<'only_me' | 'members' | null>(null)
  const [dialog, setDialog] = useState<'refresh-share' | 'revoke-share' | null>(null)
  const closeDialog = () => setDialog(null)

  const listed = site.audience?.emails ?? []
  const named = site.audience?.groups ?? []
  const kept = { emails: listed.map(e => e.email), groups: named.map(g => g.slug) }
  const busy =
    actions.setAccess.isPending || actions.setAudience.isPending || actions.setVisibility.isPending
  const instanceName = instance?.name ?? DEFAULT_INSTANCE_NAME
  const accounts = instance ? allowedAccountsPhrase(instance.auth) : null

  /** Save a level; `audience` for people and teams. Older servers: visibility and audience. */
  const save = async (choice: AccessChoice, audience?: Audience) => {
    setProblem(null)
    try {
      if (levels) {
        await actions.setAccess.mutateAsync(
          choice === 'audience' && audience
            ? { access: audienceLevel(audience), audience }
            : { access: choice as AccessLevel }
        )
      } else if (choice === 'public') {
        await actions.setVisibility.mutateAsync('public')
      } else {
        if (site.visibility === 'public') await actions.setVisibility.mutateAsync('private')
        const next = audience ?? { emails: [], groups: [] }
        if (sizeOf(next) > 0 || sizeOf(kept) > 0) await actions.setAudience.mutateAsync(next)
      }
      setChosen(null)
      return true
    } catch (error) {
      if (choice === 'audience') setProblem(peopleErrorMessage(error))
      else showToast(errorMessage(error), 'error')
      return false
    }
  }

  const choose = (choice: AccessChoice) => {
    if (choice === shown) return
    setProblem(null)
    if (choice === 'audience') {
      setDraft(kept)
      setChosen('audience')
      return
    }
    if (choice !== 'public' && sizeOf(kept) > 0) {
      setConfirmClear(choice)
      return
    }
    void save(choice)
  }

  /** The list shown in the pickers: the site's while it is its level, else the draft. */
  const editing = current === 'audience' && chosen === null
  const groupBySlug = new Map((allGroups.data ?? []).map(g => [g.slug, g]))
  const pickerEmails: AudienceEmail[] = editing
    ? listed
    : draft.emails.map(email => listed.find(e => e.email === email) ?? { email, known: true })
  const pickerGroups: AudienceGroup[] = editing
    ? named
    : draft.groups.map(slug => {
        const g = named.find(n => n.slug === slug) ?? groupBySlug.get(slug)
        return g
          ? { slug, name: g.name, size: g.size, ...('deleted' in g ? { deleted: g.deleted } : {}) }
          : { slug, name: slug, size: 0 }
      })

  /** An edit in the pickers: saved at once while the site is restricted to the list, else kept. */
  const changeList = async (next: Audience): Promise<boolean> => {
    if (!editing) {
      setDraft(next)
      setProblem(null)
      return true
    }
    if (sizeOf(next) === 0) {
      setProblem(
        'The list needs at least one person or team. To let no one else in, choose Only you above.'
      )
      return false
    }
    return save('audience', next)
  }

  const options: { choice: AccessChoice; label: string; description: string }[] = [
    ...(levels
      ? [
          {
            choice: 'only_me' as const,
            label: 'Only you',
            description: 'Nobody else can open it.',
          },
        ]
      : []),
    ...(audiences
      ? [
          {
            choice: 'audience' as const,
            label: groupsOn ? 'Specific people and teams' : 'Specific people',
            description: groupsOn
              ? 'Only you, the people you add and the members of the teams you choose.'
              : 'Only you and the people you add.',
          },
        ]
      : []),
    {
      choice: 'members',
      label: `Everyone signed in to ${instanceName}${accounts ? ` (${accounts})` : ''}`,
      description: `Anyone who can sign in to ${instanceName} can open it.`,
    },
    {
      choice: 'public',
      label: 'Public',
      description: 'Anyone with the address can open it, without signing in.',
    },
  ]

  const createShare = (rotating: boolean) =>
    actions.share.mutate(undefined, {
      onSuccess: async ({ shareUrl }) => {
        closeDialog()
        try {
          await copyText(shareUrl)
          showToast(rotating ? 'New share link copied' : 'Share link created and copied')
        } catch {
          showToast(rotating ? 'Share link refreshed' : 'Share link created')
        }
      },
    })

  const pickersId = `${id}-pickers`

  return (
    <SiteSection title="Access">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pbe-2 text-sm font-medium">Who can open this site</legend>
        {options.map(option => {
          const selected = shown === option.choice
          const descId = `${id}-${option.choice}`
          return (
            <div key={option.choice} className="choice-option">
              <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
                <input
                  type="radio"
                  name={`${id}-access`}
                  value={option.choice}
                  className="radio radio-sm radio-primary mbs-0.5 shrink-0"
                  checked={selected}
                  disabled={busy}
                  aria-describedby={descId}
                  {...(option.choice === 'audience' ? { 'aria-controls': pickersId } : {})}
                  onChange={() => choose(option.choice)}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span id={descId} className="text-xs text-muted">
                    {option.description}
                    {option.choice === 'public' && (
                      <span className="block">
                        Its review page and comments still need sign-in.
                      </span>
                    )}
                    {option.choice === 'audience' && !selected && sizeOf(kept) > 0 && (
                      <span className="block">
                        Its list of {audienceWho(listed.length, named.length)} is kept for when you
                        choose this again.
                      </span>
                    )}
                  </span>
                </span>
              </label>
              {option.choice === 'audience' && selected && (
                <div
                  id={pickersId}
                  role="group"
                  aria-label="People and teams who can open it"
                  className="flex flex-col gap-2 pbe-3 ps-10 pe-3"
                >
                  <AudiencePicker
                    emails={pickerEmails}
                    named={pickerGroups}
                    groupsOn={groupsOn}
                    busy={busy}
                    live={editing}
                    problem={problem}
                    onProblem={setProblem}
                    onChange={changeList}
                  />
                  {!editing && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={busy || sizeOf(draft) === 0}
                        onClick={() => void save('audience', draft)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        onClick={() => {
                          setChosen(null)
                          setProblem(null)
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </fieldset>

      {/* The share link: an extra on top of whichever option is chosen. */}
      <div className="flex flex-col gap-1 border-t border-[color:var(--border-subtle)] pbs-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Also share with a link</span>
            <span className="text-xs text-muted">
              {site.visibility === 'public'
                ? 'Not needed while the site is public: anyone can already open it.'
                : 'Anyone with the link can open it without signing in, whoever you chose above.'}
            </span>
          </span>
          {site.shareUrl ? (
            <span className="flex gap-0.5">
              <CopyButton text={site.shareUrl} label="Copy share link" />
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-square"
                title="Refresh the share link"
                aria-label="Refresh the share link"
                onClick={() => setDialog('refresh-share')}
              >
                <ArrowPathIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs btn-square text-error"
                title="Revoke the share link"
                aria-label="Revoke the share link"
                onClick={() => setDialog('revoke-share')}
              >
                <NoSymbolIcon className="h-4 w-4" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => createShare(false)}
              disabled={actions.share.isPending}
            >
              <LinkIcon className="h-3.5 w-3.5" />
              Create link
            </button>
          )}
        </div>
        {site.shareUrl && (
          <a
            href={site.shareUrl}
            target="_blank"
            rel="noreferrer"
            className="link link-hover block truncate font-mono text-xs"
          >
            {displayUrl(site.shareUrl)}
          </a>
        )}
        {site.shareUrl && site.restricted && (
          <p className="flex items-center gap-1 text-xs text-warning">
            <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Anyone with the share link can still open this site.
          </p>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmClear !== null}
        title={
          confirmClear === 'only_me'
            ? 'Make it yours alone?'
            : 'Open the site to everyone signed in?'
        }
        message={`Its list of ${audienceWho(listed.length, named.length)} is cleared${
          confirmClear === 'only_me'
            ? ', and only you can open the site.'
            : `, and anyone signed in to ${instanceName} can open the site.`
        }`}
        confirmText={confirmClear === 'only_me' ? 'Only you' : 'Open to everyone'}
        confirmButtonClass={confirmClear === 'only_me' ? 'btn-primary' : 'btn-warning'}
        isLoading={busy}
        onCancel={() => setConfirmClear(null)}
        onConfirm={async () => {
          if (confirmClear) await save(confirmClear)
          setConfirmClear(null)
        }}
      />
      <ConfirmModal
        isOpen={dialog === 'refresh-share'}
        title="Refresh the share link?"
        message="You'll get a new link. The old link stops working straight away, so anyone you sent it to will need the new one."
        confirmText="Refresh link"
        confirmButtonClass="btn-warning"
        isLoading={actions.share.isPending}
        onCancel={closeDialog}
        onConfirm={() => createShare(true)}
      />
      <ConfirmModal
        isOpen={dialog === 'revoke-share'}
        title="Revoke the share link?"
        message="The link stops working straight away. Whoever you chose above can still open the site."
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={actions.revokeShare.isPending}
        onCancel={closeDialog}
        onConfirm={() => actions.revokeShare.mutate(undefined, { onSettled: closeDialog })}
      />
    </SiteSection>
  )
}

/**
 * The people and teams of an audience: the addresses (each marked until it has signed in), the
 * groups (with the `groups` capability), a suggestion to use a group that holds exactly the listed
 * people, and the group editor. Every change sends the whole list to `onChange`, which saves it
 * (`live`) or keeps it for Save, and says whether it was taken.
 */
function AudiencePicker({
  emails: listed,
  named,
  groupsOn,
  busy,
  live,
  problem,
  onProblem,
  onChange,
}: {
  emails: readonly AudienceEmail[]
  named: readonly AudienceGroup[]
  groupsOn: boolean
  busy: boolean
  live: boolean
  problem: string | null
  onProblem: (problem: string | null) => void
  onChange: (next: Audience) => Promise<boolean>
}) {
  const emails = listed.map(e => e.email)
  const slugs = named.map(g => g.slug)
  const size = listed.length + named.length
  const [draft, setDraft] = useState('')
  /** The group editor, and why it was opened to create: a group to add, or one of the listed people. */
  const [editor, setEditor] = useState<GroupEditorTarget | null>(null)
  const [making, setMaking] = useState<'new' | 'from-people'>('new')
  /** Groups whose suggestion was waved away, so it stays away. */
  const [dismissed, setDismissed] = useState<string[]>([])
  const twins = useGroupsWithMembers(emails, groupsOn && emails.length >= 2)
  const twin = (twins.data ?? []).find(
    g =>
      !dismissed.includes(g.slug) &&
      swapEmailsForGroup({ emails, groups: slugs }, { slug: g.slug, members: emails }) !== null
  )
  const id = useId()

  /** Change the list; afterwards leave `left` in the input and say `note`, if anything. */
  const commit = async (
    next: { emails?: string[]; groups?: string[] },
    left: string[] = [],
    note: string | null = null
  ) => {
    const taken = await onChange({ emails: next.emails ?? emails, groups: next.groups ?? slugs })
    if (taken) {
      setDraft(left.join(', '))
      onProblem(note)
    }
  }

  const add = (text: string) => {
    const { emails: next, invalid, overflow } = addToAudience(emails, text)
    const note = overflow.length
      ? `A site can be limited to at most ${AUDIENCE_EMAILS_MAX} people.`
      : invalid.length
        ? `Not an email address: ${invalid.join(', ')}`
        : null
    const left = [...invalid, ...overflow]
    if (next.length === emails.length) {
      setDraft(left.join(', '))
      onProblem(note)
      return
    }
    void commit({ emails: next }, left, note)
  }

  const roomForGroup = slugs.length < AUDIENCE_GROUPS_MAX
  /** After creating: name the new group, or swap the people it holds for it. */
  const offer: CreateOffer =
    making === 'new'
      ? () => (roomForGroup ? { label: 'Let this group open the site' } : null)
      : members =>
          roomForGroup && sameMembers(members, emails)
            ? {
                label: `Use the group in place of these ${emails.length} people`,
                hint: 'It holds exactly them, so who can open the site stays the same.',
              }
            : null
  const created = (group: { slug: string; members: { email: string }[] }, accepted: boolean) => {
    if (!accepted) return
    const next: AudienceEdit | null =
      making === 'new'
        ? { emails, groups: [...slugs, group.slug] }
        : swapEmailsForGroup(
            { emails, groups: slugs },
            { slug: group.slug, members: group.members.map(m => m.email) }
          )
    if (next) void commit(next)
  }
  const makeGroup = (from: 'new' | 'from-people') => {
    setMaking(from)
    setEditor({ mode: 'create', members: from === 'from-people' ? emails : undefined })
  }

  return (
    <>
      {listed.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="People who can open it">
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
      {groupsOn && twin ? (
        <div className="tone-info flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-box border px-2.5 py-1.5 text-xs">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <UserGroupIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              These are the same people as <strong>{twin.name}</strong>. Use the group instead?
            </span>
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setDismissed([...dismissed, twin.slug])}
            >
              Not now
            </button>
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={busy}
              onClick={() => {
                const next = swapEmailsForGroup(
                  { emails, groups: slugs },
                  { slug: twin.slug, members: emails }
                )
                if (next) void commit(next)
              }}
            >
              Use {twin.name}
            </button>
          </span>
        </div>
      ) : (
        groupsOn &&
        listed.length >= 2 && (
          <button
            type="button"
            className="btn btn-xs btn-ghost self-start"
            onClick={() => makeGroup('from-people')}
          >
            <UserGroupIcon className="h-3.5 w-3.5" aria-hidden />
            Save these people as a group
          </button>
        )
      )}
      {groupsOn && (
        <AudienceGroups
          named={named}
          busy={busy}
          onChange={groups => void commit({ groups })}
          onOpen={slug => setEditor({ mode: 'open', slug })}
          onNew={() => makeGroup('new')}
        />
      )}
      <EmailAdder
        id={id}
        draft={draft}
        onDraftChange={setDraft}
        onAdd={add}
        busy={busy}
        problem={problem}
        hint={
          !live
            ? `Add at least one person${groupsOn ? ' or team' : ''}, then save.`
            : size > 0 && listed.length === 0 && named.every(g => g.deleted)
              ? 'Only you can open it: the group it was limited to was deleted. Add people or teams to let them in.'
              : 'You can always open it. Someone you remove can still open it for up to 5 minutes.'
        }
      />
      <GroupEditor
        target={editor}
        onClose={() => setEditor(null)}
        offer={offer}
        onCreated={created}
      />
    </>
  )
}

/**
 * The groups in the audience, each opening in the group editor (with Edit for the user's own), a
 * picker over every group on the instance (any member may name any group), up to
 * AUDIENCE_GROUPS_MAX, and "New group".
 */
function AudienceGroups({
  named,
  busy,
  onChange,
  onOpen,
  onNew,
}: {
  named: readonly AudienceGroup[]
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
  const full = slugs.length >= AUDIENCE_GROUPS_MAX
  const id = useId()

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {named.length > 0 && (
        <ul className="contents" aria-label="Groups who can open it">
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
      {full && (
        <span className="text-xs text-muted">
          A site can name at most {AUDIENCE_GROUPS_MAX} groups.
        </span>
      )}
    </div>
  )
}
