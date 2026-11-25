/**
 * How the scenario signs in: the instance's dev login (DEV_LOGIN, never in production) gives a
 * browser session and the `fling_site` cookie, and the CLI's own loopback login turns the session
 * into an API key.
 */
export interface Session {
  email: string
  apiKey: string
  /** `fling_site=…` for private sites, when the sign-in gives one */
  siteCookie?: string
  /** the browser session's cookies (`name=value; …`), when the sign-in gives one */
  cookie?: string
}

/** `name=value` pairs of a response's Set-Cookie headers. */
export function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map(c => c.split(';')[0] as string)
}

export async function devLogin(appOrigin: string, email: string): Promise<Session> {
  const login = await fetch(
    `${appOrigin}/auth/dev-login?email=${encodeURIComponent(email)}&return=${encodeURIComponent('/')}`,
    { redirect: 'manual' }
  )
  if (login.status !== 302) throw new Error(`dev login: ${login.status} (is DEV_LOGIN on?)`)
  const cookies = cookiePairs(login)
  const siteCookie = cookies.find(c => c.startsWith('fling_site='))
  // The browser half of `fling login`: a signed-in session mints a key for the loopback callback.
  const cli = await fetch(
    `${appOrigin}/auth/cli?redirect_uri=${encodeURIComponent('http://127.0.0.1:9/callback')}&hostname=e2e&state=e2e`,
    { redirect: 'manual', headers: { cookie: cookies.join('; ') } }
  )
  const location = cli.headers.get('location')
  const apiKey = location ? new URL(location).searchParams.get('key') : null
  if (!apiKey) throw new Error(`CLI login: ${cli.status} ${location}`)
  return { email, apiKey, siteCookie, cookie: cookies.join('; ') }
}
