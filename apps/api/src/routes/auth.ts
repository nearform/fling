/**
 * `/auth/*`: sign-in with the instance's OpenID Connect issuer (auth/oidc.ts). `/auth/login`
 * starts it (or, already signed in, refreshes `fling_site` and goes straight back: the edge sends
 * private-site visitors here) and the issuer returns to `/auth/callback`. Going back to a
 * restricted site takes a site pass, so every way back from signing in goes through
 * `signedInReturn` (sites.ts), which asks policy. State, nonce, the PKCE
 * verifier and the return URL travel in a short-lived `fling_oauth` cookie. `/auth/google` and
 * `/auth/google/callback` are the pre-OIDC paths, kept because existing Google OAuth clients
 * allow only that callback. Also logout, the CLI loopback login and the dev-only login.
 */
import { userSlugFromEmail } from '@fling/shared'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { base64url } from 'jose'
import * as oauth from 'oauth4webapi'
import { mintApiKey } from '../auth/api-keys.ts'
import { cliKeyName, validateCliRedirectUri } from '../auth/cli.ts'
import { admitIdentity, type Identity, type SignInRequest } from '../auth/identity.ts'
import { resolveSession, sessionPrincipal } from '../auth/middleware.ts'
import { safeReturnUrl } from '../auth/return-url.ts'
import { endSession, setSiteCookie, startSession } from '../auth/session.ts'
import { badRequest, forbidden, notFound } from '../lib/errors.ts'
import { canInstance } from '../policy.ts'
import { signedInReturn } from '../sites.ts'
import type { AppEnv } from '../types.ts'

const FLOW_COOKIE = 'fling_oauth'

interface SignInFlow extends SignInRequest {
  ret: string
}

const encodeFlow = (flow: SignInFlow) => base64url.encode(JSON.stringify(flow))

function decodeFlow(value: string | undefined): SignInFlow | null {
  if (!value) return null
  try {
    const f = JSON.parse(new TextDecoder().decode(base64url.decode(value))) as Partial<SignInFlow>
    if (
      typeof f.state !== 'string' ||
      typeof f.nonce !== 'string' ||
      typeof f.codeVerifier !== 'string'
    ) {
      return null
    }
    const ret = typeof f.ret === 'string' ? f.ret : '/'
    return { state: f.state, nonce: f.nonce, codeVerifier: f.codeVerifier, ret }
  } catch {
    return null
  }
}

const returnOf = (c: Context<AppEnv>) => safeReturnUrl(c.req.query('return'), c.get('deps').config)

const loginError = (c: Context<AppEnv>, code: string) =>
  c.redirect(`/login?error=${encodeURIComponent(code)}`, 302)

const warn = (msg: string, err: unknown) =>
  console.warn(JSON.stringify({ level: 'warn', msg, err: String(err), ...oauthDetails(err) }))

/** What the issuer said (oauth4webapi's ResponseBodyError and friends): never tokens or secrets. */
function oauthDetails(err: unknown) {
  if (!err || typeof err !== 'object') return {}
  const e = err as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? v : undefined)
  return {
    code: pick(e.code),
    status: pick(e.status),
    error: pick(e.error),
    error_description: pick(e.error_description),
  }
}

async function upsertUser(c: Context<AppEnv>, email: string, name: string, picture: string | null) {
  const { store, clock } = c.get('deps')
  return store.upsertUser(
    { email, name, picture, preferredSlug: userSlugFromEmail(email) },
    clock.now().toISOString()
  )
}

/** Send the browser to the issuer (or, in local dev without one, to the dev-login form). */
async function beginSignIn(c: Context<AppEnv>, ret: string) {
  const { config, identity } = c.get('deps')
  if (!identity) {
    if (config.devLogin) return c.redirect(`/auth/dev-login?return=${encodeURIComponent(ret)}`, 302)
    throw notFound('Sign-in is not configured')
  }
  const request: SignInRequest = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    codeVerifier: oauth.generateRandomCodeVerifier(),
  }
  let url: URL
  try {
    url = await identity.authorizationUrl(request)
  } catch (err) {
    warn('oidc discovery failed', err)
    return loginError(c, 'oauth_failed')
  }
  setCookie(c, FLOW_COOKIE, encodeFlow({ ...request, ret }), {
    path: '/auth',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'Lax',
    maxAge: 600,
  })
  return c.redirect(url.toString(), 302)
}

export const authRoutes = new Hono<AppEnv>()

/** Signed in → refresh `fling_site` and go back; else sign in first. */
async function login(c: Context<AppEnv>) {
  const ret = returnOf(c)
  const session = await resolveSession(c)
  if (!session) return beginSignIn(c, ret)
  setSiteCookie(c, session.user.email)
  return c.redirect(await signedInReturn(c.get('deps'), session.user, ret), 302)
}

/** The issuer's redirect back: check the flow, verify the identity, apply the email policy. */
async function callback(c: Context<AppEnv>) {
  const { config, identity } = c.get('deps')
  if (!identity) throw notFound('Sign-in is not configured')
  const flow = decodeFlow(getCookie(c, FLOW_COOKIE))
  deleteCookie(c, FLOW_COOKIE, { path: '/auth', secure: config.secureCookies })
  const query = new URL(c.req.url).searchParams
  if (query.get('error')) return loginError(c, 'oauth_failed')
  const state = query.get('state')
  if (!flow || !query.get('code') || !state || state !== flow.state) {
    return loginError(c, 'oauth_state_mismatch')
  }

  let who: Identity
  try {
    who = await identity.exchange(query, flow)
  } catch (err) {
    warn('oidc exchange failed', err)
    return loginError(c, 'oauth_failed')
  }
  const admitted = admitIdentity(who, {
    allowedDomains: config.allowedEmailDomains,
    allowedEmails: config.allowedEmails,
    assumeEmailVerified: config.oidc.assumeEmailVerified,
  })
  if (!admitted.ok) return loginError(c, admitted.reason)

  const user = await upsertUser(c, admitted.email, admitted.name, admitted.picture)
  await startSession(c, user.email)
  return c.redirect(await signedInReturn(c.get('deps'), user, safeReturnUrl(flow.ret, config)), 302)
}

authRoutes.get('/login', login)
authRoutes.get('/callback', callback)
// The pre-OIDC paths: old links, and the callback existing Google OAuth clients allow.
authRoutes.get('/google', login)
authRoutes.get('/google/callback', callback)

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
 * `cli:<hostname>` and 302s to `redirect_uri?key=…`. The key is never logged. Not while
 * impersonating (`account.key.create`): the CLI gets `error=impersonating`.
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
  const session = await resolveSession(c)
  if (!session) {
    const self = new URL('/auth/cli', config.appOrigin)
    self.searchParams.set('redirect_uri', redirectUri.toString())
    const hostname = c.req.query('hostname')
    if (hostname) self.searchParams.set('hostname', hostname)
    if (state) self.searchParams.set('state', state)
    return beginSignIn(c, self.toString())
  }
  const { user } = session
  if (!canInstance(sessionPrincipal(config, session), 'account.key.create')) {
    return back({ error: 'impersonating' })
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
    // A placeholder an instance would admit: an allowed domain, else the first listed address.
    const domain = config.allowedEmailDomains[0]
    const example = domain ? `you@${domain}` : (config.allowedEmails[0] ?? 'you@example.test')
    const attr = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return c.html(
      `<!doctype html><title>Fling dev login</title><form method="get" action="/auth/dev-login">` +
        `<input type="hidden" name="return" value="${attr(ret)}">` +
        `<input name="email" type="email" placeholder="${attr(example)}" autofocus required>` +
        '<button>Sign in</button></form>'
    )
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Invalid email', 'invalid_email')
  const user = await upsertUser(c, email, email.split('@')[0] ?? email, null)
  await startSession(c, user.email)
  return c.redirect(await signedInReturn(c.get('deps'), user, ret), 302)
})
