import { AuthCard } from '../components/AuthCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { loginUrl } from '../lib/api'

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

// The API redirects failed Google sign-ins to /login?error=<code>.
const LOGIN_ERRORS: Record<string, string> = {
  domain_not_allowed: 'Fling is only for Nearform Google accounts (@nearform.com).',
  email_unverified: 'Your Google account email is not verified.',
  oauth_state_mismatch: 'Sign-in took too long or was started in another tab. Please try again.',
  oauth_failed: 'Google sign-in failed. Please try again.',
}

/** Sign in: Google, Nearform accounts only. The API sends the browser back to this page. */
export default function Login() {
  const params = new URLSearchParams(window.location.search)
  const errorCode = params.get('error')
  const error = errorCode ? (LOGIN_ERRORS[errorCode] ?? LOGIN_ERRORS.oauth_failed) : null
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
        Fling puts a folder of static files online in one command. Sign in to see and manage your
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
        <GoogleIcon className="w-5 h-5" />
        Sign in with Google
      </button>
      <p className="mt-4 text-xs text-muted">Nearform accounts only (@nearform.com).</p>
    </AuthCard>
  )
}
