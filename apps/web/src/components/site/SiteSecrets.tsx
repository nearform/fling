/**
 * The site page's Secrets section (`servers` capability), for the site's owners and publishers
 * (`site.secrets`): the site secrets by name, with who set each and when; the names the live
 * version declares in its `fling.json` that aren't set, with a warning; and a publish waiting for
 * secrets (`awaitingSecrets`), with those it still needs. A value is set through a password field
 * and never shown or read back. Setting or removing one restarts the live server with the secrets
 * as they are now, and setting the last one a waiting publish needs takes it live (a server
 * that fails to start then keeps it waiting, tried again at each change): the section says what
 * happened (the live server started, a version went live, the server's log when it
 * didn't start, or what is still missing). Secrets belong to the site, not a version, so a
 * rollback runs with today's.
 */
import {
  isReservedSecretName,
  RESERVED_SECRET_NAMES_TEXT,
  SITE_SECRET_NAME_RE,
  type SiteDetail,
  type SiteSecretsResponse,
} from '@fling/shared'
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
  XCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { type ReactNode, useId, useState } from 'react'
import { useSecretActions } from '../../hooks/queries'
import { errorMessage } from '../../lib/api'
import { displayUrl, fullDate, shortVersion, timeAgo } from '../../lib/format'
import { type SecretOutcome, secretOutcome, secretRows, stillAwaited } from '../../lib/servers'
import { ConfirmModal } from '../ConfirmModal'
import { Modal } from '../Modal'
import { SiteSection } from './SiteSection'

const names = (list: readonly string[]): ReactNode =>
  list.map((s, i) => (
    <span key={s}>
      {i > 0 && ', '}
      <code className="text-xs">{s}</code>
    </span>
  ))

export function SiteSecrets({
  site,
  secrets,
}: {
  site: Pick<SiteDetail, 'name' | 'awaitingSecrets'>
  secrets: SiteSecretsResponse
}) {
  const actions = useSecretActions(site.name)
  /** the secret whose value is being set; '' for a new one, named in the dialog */
  const [setting, setSetting] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  /** what the last change did, until the next one or until dismissed */
  const [outcome, setOutcome] = useState<SecretOutcome | null>(null)
  const awaiting = site.awaitingSecrets
  const rows = secretRows(secrets, awaiting)
  const awaited = awaiting ? stillAwaited(secrets, awaiting) : []

  return (
    <SiteSection
      title="Secrets"
      description="Values the server reads as process.env.NAME, kept encrypted beside the site. Nobody can see a value once it is set, but anyone who can publish this site can publish a server that reads it."
    >
      {outcome && <Outcome outcome={outcome} onDismiss={() => setOutcome(null)} />}

      {awaiting && awaited.length > 0 && (
        <div className="alert alert-info alert-soft text-sm" role="status">
          <ClockIcon className="size-5" aria-hidden="true" />
          <span>
            Version <code className="text-xs">{shortVersion(awaiting.versionId)}</code> is waiting
            to go live until {awaited.length === 1 ? 'this secret is' : 'these secrets are'} set:{' '}
            {names(awaited)}. It goes live as soon as the last one is.
          </span>
        </div>
      )}

      {awaiting && awaited.length === 0 && (
        <div className="alert alert-info alert-soft text-sm" role="status">
          <ClockIcon className="size-5" aria-hidden="true" />
          <span>
            Version <code className="text-xs">{shortVersion(awaiting.versionId)}</code> is waiting
            to go live: its server didn’t start with the secrets as they are. Setting or removing a
            secret tries it again.
          </span>
        </div>
      )}

      {secrets.missing.length > 0 && (
        <div className="alert alert-warning alert-soft text-sm" role="status">
          <ExclamationTriangleIcon className="size-5" aria-hidden="true" />
          <span>
            The live server reads {secrets.missing.length === 1 ? 'a secret' : 'secrets'} that{' '}
            {secrets.missing.length === 1 ? 'isn’t' : 'aren’t'} set: {names(secrets.missing)}. It
            runs without {secrets.missing.length === 1 ? 'it' : 'them'}, and publishing or restoring
            a version that declares {secrets.missing.length === 1 ? 'it' : 'them'} is refused until{' '}
            {secrets.missing.length === 1 ? 'it is' : 'they are'} set.
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">No secrets yet.</p>
      ) : (
        <div className="surface-inset overflow-x-auto">
          <table className="table table-xs">
            <thead>
              <tr>
                <th>Name</th>
                <th>Set</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.name}>
                  <td>
                    <code className="text-xs">{row.name}</code>
                    {row.waiting && awaiting && !row.declared && (
                      <span
                        className="badge badge-xs badge-ghost ml-2"
                        title={`Version ${awaiting.versionId} declares it and waits for it`}
                      >
                        For version {shortVersion(awaiting.versionId)}
                      </span>
                    )}
                    {!row.declared && !row.waiting && (
                      <span
                        className="badge badge-xs badge-ghost ml-2"
                        title="The live version’s fling.json doesn’t declare it, so its server doesn’t get it"
                      >
                        Not used
                      </span>
                    )}
                  </td>
                  <td>
                    {row.set ? (
                      <span title={fullDate(row.set.setAt)}>
                        {timeAgo(row.set.setAt)}
                        <span className="text-muted"> by {row.set.setBy}</span>
                      </span>
                    ) : (
                      <span className="badge badge-sm tone-warning gap-1">
                        <ExclamationTriangleIcon className="h-3 w-3" aria-hidden />
                        Not set
                      </span>
                    )}
                  </td>
                  <td className="space-x-1 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => setSetting(row.name)}
                    >
                      {row.set ? 'Replace…' : 'Set…'}
                    </button>
                    {row.set && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        aria-label={`Remove ${row.name}`}
                        title={`Remove ${row.name}`}
                        onClick={() => setRemoving(row.name)}
                      >
                        <TrashIcon className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setSetting('')}>
          <PlusIcon className="h-4 w-4" aria-hidden />
          Add a secret…
        </button>
      </div>

      <SetSecretModal
        open={setting !== null}
        secret={setting ?? ''}
        busy={actions.set.isPending}
        onCancel={() => setSetting(null)}
        onSave={async (secret, value) => {
          setOutcome(null)
          const result = await actions.set.mutateAsync({ secret, value })
          setOutcome(secretOutcome('set', result))
        }}
        onSaved={() => setSetting(null)}
      />
      <ConfirmModal
        isOpen={removing !== null}
        title={`Remove ${removing ?? ''}?`}
        message={
          secrets.declared.includes(removing ?? '')
            ? 'The live version declares it: its server restarts without it, and publishing or restoring a version that declares it is refused until it is set again.'
            : 'The value is deleted for good.'
        }
        confirmText="Remove"
        confirmButtonClass="btn-error"
        isLoading={actions.remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return
          setOutcome(null)
          actions.remove.mutate(removing, {
            onSuccess: result => setOutcome(secretOutcome('removed', result)),
            onSettled: () => setRemoving(null),
          })
        }}
      />
    </SiteSection>
  )
}

const TONES = {
  success: { alert: 'alert-success', Icon: CheckCircleIcon },
  warning: { alert: 'alert-warning', Icon: ExclamationTriangleIcon },
  error: { alert: 'alert-error', Icon: XCircleIcon },
} as const

/** What the last change did: a version live (with its link), the server's log when it failed. */
function Outcome({ outcome, onDismiss }: { outcome: SecretOutcome; onDismiss: () => void }) {
  const { alert, Icon } = TONES[outcome.tone]
  return (
    <div
      className={`alert ${alert} alert-soft items-start text-sm`}
      role={outcome.tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className="size-5" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p>
          {outcome.text}
          {outcome.url && (
            <>
              {' '}
              <a
                href={outcome.url}
                target="_blank"
                rel="noreferrer"
                className="link inline-flex items-center gap-1"
              >
                {displayUrl(outcome.url)}
                <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
        {outcome.logs && (
          <pre className="surface-inset max-h-48 overflow-auto rounded-box p-2 text-xs whitespace-pre-wrap">
            {outcome.logs.join('\n')}
          </pre>
        )}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-xs btn-square"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <XMarkIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}

/** Set one secret's value: a password field, never filled from or shown back. */
function SetSecretModal({
  open,
  secret,
  busy,
  onCancel,
  onSave,
  onSaved,
}: {
  open: boolean
  /** the secret's name; '' to name a new one */
  secret: string
  busy: boolean
  onCancel: () => void
  onSave: (secret: string, value: string) => Promise<unknown>
  onSaved: () => void
}) {
  const id = useId()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState<string | null>(null)
  const key = open ? secret : null
  // A fresh, empty form each time the dialog opens.
  if (key !== shownFor) {
    setShownFor(key)
    setName('')
    setValue('')
    setProblem(null)
  }
  const naming = secret === ''
  const chosen = naming ? name.trim() : secret
  const badShape = naming && chosen !== '' && !SITE_SECRET_NAME_RE.test(chosen)
  const reservedName = naming && !badShape && isReservedSecretName(chosen)
  const badName = badShape || reservedName

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={naming ? 'Add a secret' : `Set ${secret}`}
      actions={
        <>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form={id}
            className="btn btn-sm btn-primary"
            disabled={busy || chosen === '' || badName || value === ''}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : 'Save'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="space-y-3"
        autoComplete="off"
        onSubmit={async e => {
          e.preventDefault()
          setProblem(null)
          try {
            await onSave(chosen, value)
            onSaved()
          } catch (error) {
            setProblem(errorMessage(error))
          }
        }}
      >
        {naming && (
          <label className="block space-y-1">
            <span className="text-sm">Name</span>
            <input
              type="text"
              className={`input input-sm w-full font-mono ${badName ? 'input-error' : ''}`}
              placeholder="SLACK_WEBHOOK_URL"
              value={name}
              spellCheck={false}
              autoCapitalize="characters"
              onChange={e => setName(e.target.value.toUpperCase())}
            />
            {badShape && (
              <span className="block text-xs text-error">
                Capital letters, digits and _, not starting with a digit, at most 64.
              </span>
            )}
            {reservedName && (
              <span className="block text-xs text-error">
                {RESERVED_SECRET_NAMES_TEXT} are Fling’s and the platform’s: choose another name.
              </span>
            )}
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-sm">Value</span>
          <span className="input input-sm w-full">
            <KeyIcon className="size-4 text-muted" aria-hidden />
            <input
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={e => setValue(e.target.value)}
            />
          </span>
          <span className="block text-xs text-muted">
            Up to 8 KB. It can’t be shown again: to change it, set a new value.
          </span>
        </label>
        {problem && (
          <p className="text-sm text-error" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Modal>
  )
}
