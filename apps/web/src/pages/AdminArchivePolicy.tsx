/**
 * Admin → Archive policy (`/admin/archive-policy`; admins, on every instance; the API answers 404
 * to anyone else): the operator's settings, whether the policy is off, in dry run or live (and who
 * set it when), why it is paused, the switch between dry run and live (the admin's, from this
 * browser session only; going live asks first), what it would do or will do in the next
 * ARCHIVE_PREVIEW_DAYS, and what it did lately. Where nothing of it is configured, the page says
 * which variables turn it on. The rules are the API's archive-policy.ts.
 */
import {
  ARCHIVE_POLICY_OFF_TEXT,
  ARCHIVE_PREVIEW_DAYS,
  type ArchivePolicyStatus,
} from '@fling/shared'
import { ArchiveBoxIcon, PauseCircleIcon } from '@heroicons/react/24/outline'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import { useAdminArchivePolicy, useMe, useSetArchivePolicyLive } from '../hooks/queries'
import { errorMessage } from '../lib/api'
import {
  ARCHIVE_POLICY_VARIABLES,
  countingText,
  dayDate,
  dryRunConfirm,
  goLiveConfirm,
  pausedText,
  policyState,
  previewAction,
  previewIntro,
  previewWhen,
  recentLabel,
  STATE_LABEL,
  settingsText,
  settingVariables,
  showsArchivePolicyAdmin,
  stateText,
  switchError,
  TURN_ON_DEFAULTS,
} from '../lib/archive-policy'
import { deletedLabel } from '../lib/deleted'
import { fullDate, timeAgo } from '../lib/format'
import { ADMIN_USAGE_PATH } from '../lib/usage'

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={fullDate(iso)}>
      {timeAgo(iso)}
    </time>
  )
}

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="space-y-3">
      <header>
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {title}
        </h2>
        {aside && <p className="text-sm text-secondary">{aside}</p>}
      </header>
      <div className="surface-panel space-y-3 text-sm">{children}</div>
    </section>
  )
}

/** Nothing of it is configured: the four variables an operator sets to turn it on. */
function TurnOn() {
  return (
    <Section id="turn-on" title="Off" aside={ARCHIVE_POLICY_OFF_TEXT}>
      <p>
        An operator turns the policy on by setting these variables on the instance and deploying. It
        then starts in dry run: it shows here what it would do, and does nothing until an admin
        turns it live.
      </p>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {ARCHIVE_POLICY_VARIABLES.map(v => (
          <div key={v.name} className="contents">
            <dt>
              <code className="text-xs">{v.name}</code>
            </dt>
            <dd className="text-secondary">{v.about}</dd>
          </div>
        ))}
      </dl>
      <p className="text-secondary">{TURN_ON_DEFAULTS}</p>
    </Section>
  )
}

function Settings({ status }: { status: ArchivePolicyStatus }) {
  return (
    <Section id="settings" title="Settings" aside="Set by the operator: changing one is a deploy">
      <ul className="list-disc space-y-1 ps-5">
        {settingsText(status).map(line => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!status.mail && (
        <p className="text-secondary">
          This Fling sends no email, so owners are warned on the site page only.
        </p>
      )}
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        {settingVariables(status).map(v => (
          <div key={v.name} className="flex gap-1.5">
            <dt>
              <code>{v.name}</code>
            </dt>
            <dd className="tabular-nums">{v.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

/** Off, Dry run or Live, who set it and when, and the switch. */
function State({ status, fling }: { status: ArchivePolicyStatus; fling: string }) {
  const set = useSetArchivePolicyLive()
  const [asking, setAsking] = useState(false)
  const state = policyState(status)
  const next = !status.live
  return (
    <Section id="state" title="State" aside="Dry run or live: an admin’s choice">
      <p>
        <strong>{STATE_LABEL[state]}</strong>
        {status.setBy && status.setAt && (
          <span className="text-secondary">
            {' '}
            (turned {status.live ? 'live' : 'back to dry run'} by {status.setBy},{' '}
            <When iso={status.setAt} />)
          </span>
        )}
      </p>
      <p className="text-secondary">{stateText(status)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={`btn btn-sm ${next ? 'btn-warning' : ''}`}
          disabled={set.isPending}
          onClick={() => {
            set.reset()
            setAsking(true)
          }}
        >
          {next ? 'Turn live…' : 'Back to dry run…'}
        </button>
        <span className="text-xs text-muted">From your browser session only; recorded.</span>
      </div>
      {set.isError && !asking && (
        <p role="alert" className="text-error">
          {switchError(set.error)}
        </p>
      )}
      <ConfirmModal
        isOpen={asking}
        title={next ? 'Turn the archive policy live?' : 'Back to dry run?'}
        message={
          <div className="space-y-2">
            <p>{next ? goLiveConfirm(status, fling) : dryRunConfirm}</p>
            {set.isError && (
              <p role="alert" className="alert alert-error text-sm">
                {switchError(set.error)}
              </p>
            )}
          </div>
        }
        confirmText={next ? 'Turn live' : 'Back to dry run'}
        confirmButtonClass={next ? 'btn-warning' : 'btn-primary'}
        isLoading={set.isPending}
        onCancel={() => {
          if (!set.isPending) setAsking(false)
        }}
        onConfirm={() => set.mutate(next, { onSuccess: () => setAsking(false) })}
      />
    </Section>
  )
}

function Paused({ status }: { status: ArchivePolicyStatus }) {
  if (!status.paused) return null
  return (
    <div role="status" className="alert alert-warning items-start text-sm">
      <PauseCircleIcon className="size-5" aria-hidden />
      <div className="space-y-1">
        <p>{pausedText(status.paused)}</p>
        {status.paused.reason === 'counting_off' && (
          <Link className="link" to={ADMIN_USAGE_PATH}>
            View counting, on Admin → Usage
          </Link>
        )}
        {status.countingSince && (
          <p className="text-secondary">{countingText(status.countingSince)}</p>
        )}
      </div>
    </div>
  )
}

function Preview({ status }: { status: ArchivePolicyStatus }) {
  const { sites, purge, more, from } = status.preview
  const empty = sites.length === 0 && purge.length === 0
  return (
    <Section
      id="preview"
      title={`The next ${ARCHIVE_PREVIEW_DAYS} days`}
      aside={previewIntro(status)}
    >
      {empty ? (
        <p className="py-4 text-center text-secondary">
          <ArchiveBoxIcon className="mx-auto mb-2 size-6 text-muted" aria-hidden />
          Nothing is due.
        </p>
      ) : (
        <>
          {sites.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <caption className="text-start text-xs text-muted">Sites</caption>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Action</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map(s => (
                    <tr key={`${s.name}:${s.action}:${s.at}`}>
                      <th scope="row" className="font-medium">
                        {s.name}
                      </th>
                      <td className="text-secondary">{s.owner}</td>
                      <td>{previewAction(s.action)}</td>
                      <td className="tabular-nums" title={fullDate(s.at)}>
                        {previewWhen(s.at, from)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {purge.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <caption className="text-start text-xs text-muted">
                  Deleted sites purged for good
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Deleted</th>
                    <th scope="col">Deleted on</th>
                    <th scope="col">Purged</th>
                  </tr>
                </thead>
                <tbody>
                  {purge.map(p => (
                    <tr key={`${p.siteId}:${p.pathId ?? ''}:${p.deletedAt}`}>
                      <th scope="row" className="font-medium">
                        {deletedLabel(p)}
                      </th>
                      <td className="text-secondary">{dayDate(p.deletedAt)}</td>
                      <td className="tabular-nums" title={fullDate(p.at)}>
                        {previewWhen(p.at, from)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {more && (
        <p className="text-secondary" role="note">
          There is more due than these lists hold: they show the soonest.
        </p>
      )}
      <p className="text-xs text-muted">
        Sites maintenance hasn’t reached since the policy was turned on appear once its sweep has.
        Kept sites are never listed.
      </p>
    </Section>
  )
}

function Recent({ status }: { status: ArchivePolicyStatus }) {
  return (
    <Section id="recent" title="Recent actions" aside="What the policy did, from the audit log">
      {status.recent.length === 0 ? (
        <p className="text-secondary">Nothing yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {status.recent.map(a => (
            <li key={`${a.at}:${a.action}:${a.target}`}>
              {recentLabel(a)} <span className="font-medium">{a.target}</span>
              <span className="text-secondary">
                {' · '}
                <When iso={a.at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export default function AdminArchivePolicy() {
  const { data: me } = useMe()
  const instance = useInstance()
  const allowed = showsArchivePolicyAdmin(me)
  const status = useAdminArchivePolicy(allowed)
  const fling = instance?.name ?? 'this Fling'

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {me?.impersonator
          ? 'Stop impersonating to get back to the admin pages.'
          : 'This page is for the instance’s admins.'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <PageHeader
          title="Archive policy"
          description="Archive the sites nobody views or publishes, delete what it archived, and purge deleted sites, as the operator set it. Owners are always warned first."
        />
      </div>
      {status.isPending ? (
        <div className="surface-panel text-center">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading the archive policy"
          />
        </div>
      ) : status.isError ? (
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(status.error)}
          <button type="button" className="btn btn-sm" onClick={() => status.refetch()}>
            Try again
          </button>
        </div>
      ) : !status.data.on ? (
        <TurnOn />
      ) : (
        <div className="space-y-8">
          <Paused status={status.data} />
          <State status={status.data} fling={fling} />
          <Settings status={status.data} />
          <Preview status={status.data} />
          <Recent status={status.data} />
        </div>
      )}
    </div>
  )
}
