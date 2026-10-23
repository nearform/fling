/**
 * OAuth consent (`/authorize?request=<id>`): where `/oauth/authorize` lands a signed-in user when
 * an app (the Claude connector) asks to use Fling for them. Allow / Deny POSTs the decision and
 * follows the returned redirect back to the app. `/authorize?error=…` shows a request the API
 * refused before it could trust the app's redirect URI.
 */
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AuthCard } from '../components/AuthCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { useMe } from '../hooks/queries'
import { api, errorMessage } from '../lib/api'
import Login from './Login'

const ERRORS: Record<string, string> = {
  invalid_client:
    'Fling does not recognise the app that sent you here. Remove the connector and add it again.',
  invalid_redirect_uri: 'The app asked Fling to send you somewhere Fling does not allow.',
}

const CAN_DO = [
  'Publish sites as you, and update your existing ones',
  'List and inspect your sites',
  'Change visibility, create share links, archive, roll back and delete your sites',
]

function Spinner() {
  return (
    <div className="py-6 text-center">
      <span
        className="loading loading-spinner loading-md text-muted"
        role="status"
        aria-label="Loading"
      />
    </div>
  )
}

function Consent({ requestId }: { requestId: string }) {
  const info = useQuery({
    queryKey: ['oauth-request', requestId],
    queryFn: () => api.oauthRequest(requestId),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const decide = useMutation({
    mutationFn: (approve: boolean) => api.decideOAuthRequest(requestId, approve),
    onSuccess: url => window.location.assign(url),
  })

  if (info.isPending) return <Spinner />
  if (info.isError) {
    return (
      <div role="alert" className="alert alert-error alert-soft text-sm">
        {errorMessage(info.error)}
      </div>
    )
  }
  const { clientName, clientIdHost, redirectHost, loopback, email } = info.data
  const done = decide.isSuccess

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold mb-1">
          {clientName} wants to use Fling as {email}
        </h1>
        <p className="text-sm text-secondary">
          {clientIdHost ? (
            <>
              Identified as{' '}
              <strong className="font-medium text-base-content">{clientIdHost}</strong>.{' '}
            </>
          ) : null}
          After you allow it, you go back to{' '}
          <strong className="font-medium text-base-content">{redirectHost}</strong>.
        </p>
      </div>

      <div>
        <p className="text-sm font-medium mb-2">It will be able to:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-secondary">
          {CAN_DO.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {loopback && (
        <div role="alert" className="alert alert-warning alert-soft text-sm items-start">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
          <span>
            This app runs on your computer ({redirectHost}). Only allow it if you just started this
            sign-in yourself, for example from Claude Code.
          </span>
        </div>
      )}

      {decide.isError && (
        <div role="alert" className="alert alert-error alert-soft text-sm">
          {errorMessage(decide.error)}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={decide.isPending || done}
          onClick={() => decide.mutate(true)}
        >
          {decide.isPending && decide.variables === true ? (
            <span className="loading loading-spinner loading-sm" />
          ) : null}
          Allow
        </button>
        <button
          type="button"
          className="btn btn-outline flex-1"
          disabled={decide.isPending || done}
          onClick={() => decide.mutate(false)}
        >
          Deny
        </button>
      </div>
      <p className="text-xs text-muted">
        You can disconnect it at any time from Connections in Fling.
      </p>
    </div>
  )
}

export default function Authorize() {
  const params = new URLSearchParams(window.location.search)
  const requestId = params.get('request')
  const error = params.get('error')
  const me = useMe()

  if (error || !requestId) {
    return (
      <AuthCard backdrop={<ThreadBackground />}>
        <h1 className="text-lg font-semibold mb-3">Can't connect this app</h1>
        <div role="alert" className="alert alert-error alert-soft text-sm">
          {(error && ERRORS[error]) ??
            params.get('error_description') ??
            'This link is incomplete. Start connecting again from the app.'}
        </div>
      </AuthCard>
    )
  }
  if (me.isPending) {
    return (
      <AuthCard backdrop={<ThreadBackground />}>
        <Spinner />
      </AuthCard>
    )
  }
  // Signed out (session expired since /oauth/authorize): sign in, then come back here.
  if (!me.data) return <Login />
  return (
    <AuthCard backdrop={<ThreadBackground />}>
      <Consent requestId={requestId} />
    </AuthCard>
  )
}
