/**
 * `/auth/*`: Google OAuth (rocketpod's arctic + PKCE flow; state, verifier and the return URL
 * travel in a short-lived `fling_oauth` cookie), `/auth/login` (used by the edge for private
 * sites), logout, the CLI loopback login and the dev-only login.
 */
import { userSlugFromEmail } from '@fling/shared'
import { generateCodeVerifier, generateState } from 'arctic'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { mintApiKey } from '../auth/api-keys.ts'
import { cliKeyName, validateCliRedirectUri } from '../auth/cli.ts'
import { admitGoogleClaims, googleClient } from '../auth/google.ts'
import { safeReturnUrl } from '../auth/return-url.ts'
import {
  endSession,
  readSessionToken,
  setSiteCookie,
  startSession,
  verifySession,
} from '../auth/session.ts'
import { badRequest, forbidden, notFound } from '../lib/errors.ts'
import type { User } from '../store/types.ts'
import type { AppEnv } from '../types.ts'

const OAUTH_COOKIE = 'fling_oauth'

interface OAuthFlow {
  state: string
  verifier: string
  ret: string
}

const encodeFlow = (flow: OAuthFlow) => Buffer.from(JSON.stringify(flow)).toString('base64url')

function decodeFlow(value: string | undefined): OAuthFlow | null {
  if (!value) return null
  try {
    const f = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<OAuthFlow>
    if (typeof f.state !== 'string' || typeof f.verifier !== 'string') return null
    return { state: f.state, verifier: f.verifier, ret: typeof f.ret === 'string' ? f.ret : '/' }
  } catch {
    return null
  }
}

const googleConfigured = (c: Context<AppEnv>) => {
  const { secrets } = c.get('deps').config
  return Boolean(c.get('deps').oauth || (secrets.googleClientId && secrets.googleClientSecret))
}

const oauthClient = (c: Context<AppEnv>) =>
  c.get('deps').oauth ?? googleClient(c.get('deps').config)

const returnOf = (c: Context<AppEnv>) => safeReturnUrl(c.req.query('return'), c.get('deps').config)

const loginError = (c: Context<AppEnv>, code: string) =>
  c.redirect(`/login?error=${encodeURIComponent(code)}`, 302)

async function sessionUser(c: Context<AppEnv>): Promise<User | null> {
  const { config, clock, store } = c.get('deps')
  const email = await verifySession(readSessionToken(c), config.secrets.sessionSecret, clock.now())
  return email ? store.getUser(email) : null
}

async function upsertUser(c: Context<AppEnv>, email: string, name: string, picture: string | null) {
  const { store, clock } = c.get('deps')
  return store.upsertUser(
    { email, name, picture, preferredSlug: userSlugFromEmail(email) },
    clock.now().toISOString()
  )
}

/** Where to send someone who needs to sign in. */
function signInUrl(c: Context<AppEnv>, ret: string) {
  const q = `?return=${encodeURIComponent(ret)}`
  if (!googleConfigured(c) && c.get('deps').config.devLogin) return `/auth/dev-login${q}`
  return `/auth/google${q}`
}

export const authRoutes = new Hono<AppEnv>()

authRoutes.get('/google', c => {
  const { config } = c.get('deps')
  if (!googleConfigured(c)) {
    // Local dev without Google credentials: the UI's sign-in button lands on the dev form.
    if (config.devLogin) return c.redirect(signInUrl(c, returnOf(c)), 302)
    throw notFound('Google sign-in is not configured')
  }
  const state = generateState()
  const verifier = generateCodeVerifier()
  const url = oauthClient(c).authorizationUrl(state, verifier)
  setCookie(c, OAUTH_COOKIE, encodeFlow({ state, verifier, ret: returnOf(c) }), {
    path: '/auth',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge: 600,
  })
  return c.redirect(url.toString(), 302)
})

authRoutes.get('/google/callback', async c => {
  const { config } = c.get('deps')
  if (!googleConfigured(c)) throw notFound('Google sign-in is not configured')
  const flow = decodeFlow(getCookie(c, OAUTH_COOKIE))
  deleteCookie(c, OAUTH_COOKIE, { path: '/auth', secure: config.secureCookies })
  if (c.req.query('error')) return loginError(c, 'oauth_failed')
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!flow || !code || !state || state !== flow.state) return loginError(c, 'oauth_state_mismatch')

  let claims: Awaited<ReturnType<ReturnType<typeof oauthClient>['exchange']>>
  try {
    claims = await oauthClient(c).exchange(code, flow.verifier)
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'oauth exchange failed', err: String(err) }))
    return loginError(c, 'oauth_failed')
  }
  const admitted = admitGoogleClaims(claims, config.allowedEmailDomains)
  if (!admitted.ok) return loginError(c, admitted.reason)

  const user = await upsertUser(c, admitted.email, admitted.name, admitted.picture)
  await startSession(c, user.email)
  return c.redirect(safeReturnUrl(flow.ret, config), 302)
})

/** Signed in → refresh `fling_site` and go back; else sign in first. */
authRoutes.get('/login', async c => {
  const ret = returnOf(c)
  const user = await sessionUser(c)
  if (!user) return c.redirect(signInUrl(c, ret), 302)
  setSiteCookie(c, user.email)
  return c.redirect(ret, 302)
})

authRoutes.post('/logout', c => {
  const origin = c.req.header('origin')
  if (origin !== c.get('deps').config.appOrigin) {
    throw forbidden('Cross-origin request refused', 'csrf')
  }
  endSession(c)
  return c.json({ ok: true })
})

/**
 * `GET /auth/cli?redirect_uri=&hostname=`: browser half of `fling login`. Mints an API key named
 * `cli:<hostname>` and 302s to `redirect_uri?key=…`. The key is never logged.
 */
authRoutes.get('/cli', async c => {
  const { store, clock, config } = c.get('deps')
  const redirectUri = validateCliRedirectUri(c.req.query('redirect_uri'))
  if (!redirectUri) {
    throw badRequest(
      'redirect_uri must be http://127.0.0.1:<port>/callback or http://localhost:<port>/callback',
      'invalid_redirect_uri'
    )
  }
  // The CLI's CSRF token for its loopback listener; echoed back untouched.
  const state = c.req.query('state')
  const back = (params: Record<string, string>) => {
    const target = new URL(redirectUri.toString())
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
    if (state) target.searchParams.set('state', state)
    return c.redirect(target.toString(), 302)
  }
  if (state !== undefined && !/^[A-Za-z0-9._~-]{1,256}$/.test(state)) {
    return c.redirect(`${redirectUri.toString()}?error=invalid_state`, 302)
  }
  const user = await sessionUser(c)
  if (!user) {
    const self = new URL('/auth/cli', config.appOrigin)
    self.searchParams.set('redirect_uri', redirectUri.toString())
    const hostname = c.req.query('hostname')
    if (hostname) self.searchParams.set('hostname', hostname)
    if (state) self.searchParams.set('state', state)
    return c.redirect(signInUrl(c, self.toString()), 302)
  }
  try {
    const { plaintext } = await mintApiKey(
      store,
      user.email,
      cliKeyName(c.req.query('hostname')),
      clock.now()
    )
    return back({ key: plaintext })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'cli key mint failed', err: String(err) }))
    return back({ error: 'key_mint_failed' })
  }
})

/** Dev only: `GET /auth/dev-login?email=&return=` signs in as anyone; no email → a tiny form. */
authRoutes.get('/dev-login', async c => {
  const { config } = c.get('deps')
  if (!config.devLogin) throw notFound(`Not found: ${c.req.path}`)
  const email = c.req.query('email')?.trim().toLowerCase()
  const ret = returnOf(c)
  if (!email) {
    const esc = ret.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return c.html(
      `<!doctype html><title>Fling dev login</title><form method="get" action="/auth/dev-login">` +
        `<input type="hidden" name="return" value="${esc}">` +
        `<input name="email" type="email" placeholder="you@${config.allowedEmailDomains[0]}" autofocus required>` +
        '<button>Sign in</button></form>'
    )
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Invalid email', 'invalid_email')
  const user = await upsertUser(c, email, email.split('@')[0] ?? email, null)
  await startSession(c, user.email)
  return c.redirect(ret, 302)
})
