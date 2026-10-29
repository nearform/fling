/**
 * Where an emailed sign-in link lands (`/sign-in/link`, from `GET /auth/link?t=`). Mail scanners
 * open every link in an email, so opening this page takes nothing and sends nothing: the token
 * travels in the URL's fragment, which no server and no Referer sees, and only the button, a
 * native form POST to `/auth/link/verify`, uses it. The page never submits on its own.
 *
 * It reads the token once, then takes it out of the address bar (history), and asks the browser
 * to send no Referer from here (`<meta name="referrer">`; the UI's own response header says
 * `strict-origin-when-cross-origin`, so no path or fragment leaves the app either way).
 */
import { SIGN_IN_LINK_VERIFY_PATH } from '@fling/shared'
import { useEffect, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { ThreadBackground } from '../components/ThreadBackground'
import { useInstance } from '../hooks/instance'
import { DEFAULT_INSTANCE_NAME } from '../lib/instance'

export interface SignInLinkFragment {
  token: string
  email: string
}

/** The token and address in the page's fragment (`#t=…&email=…`), or null when either is missing. */
export function readLinkFragment(hash: string): SignInLinkFragment | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('t')
  const email = params.get('email')
  return token && email ? { token, email } : null
}

/** The question and its button: a plain form, posted only when the button is pressed. */
export function SignInLinkForm({ instance, link }: { instance: string; link: SignInLinkFragment }) {
  return (
    <form method="post" action={SIGN_IN_LINK_VERIFY_PATH}>
      <h1 className="text-lg font-semibold mb-1">Sign in to {instance}</h1>
      <p className="text-sm text-secondary mb-5">
        Sign in as <span className="font-medium text-base-content">{link.email}</span>? The link
        works once.
      </p>
      <input type="hidden" name="t" value={link.token} />
      <button type="submit" className="btn btn-primary w-full">
        Sign in
      </button>
    </form>
  )
}

export default function SignInLink() {
  const instance = useInstance()
  const name = instance?.name ?? DEFAULT_INSTANCE_NAME
  const [link] = useState(() => readLinkFragment(window.location.hash))

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])

  return (
    <AuthCard backdrop={<ThreadBackground />}>
      {link ? (
        <SignInLinkForm instance={name} link={link} />
      ) : (
        <>
          <h1 className="text-lg font-semibold mb-1">Sign in to {name}</h1>
          <p className="text-sm text-secondary mb-5">
            This page needs the link from your email. Open it again from the email, or ask for a new
            one.
          </p>
          <a className="btn btn-outline w-full" href="/login">
            Go to sign-in
          </a>
        </>
      )}
    </AuthCard>
  )
}
