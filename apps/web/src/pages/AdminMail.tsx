/**
 * Admin → Mail (`/admin/mail`; admins only, on an instance with the `email` capability; the API
 * answers 404 to anyone else): the mail settings, read only; a test email to any address, which
 * shows the provider's message id or why it was refused; and the last 24 hours of sending, with
 * the latest failures. No addresses but the instance's own, and no content. Nothing here sends
 * anything by itself.
 */
import type { MailAdmin, MailTestResult } from '@fling/shared'
import { EnvelopeIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline'
import { type FormEvent, type ReactNode, useState } from 'react'
import { AdminTabs } from '../components/AdminTabs'
import { PageHeader } from '../components/PageHeader'
import { useInstance } from '../hooks/instance'
import { useAdminMail, useMe, useSendTestMail } from '../hooks/queries'
import { showsAdmin } from '../lib/admin'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'
import { hourDate, showsMailAdmin } from '../lib/notifications'

const COUNTERS = [
  { key: 'sent', label: 'Sent' },
  { key: 'retrying', label: 'Retrying' },
  { key: 'givenUp', label: 'Given up' },
  { key: 'suppressed', label: 'Suppressed' },
  { key: 'dropped', label: 'Dropped' },
] as const

const DRIVERS: Record<string, string> = {
  ses: 'Amazon SES',
  cloudflare: 'Cloudflare Email Service',
  file: 'Files (local development)',
  memory: 'Memory (tests)',
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-sm text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function Configuration({ config }: { config: MailAdmin['config'] }) {
  const rows: [string, string | null][] = [
    ['Sent through', DRIVERS[config.driver] ?? config.driver],
    ['From', config.from],
    ['From name', config.fromName],
    ['Reply-To', config.replyTo],
    ['Configuration set', config.configurationSet],
  ]
  return (
    <Section
      title="Configuration"
      description="Set in the instance's infrastructure (the deploy guide's Email section); read only here."
    >
      <dl className="surface-panel grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-secondary">{label}</dt>
            <dd className="min-w-0 break-words">
              {value ?? <span className="text-muted">Not set</span>}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}

function TestResult({ result }: { result: MailTestResult }) {
  if (result.ok) {
    return (
      <div role="status" className="alert alert-success text-sm">
        <span className="min-w-0 break-words">
          Sent. {result.providerId ? `Message id ${result.providerId}.` : ''} Check its headers for
          SPF, DKIM and DMARC alignment.
        </span>
      </div>
    )
  }
  return (
    <div role="alert" className="alert alert-error text-sm">
      <span className="min-w-0 break-words">Not sent: {result.error}</span>
    </div>
  )
}

function TestSend({ tests }: { tests: MailAdmin['tests'] }) {
  const [to, setTo] = useState('')
  const send = useSendTestMail()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (to.trim()) send.mutate(to.trim())
  }
  return (
    <Section
      title="Send a test email"
      description="To any address, inside the sign-in allowlist or not (deliverability checkers too). It goes straight to the provider."
    >
      <div className="surface-panel space-y-3">
        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <label className="input input-sm min-w-0 flex-1 basis-64">
            <EnvelopeIcon className="size-4 text-muted" />
            <input
              type="email"
              required
              placeholder="someone@example.com"
              value={to}
              onChange={e => setTo(e.target.value)}
              aria-label="Send the test to"
            />
          </label>
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={send.isPending || tests.remaining === 0}
          >
            {send.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <PaperAirplaneIcon className="size-4" />
            )}
            Send test
          </button>
        </form>
        <p className="text-xs text-muted">
          {tests.remaining} of {tests.limit} test emails left this hour.
        </p>
        {send.isError && (
          <div role="alert" className="alert alert-error text-sm">
            {errorMessage(send.error)}
          </div>
        )}
        {send.data && <TestResult result={send.data} />}
      </div>
    </Section>
  )
}

function Health({ health }: { health: MailAdmin['health'] }) {
  return (
    <Section
      title="Last 24 hours"
      description={`Since ${fullDate(hourDate(health.since).toISOString())}. Counts only: no addresses, no content.`}
    >
      <div className="surface-panel grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
        {COUNTERS.map(c => (
          <div key={c.key}>
            <div className="text-xs text-secondary">{c.label}</div>
            <div className="text-xl font-semibold tabular-nums">{health.totals[c.key]}</div>
          </div>
        ))}
      </div>

      {health.hours.length > 0 && (
        <div className="surface-panel !p-0 overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Hour</th>
                {COUNTERS.map(c => (
                  <th key={c.key} className="text-end">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...health.hours].reverse().map(h => (
                <tr key={h.hour}>
                  <td className="whitespace-nowrap">{fullDate(hourDate(h.hour).toISOString())}</td>
                  {COUNTERS.map(c => (
                    <td key={c.key} className="text-end tabular-nums">
                      {h[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="text-sm font-semibold">Recent failures</h3>
      <div className="surface-panel !p-0 overflow-x-auto">
        {health.failures.length === 0 ? (
          <p className="p-6 text-center text-sm text-secondary">No failed sends.</p>
        ) : (
          <table className="table table-sm">
            <thead>
              <tr>
                <th>When</th>
                <th>Reason</th>
                <th>Events</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {health.failures.map(f => (
                <tr key={`${f.batchId}-${f.at}`}>
                  <td className="whitespace-nowrap" title={fullDate(f.at)}>
                    {timeAgo(f.at)}
                  </td>
                  <td>
                    {f.reason}
                    {f.detail && <span className="text-secondary"> ({f.detail})</span>}
                  </td>
                  <td className="text-secondary">{f.eventKeys.join(', ')}</td>
                  <td className="font-mono text-xs break-all">{f.batchId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  )
}

export default function AdminMail() {
  const { data: me } = useMe()
  const instance = useInstance()
  const allowed = showsMailAdmin(me, instance)
  const mail = useAdminMail(allowed)

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md surface-panel text-center text-sm text-secondary">
        {!showsAdmin(me)
          ? 'This page is for admins of this instance.'
          : instance
            ? `${instance.name} does not send email.`
            : 'Loading…'}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-4">
        <AdminTabs />
        <PageHeader
          title="Mail"
          description="How this instance sends email, a test send, and how sending went in the last day."
        />
      </div>
      {mail.isPending ? (
        <div className="surface-panel text-center">
          <span
            className="loading loading-spinner loading-sm text-muted"
            role="status"
            aria-label="Loading"
          />
        </div>
      ) : mail.isError ? (
        <div className="surface-panel text-sm text-error">{errorMessage(mail.error)}</div>
      ) : (
        <>
          <Configuration config={mail.data.config} />
          <TestSend tests={mail.data.tests} />
          <Health health={mail.data.health} />
        </>
      )}
    </div>
  )
}
