import { allowedAccountsPhrase, type InstanceMetadata, SIGN_IN_LINK_MINUTES } from '@fling/shared'
import { EnvelopeIcon } from '@heroicons/react/24/outline'
import { type FormEvent, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { useInstance } from '../hooks/instance'
import { errorMessage, loginUrl, requestSignInLink } from '../lib/api'
import { DEFAULT_INSTANCE_NAME } from '../lib/instance'

/** Issuers whose mark the sign-in button shows; any other gets a plain button. */
const GOOGLE_ISSUER = 'https://accounts.google.com'

/** Google's G, in currentColor (from agentic-mapper ProviderIcons). */
function GoogleIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.23c1.9-1.74 2.97-4.32 2.97-7.34Z" />
      <path
        d="M12 21.6c2.7 0 4.97-.9 6.63-2.42l-3.23-2.5c-.9.6-2.04.95-3.4.95-2.61 0-4.82-1.76-5.62-4.13H3.05v2.58A9.99 9.99 0 0 0 12 21.6Z"
        opacity=".8"
      />
      <path d="M6.38 13.5a6 6 0 0 1 0-3.8V7.12H3.05a10 10 0 0 0 0 8.96l3.33-2.58Z" opacity=".6" />
      <path
        d="M12 6.37c1.47 0 2.79.5 3.83 1.5l2.86-2.86A9.98 9.98 0 0 0 3.05 7.12l3.33 2.58c.8-2.37 3.01-4.13 5.62-4.13Z"
        opacity=".9"
      />
    </svg>
  )
}

/** Link errors (`/auth/link`): the login page opens the form to ask for another link. */
const LINK_ERRORS = new Set(['link_expired', 'link_used', 'not_invited'])

/** Whether the login page opens "Email me a sign-in link" for this error (`invites` on). */
export function opensLinkForm(code: string | null): boolean {
  return code !== null && (LINK_ERRORS.has(code) || code === 'domain_not_allowed')
}

/** The message for a failed sign-in: the API redirects to /login?error=<code>. */
export function loginErrorMessage(code: string, instance: InstanceMetadata | null): string {
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const provider = instance?.auth.displayName
  const accounts = instance ? allowedAccountsPhrase(instance.auth) : null
  const invites = instance?.capabilities.invites === true
  switch (code) {
    case 'domain_not_allowed': {
      const who = accounts
        ? `Only ${accounts} can sign in to ${name}.`
        : `That account can't sign in to ${name}.`
      return invites
        ? `${who} Invited from another organisation? Ask for a sign-in link below.`
        : who
    }
    case 'link_expired':
      return 'That sign-in link has expired. Ask for a new one below.'
    case 'link_used':
      return 'That sign-in link has been used already. Ask for a new one below.'
    case 'not_invited':
      return `That address no longer has an invitation to ${name}.`
    case 'email_unverified':
      return provider
        ? `Your ${provider} account email is not verified.`
        : 'Your account email is not verified.'
    case 'oauth_state_mismatch':
      return 'Sign-in took too long or was started in another tab. Please try again.'
    default:
      return `${provider ? `${provider} sign-in` : 'Sign-in'} failed. Please try again.`
  }
}

/** Where to come back to after signing in: from the /login page itself, the app's home. */
function returnTo(): string {
  return window.location.pathname === '/login' ? `${window.location.origin}/` : window.location.href
}

/**
 * "Invited from another organisation? Email me a sign-in link": the `invites` capability. It says
 * the same whatever the address, since only the API knows who is invited.
 */
function EmailLink({ name, open: startOpen }: { name: string; open: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const to = email.trim()
    if (!to) return
    setPending(true)
    setError(null)
    try {
      await requestSignInLink(to, returnTo())
      setSentTo(to)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <p className="text-sm text-secondary">
        Invited from another organisation?{' '}
        <button type="button" className="link link-primary" onClick={() => setOpen(true)}>
          Email me a sign-in link
        </button>
      </p>
    )
  }
  if (sentTo) {
    return (
      <div role="status" className="alert alert-soft text-sm">
        If {sentTo} is invited to {name}, a sign-in link is on its way. It works once, within{' '}
        {SIGN_IN_LINK_MINUTES} minutes.
      </div>
    )
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="text-sm text-secondary">
        Invited from another organisation? We'll email you a link to sign in.
      </p>
      <div className="flex gap-2">
        <label className="input min-w-0 flex-1">
          <EnvelopeIcon className="size-4 text-muted" />
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            aria-label="Your email address"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending && <span className="loading loading-spinner loading-xs" />}
          Email me a link
        </button>
      </div>
      {error && (
        <div role="alert" className="alert alert-error alert-soft text-sm">
          {error}
        </div>
      )}
    </form>
  )
}

/** Sign in with the instance's method; the API sends the browser back to this page. */
export default function Login() {
  const instance = useInstance()
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const accounts = instance ? allowedAccountsPhrase(instance.auth) : null
  const invites = instance?.capabilities.invites === true
  const params = new URLSearchParams(window.location.search)
  const errorCode = params.get('error')
  const error = errorCode ? loginErrorMessage(errorCode, instance) : null
  const signIn = () => window.location.assign(loginUrl(returnTo()))

  return (
    <AuthCard backdrop={<ThreadBackground />}>
      <h1 className="text-lg font-semibold mb-1">Sign in</h1>
      <p className="text-sm text-secondary mb-5">
        {name} puts a folder of static files online in one command. Sign in to see and manage your
        links.
      </p>
      {error && (
        <div role="alert" className="alert alert-error alert-soft text-sm mb-4">
          {error}
        </div>
      )}
      <button
        type="button"
        className="btn btn-outline w-full justify-start gap-3 font-normal"
        onClick={signIn}
      >
        {instance?.auth.issuer === GOOGLE_ISSUER && <GoogleIcon className="w-5 h-5" />}
        Sign in{instance ? ` with ${instance.auth.displayName}` : ''}
      </button>
      {accounts && (
        <p className="mt-2 text-xs text-muted">
          {accounts.charAt(0).toUpperCase() + accounts.slice(1)} only.
        </p>
      )}
      {invites && (
        <div className="mt-5 pt-5 border-t border-[color:var(--border-subtle)]">
          <EmailLink name={name} open={opensLinkForm(errorCode)} />
        </div>
      )}
    </AuthCard>
  )
}
