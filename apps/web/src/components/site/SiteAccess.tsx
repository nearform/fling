/**
 * Who can open the site: public or private and, private, everyone signed in or only the people
 * and groups in its audience (with the `audiences` and `groups` capabilities); and its share link (create, copy, refresh,
 * revoke). Refreshing and revoking break the link people already have, and emptying the audience
 * (choosing everyone, or removing its last address or group) opens the site to every member, so
 * those ask first. The audience is saved as it is edited, and
 * the API's word on a refused address is shown beside the input. Groups open in the group editor
 * from here: to see one, to change one the user owns, or to make one (from scratch, or from the
 * listed people, to use in their place).
 */
import {
  AUDIENCE_EMAILS_MAX,
  AUDIENCE_GROUPS_MAX,
  type AudienceGroup,
  type SiteWithAudience,
} from '@fling/shared'
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  NoSymbolIcon,
  PlusIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { useEffect, useId, useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useGroups, useGroupsWithMembers, useMe, useSiteActions } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { addToAudience, audienceWho, opensToEveryone, peopleLabel } from '../../lib/audience'
import { copyText } from '../../lib/clipboard'
import { displayUrl } from '../../lib/format'
import { type AudienceEdit, sameMembers, swapEmailsForGroup } from '../../lib/groups'
import { audienceFor, DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { showToast } from '../../lib/toast'
import { ConfirmModal } from '../ConfirmModal'
import { CopyButton } from '../CopyButton'
import { EmailAdder } from '../EmailAdder'
import { EmailBadge } from '../EmailBadge'
import { GroupChip } from '../GroupChip'
import { type CreateOffer, GroupEditor, type GroupEditorTarget } from '../GroupEditor'
import { SiteSection } from './SiteSection'

export function SiteAccess({ site }: { site: SiteWithAudience }) {
  const instance = useInstance()
  const audiences = instance?.capabilities.audiences === true
  const actions = useSiteActions(site.name)
  const [dialog, setDialog] = useState<'refresh-share' | 'revoke-share' | null>(null)
  const close = () => setDialog(null)

  const createShare = (rotating: boolean) =>
    actions.share.mutate(undefined, {
      onSuccess: async ({ shareUrl }) => {
        close()
        try {
          await copyText(shareUrl)
          showToast(rotating ? 'New share link copied' : 'Share link created and copied')
        } catch {
          showToast(rotating ? 'Share link refreshed' : 'Share link created')
        }
      },
    })

  return (
    <SiteSection title="Access" description="Who can open the site.">
      <div className="grid gap-2 md:grid-cols-2">
        {/* Visibility */}
        <div className="surface-inset space-y-0.5 px-3 py-2">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-sm font-medium">Public</span>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={site.visibility === 'public'}
              disabled={actions.setVisibility.isPending}
              onChange={e => actions.setVisibility.mutate(e.target.checked ? 'public' : 'private')}
            />
          </label>
          <p className="text-xs text-muted">
            {site.visibility === 'public'
              ? 'Anyone with the URL can open it.'
              : site.restricted
                ? `Private: only you and ${audienceWho(site.audience?.emails.length ?? 0, site.audience?.groups.length ?? 0)}.`
                : `Private: open to ${audienceFor(instance)}.`}
          </p>
        </div>

        {/* Share link */}
        <div className="surface-inset space-y-0.5 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Share link</span>
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
                Create
              </button>
            )}
          </div>
          {site.shareUrl ? (
            <a
              href={site.shareUrl}
              target="_blank"
              rel="noreferrer"
              className="link link-hover block truncate font-mono text-xs"
            >
              {displayUrl(site.shareUrl)}
            </a>
          ) : null}
          {site.shareUrl && site.restricted && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Anyone with the share link can still open this site.
            </p>
          )}
          {!site.shareUrl && (
            <p className="text-xs text-muted">
              Lets anyone with the link open the site without signing in — for people who can’t sign
              in.
            </p>
          )}
        </div>

        {audiences && <SiteAudience site={site} />}
      </div>

      <ConfirmModal
        isOpen={dialog === 'refresh-share'}
        title="Refresh the share link?"
        message="You'll get a new link. The old link stops working straight away, so anyone you sent it to will need the new one."
        confirmText="Refresh link"
        confirmButtonClass="btn-warning"
        isLoading={actions.share.isPending}
        onCancel={close}
        onConfirm={() => createShare(true)}
      />
      <ConfirmModal
        isOpen={dialog === 'revoke-share'}
        title="Revoke the share link?"
        message={`The link stops working straight away. People signed in to ${instance?.name ?? DEFAULT_INSTANCE_NAME} can still open the site if it is private.`}
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={actions.revokeShare.isPending}
        onCancel={close}
        onConfirm={() => actions.revokeShare.mutate(undefined, { onSettled: close })}
      />
    </SiteSection>
  )
}

/**
 * Private: everyone signed in, or only the listed people and groups (groups with the `groups`
 * capability). Public: a quiet note when a list is kept for when it is private again. Every save
 * sends the whole audience, addresses and groups together.
 */
function SiteAudience({ site }: { site: SiteWithAudience }) {
  const instance = useInstance()
  const groupsOn = instance?.capabilities.groups === true
  const save = useSiteActions(site.name).setAudience
  const listed = site.audience?.emails ?? []
  const named = site.audience?.groups ?? []
  const emails = listed.map(e => e.email)
  const slugs = named.map(g => g.slug)
  const size = listed.length + named.length
  const who = audienceWho(listed.length, named.length)
  const [only, setOnly] = useState(size > 0)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  /** Asking before the audience empties: chosen "Everyone signed in", or removed its last entry. */
  const [confirmClear, setConfirmClear] = useState<'everyone' | 'last' | null>(null)
  /** The group editor, and why it was opened to create: a group to add, or one of the listed people. */
  const [editor, setEditor] = useState<GroupEditorTarget | null>(null)
  const [making, setMaking] = useState<'new' | 'from-people'>('new')
  /** Groups whose suggestion was waved away, so it stays away. */
  const [dismissed, setDismissed] = useState<string[]>([])
  const twins = useGroupsWithMembers(
    emails,
    groupsOn && site.visibility === 'private' && emails.length >= 2
  )
  const twin = (twins.data ?? []).find(
    g =>
      !dismissed.includes(g.slug) &&
      swapEmailsForGroup({ emails, groups: slugs }, { slug: g.slug, members: emails }) !== null
  )
  const id = useId()

  // A list that appears from elsewhere (the CLI, another tab) shows as "Only these people".
  useEffect(() => {
    if (size > 0) setOnly(true)
  }, [size])

  if (site.visibility === 'public') {
    return size > 0 ? (
      <p className="text-xs text-muted md:col-span-2">
        Its list of {who} is kept, and applies when the site is private again.
      </p>
    ) : null
  }

  /** Save the audience; afterwards leave `left` in the input and say `note`, if anything. */
  const commit = (
    next: { emails?: string[]; groups?: string[] },
    left: string[] = [],
    note: string | null = null
  ) => {
    const audience = { emails: next.emails ?? emails, groups: next.groups ?? slugs }
    if (opensToEveryone({ emails, groups: slugs }, audience)) {
      setConfirmClear('last')
      return
    }
    save.mutate(audience, {
      onSuccess: () => {
        setDraft(left.join(', '))
        setProblem(note)
      },
      onError: error => setProblem(errorMessage(error)),
    })
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
      setProblem(note)
      return
    }
    commit({ emails: next }, left, note)
  }

  const everyone = () => (size > 0 ? setConfirmClear('everyone') : setOnly(false))

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
    if (next) commit(next)
  }
  const makeGroup = (from: 'new' | 'from-people') => {
    setMaking(from)
    setEditor({ mode: 'create', members: from === 'from-people' ? emails : undefined })
  }

  return (
    <fieldset className="surface-inset space-y-2 px-3 py-2 md:col-span-2">
      <legend className="sr-only">Who can open it</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="radio"
            name={`${id}-who`}
            className="radio radio-sm radio-primary"
            checked={!only}
            disabled={save.isPending}
            onChange={everyone}
          />
          Everyone signed in
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="radio"
            name={`${id}-who`}
            className="radio radio-sm radio-primary"
            checked={only}
            disabled={save.isPending}
            onChange={() => setOnly(true)}
          />
          Only these people
        </label>
      </div>

      {only && (
        <div className="space-y-1.5">
          {listed.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="People who can open it">
              {listed.map(person => (
                <li key={person.email} className="max-w-full">
                  <EmailBadge
                    email={person.email}
                    known={person.known}
                    disabled={save.isPending}
                    onRemove={() => commit({ emails: emails.filter(e => e !== person.email) })}
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
                  disabled={save.isPending}
                  onClick={() => {
                    const next = swapEmailsForGroup(
                      { emails, groups: slugs },
                      { slug: twin.slug, members: emails }
                    )
                    if (next) commit(next)
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
                className="btn btn-xs btn-ghost"
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
              busy={save.isPending}
              onChange={groups => commit({ groups })}
              onOpen={slug => setEditor({ mode: 'open', slug })}
              onNew={() => makeGroup('new')}
            />
          )}
          <EmailAdder
            id={id}
            draft={draft}
            onDraftChange={setDraft}
            onAdd={add}
            busy={save.isPending}
            problem={problem}
            hint={
              size === 0
                ? `Add at least one person${groupsOn ? ' or group' : ''}. Until then, everyone signed in can open it.`
                : listed.length === 0 && named.every(g => g.deleted)
                  ? 'Only you can open it: the group it was limited to was deleted. Add people or groups to let them in.'
                  : 'You can always open it. Someone you remove can still open it for up to 5 minutes.'
            }
          />
        </div>
      )}

      <GroupEditor
        target={editor}
        onClose={() => setEditor(null)}
        offer={offer}
        onCreated={created}
      />
      <ConfirmModal
        isOpen={confirmClear !== null}
        title="Open the site to everyone signed in?"
        message={
          confirmClear === 'last'
            ? `That empties its list, and the site is open to ${audienceFor(instance)}.`
            : `The list of ${who} is cleared, and the site is open to ${audienceFor(instance)}.`
        }
        confirmText="Open to everyone"
        confirmButtonClass="btn-warning"
        isLoading={save.isPending}
        onCancel={() => setConfirmClear(null)}
        onConfirm={() =>
          save.mutate(
            { emails: [], groups: [] },
            {
              onSuccess: () => {
                setOnly(false)
                setProblem(null)
              },
              onError: error => setProblem(errorMessage(error)),
              onSettled: () => setConfirmClear(null),
            }
          )
        }
      />
    </fieldset>
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
