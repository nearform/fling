import type { Connection } from '@fling/shared'
import { KeyIcon, LinkIcon, TrashIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { ConfirmModal } from '../components/ConfirmModal'
import { PageHeader } from '../components/PageHeader'
import { useApiKeys, useConnections, useRevokeConnection, useRevokeKey } from '../hooks/queries'
import type { ApiKey } from '../lib/api'
import { errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'

interface Row {
  id: string
  name: ReactNode
  createdAt: string
  lastUsedAt: string | null
}

/** One revocable list (CLI keys or connected apps). */
function Section({
  title,
  description,
  query,
  rows,
  empty,
  onRevoke,
}: {
  title: string
  description: ReactNode
  query: { isPending: boolean; isError: boolean; error: unknown }
  rows: Row[] | undefined
  empty: ReactNode
  onRevoke: (id: string) => void
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-secondary">{description}</p>
      </div>
      <div className="surface-panel !p-0 overflow-hidden">
        {query.isPending ? (
          <div className="p-6 text-center">
            <span className="loading loading-spinner loading-sm text-muted" />
          </div>
        ) : query.isError ? (
          <div className="p-6 text-sm text-error">{errorMessage(query.error)}</div>
        ) : !rows || rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-secondary">{empty}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id}>
                    <td className="text-sm">{row.name}</td>
                    <td className="text-secondary" title={fullDate(row.createdAt)}>
                      {timeAgo(row.createdAt)}
                    </td>
                    <td
                      className="text-secondary"
                      title={row.lastUsedAt ? fullDate(row.lastUsedAt) : undefined}
                    >
                      {row.lastUsedAt ? timeAgo(row.lastUsedAt) : 'Never'}
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm text-error"
                        onClick={() => onRevoke(row.id)}
                      >
                        <TrashIcon className="h-4 w-4" />
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

type Pending = { kind: 'key'; item: ApiKey } | { kind: 'app'; item: Connection }

/**
 * Connections: CLI logins (every `fling login` mints a key) and apps connected through OAuth (the
 * Claude connector). Revoking either signs it out at once.
 */
export default function ApiKeys() {
  const keys = useApiKeys()
  const apps = useConnections()
  const revokeKey = useRevokeKey()
  const revokeApp = useRevokeConnection()
  const [pending, setPending] = useState<Pending | null>(null)

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader
        title="Connections"
        description="Everything that can use Fling as you. Revoke anything you no longer use."
      />

      <Section
        title="Connected apps"
        description="Apps you allowed to use Fling, such as the Claude connector."
        query={apps}
        rows={apps.data?.map(c => ({
          id: c.id,
          name: (
            <span>
              <span className="font-medium">{c.clientName}</span>
              {c.clientHost && <span className="text-secondary"> · {c.clientHost}</span>}
            </span>
          ),
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
        }))}
        empty={
          <>
            <LinkIcon className="mx-auto mb-2 h-6 w-6 text-muted" />
            No connected apps. Add Fling to Claude from Get started.
          </>
        }
        onRevoke={id => {
          const item = apps.data?.find(c => c.id === id)
          if (item) setPending({ kind: 'app', item })
        }}
      />

      <Section
        title="CLI logins"
        description="Each fling login creates a key for that machine."
        query={keys}
        rows={keys.data?.map(k => ({
          id: k.id,
          name: <span className="font-mono">{k.name}</span>,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
        }))}
        empty={
          <>
            <KeyIcon className="mx-auto mb-2 h-6 w-6 text-muted" />
            No CLI logins yet. Run <code>fling login</code> (after{' '}
            <code>npm install -g @nearform/fling</code>) to create one.
          </>
        }
        onRevoke={id => {
          const item = keys.data?.find(k => k.id === id)
          if (item) setPending({ kind: 'key', item })
        }}
      />

      <ConfirmModal
        isOpen={pending !== null}
        title={pending?.kind === 'app' ? 'Disconnect this app?' : 'Revoke this CLI login?'}
        message={
          pending?.kind === 'app' ? (
            <p>
              {pending.item.clientName} will lose access to Fling straight away. Reconnect it from
              the app to use it again.
            </p>
          ) : (
            <p>
              <code>{pending?.item.name}</code> will be signed out. Run <code>fling login</code> on
              that machine to sign in again.
            </p>
          )
        }
        confirmText={pending?.kind === 'app' ? 'Disconnect' : 'Revoke'}
        confirmButtonClass="btn-error"
        isLoading={revokeKey.isPending || revokeApp.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return
          const done = { onSettled: () => setPending(null) }
          if (pending.kind === 'app') revokeApp.mutate(pending.item.id, done)
          else revokeKey.mutate(pending.item.id, done)
        }}
      />
    </div>
  )
}
