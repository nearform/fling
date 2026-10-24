import { emailDomainsPhrase, type InstanceMetadata } from '@fling/shared'
import { AuthCard } from '../components/AuthCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { useInstance } from '../hooks/instance'
import { loginUrl } from '../lib/api'
import { DEFAULT_INSTANCE_NAME } from '../lib/instance'

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

/** The message for a failed sign-in: the API redirects to /login?error=<code>. */
export function loginErrorMessage(code: string, instance: InstanceMetadata | null): string {
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const provider = instance?.auth.displayName
  const domains = instance ? emailDomainsPhrase(instance.auth) : null
  switch (code) {
    case 'domain_not_allowed':
      return domains
        ? `Only ${domains} accounts can sign in to ${name}.`
        : `That account can't sign in to ${name}.`
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

/** Sign in with the instance's method; the API sends the browser back to this page. */
export default function Login() {
  const instance = useInstance()
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const domains = instance ? emailDomainsPhrase(instance.auth) : null
  const params = new URLSearchParams(window.location.search)
  const errorCode = params.get('error')
  const error = errorCode ? loginErrorMessage(errorCode, instance) : null
  const signIn = () => {
    // From the /login error page, come back to the app home rather than to /login again.
    const back =
      window.location.pathname === '/login' ? `${window.location.origin}/` : window.location.href
    window.location.assign(loginUrl(back))
  }

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
        {instance?.auth.kind === 'google' && <GoogleIcon className="w-5 h-5" />}
        Sign in{instance ? ` with ${instance.auth.displayName}` : ''}
      </button>
      {domains && <p className="mt-4 text-xs text-muted">{domains} accounts only.</p>}
    </AuthCard>
  )
}
