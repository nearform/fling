/**
 * Who can open the site: public or private and, private, everyone signed in or only the people
 * in its audience (with the `audiences` capability); and its share link (create, copy, refresh,
 * revoke). Refreshing and revoking break the link people already have, and emptying the audience
 * opens the site to every member, so those ask first. The audience is saved as it is edited, and
 * the API's word on a refused address is shown beside the input.
 */
import { AUDIENCE_EMAILS_MAX, type SiteWithAudience } from '@fling/shared'
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  NoSymbolIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useState } from 'react'
import { useInstance } from '../../hooks/instance'
import { useSiteActions } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { addToAudience, peopleLabel } from '../../lib/audience'
import { displayUrl } from '../../lib/format'
import { audienceFor, DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { showToast } from '../../lib/toast'
import { ConfirmModal } from '../ConfirmModal'
import { CopyButton } from '../CopyButton'
import { SiteSection } from './SiteSection'

export function SiteAccess({ site }: { site: SiteWithAudience }) {
  const instance = useInstance()
  const audiences = instance?.capabilities.audiences === true
  const listed = site.audience?.emails ?? []
  const actions = useSiteActions(site.name)
  const [dialog, setDialog] = useState<'refresh-share' | 'revoke-share' | null>(null)
  const close = () => setDialog(null)

  const createShare = (rotating: boolean) =>
    actions.share.mutate(undefined, {
      onSuccess: async ({ shareUrl }) => {
        close()
        try {
          await navigator.clipboard.writeText(shareUrl)
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
                ? `Private: only you and ${peopleLabel(listed.length)}.`
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
 * Private: everyone signed in, or only the listed people. Public: a quiet note when a list is
 * kept for when it is private again.
 */
function SiteAudience({ site }: { site: SiteWithAudience }) {
  const instance = useInstance()
  const save = useSiteActions(site.name).setAudience
  const listed = site.audience?.emails ?? []
  const emails = listed.map(e => e.email)
  const [only, setOnly] = useState(listed.length > 0)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const id = useId()

  // A list that appears from elsewhere (the CLI, another tab) shows as "Only these people".
  useEffect(() => {
    if (listed.length > 0) setOnly(true)
  }, [listed.length])

  if (site.visibility === 'public') {
    return listed.length > 0 ? (
      <p className="text-xs text-muted md:col-span-2">
        Its list of {peopleLabel(listed.length)} is kept, and applies when the site is private
        again.
      </p>
    ) : null
  }

  /** Save `next`; afterwards leave `left` in the input and say `note`, if anything. */
  const commit = (next: string[], left: string[] = [], note: string | null = null) => {
    save.mutate(next, {
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
    commit(next, left, note)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
      e.preventDefault()
      add(draft)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault()
      add(`${draft} ${text}`)
    }
  }

  const everyone = () => (listed.length > 0 ? setConfirmClear(true) : setOnly(false))

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
                <li key={person.email} className="badge badge-ghost h-auto gap-1 py-0.5">
                  <span className="break-all">{person.email}</span>
                  {!person.known && <span className="text-muted">· hasn’t signed in yet</span>}
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-circle h-4 min-h-4 w-4"
                    aria-label={`Remove ${person.email}`}
                    title={`Remove ${person.email}`}
                    disabled={save.isPending}
                    onClick={() => commit(emails.filter(e => e !== person.email))}
                  >
                    <XMarkIcon className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-1.5">
            <label htmlFor={`${id}-add`} className="sr-only">
              Add people by email
            </label>
            <input
              id={`${id}-add`}
              type="text"
              inputMode="email"
              autoComplete="off"
              className="input input-sm min-w-0 flex-1"
              placeholder="name@example.com, another@example.com"
              value={draft}
              aria-invalid={problem !== null}
              aria-describedby={`${id}-help`}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!draft.trim() || save.isPending}
              onClick={() => add(draft)}
            >
              Add
            </button>
          </div>
          <div id={`${id}-help`} className="space-y-0.5 text-xs">
            {problem && (
              <p className="text-error" role="alert">
                {problem}
              </p>
            )}
            <p className="text-muted">
              {listed.length === 0
                ? 'Add at least one person. Until then, everyone signed in can open it.'
                : 'You can always open it. Someone you remove can still open it for up to 15 minutes.'}
            </p>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmClear}
        title="Open the site to everyone signed in?"
        message={`The list of ${peopleLabel(listed.length)} is cleared, and the site is open to ${audienceFor(instance)}.`}
        confirmText="Open to everyone"
        confirmButtonClass="btn-warning"
        isLoading={save.isPending}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() =>
          save.mutate([], {
            onSuccess: () => {
              setOnly(false)
              setProblem(null)
            },
            onError: error => setProblem(errorMessage(error)),
            onSettled: () => setConfirmClear(false),
          })
        }
      />
    </fieldset>
  )
}
