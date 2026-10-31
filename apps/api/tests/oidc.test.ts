import { SITE_COOKIE_NAME, verifySiteCookie } from '@fling/shared/site-cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_ISSUER, identityProvidersFor, signInProviders } from '../src/auth/oidc.ts'
import { type Config, loadBaseConfig } from '../src/config.ts'
import { instanceMetadata } from '../src/instance.ts'
import { APP_ORIGIN, cookiesOf, type Env, json, setup, testConfig } from './helpers.ts'
import { IDP_ISSUER, type Tamper, type TestIdp, testIdp } from './idp.ts'

const SESSION = '__Host-fling_session'

let env: Env
beforeEach(() => {
  env = setup()
})
afterEach(() => vi.restoreAllMocks())

/** The browser's round trip: start, approve at the IdP, come back to the callback. */
async function signIn(
  e: Env,
  opts: {
    ret?: string
    start?: string
    tamper?: Tamper
    editCallback?: (q: URLSearchParams) => void
    /** Come back to this path instead of the redirect URI's. */
    callbackPath?: string
  } = {}
) {
  const ret = opts.ret ?? 'https://hello.fling.test/page'
  const begin = opts.start ?? '/auth/login'
  const start = await e.app.request(
    `${begin}${begin.includes('?') ? '&' : '?'}return=${encodeURIComponent(ret)}`
  )
  expect(start.status).toBe(302)
  const location = start.headers.get('location') as string
  const flow = cookiesOf(start).fling_oauth?.value as string
  const code = e.idp.authorize(location)
  if (opts.tamper) e.idp.tamperNext(opts.tamper)
  const auth = new URL(location).searchParams
  const back = new URL(auth.get('redirect_uri') as string)
  back.searchParams.set('code', code)
  back.searchParams.set('state', auth.get('state') as string)
  opts.editCallback?.(back.searchParams)
  return e.app.request(`${opts.callbackPath ?? back.pathname}${back.search}`, {
    headers: { cookie: `fling_oauth=${flow}` },
  })
}

const errorOf = (res: Response) => res.headers.get('location')

/** Shaped like a real Google client id: `-` and `.` are what form-encoded Basic auth mangles. */
const GOOGLE_CLIENT_ID = '123456789012-abcdef.apps.googleusercontent.com'
/** Google's discovery (post listed first) and its literal reading of Basic credentials. */
const googleIdp = () =>
  testIdp({
    issuer: GOOGLE_ISSUER,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: 'google-secret',
    authMethods: ['client_secret_post', 'client_secret_basic'],
    literalBasic: true,
  })

describe('OIDC sign-in', () => {
  it('signs in a verified, allowed user: session + site cookie, redirect to return', async () => {
    const res = await signIn(env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    const cookies = cookiesOf(res)
    expect(cookies[SESSION]?.raw).toMatch(/HttpOnly/)
    expect(cookies[SESSION]?.raw).toMatch(/Secure/)
    expect(cookies[SESSION]?.raw).not.toMatch(/Domain/)
    expect(cookies.fling_oauth?.raw).toMatch(/Max-Age=0/)
    const site = cookies[SITE_COOKIE_NAME]
    expect(site?.raw).toMatch(/Domain=\.fling\.test/)
    expect(site?.raw).toMatch(/HttpOnly/)
    expect(site?.raw).toMatch(/SameSite=Lax/)
    const payload = verifySiteCookie(
      site?.value as string,
      env.config.secrets.siteHmacKey,
      Math.floor(env.deps.clock.now().getTime() / 1000)
    )
    expect(payload?.e).toBe('alice@example.test')

    const me = await env.app.request('/api/me', {
      headers: { cookie: `${SESSION}=${cookies[SESSION]?.value}` },
    })
    expect(await json(me)).toMatchObject({
      email: 'alice@example.test',
      name: 'Alice',
      userSlug: 'alice',
    })
  })

  it('sends a standard code + PKCE request to the discovered endpoint', async () => {
    await signIn(env)
    const q = env.idp.lastAuthorization as URLSearchParams
    expect(q.get('redirect_uri')).toBe(`${APP_ORIGIN}/auth/callback`)
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('nonce')).toMatch(/.{20,}/)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('prompt')).toBeNull() // Google-only hints stay with Google
    expect(q.get('hd')).toBeNull()
  })

  it('caches discovery and the JWKS across sign-ins', async () => {
    await signIn(env)
    await signIn(env)
    expect(env.idp.hits).toEqual({ discovery: 1, jwks: 1, token: 2 })
  })

  it('follows a key rotation: an unknown kid refetches the JWKS', async () => {
    expect((await signIn(env)).headers.get('location')).toBe('https://hello.fling.test/page')
    await env.idp.rotate()
    expect((await signIn(env)).headers.get('location')).toBe('https://hello.fling.test/page')
    expect(env.idp.hits.jwks).toBe(2)
  })

  it('refuses a token signed by a key the issuer does not publish', async () => {
    const res = await signIn(env, { tamper: { rogueKey: true } })
    expect(errorOf(res)).toBe('/login?error=oauth_failed')
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
  })

  it.each<[string, Tamper]>([
    ['another nonce', { claims: { nonce: 'replayed' } }],
    ['no nonce', { claims: { nonce: undefined } }],
    ['another audience', { claims: { aud: 'someone-else' } }],
    ['another issuer', { claims: { iss: 'https://evil.example.test' } }],
    ['an expired token', { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }],
    ['a token issued in the future', { claims: { iat: Math.floor(Date.now() / 1000) + 3600 } }],
  ])('refuses %s', async (_, tamper) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await signIn(env, { tamper })
    expect(errorOf(res)).toBe('/login?error=oauth_failed')
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
  })

  it('refuses a state mismatch, a missing flow cookie and an IdP error', async () => {
    expect(errorOf(await signIn(env, { editCallback: q => q.set('state', 'other') }))).toBe(
      '/login?error=oauth_state_mismatch'
    )
    const noCookie = await env.app.request('/auth/callback?code=x&state=y')
    expect(errorOf(noCookie)).toBe('/login?error=oauth_state_mismatch')
    const denied = await signIn(env, { editCallback: q => q.set('error', 'access_denied') })
    expect(errorOf(denied)).toBe('/login?error=oauth_failed')
  })

  it('says the issuer refused someone its own access check turned away (Cognito)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refuse = {
      error: 'invalid_request',
      error_description: 'UserLambdaValidationException: PreTokenGeneration failed',
    }
    const res = await signIn(env, { tamper: { refuse } })
    expect(errorOf(res)).toBe('/login?error=access_denied')
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
    // Not an OAuth error body at all: still a refusal.
    const bare = { __type: 'UserLambdaValidationException', message: 'no' }
    expect(errorOf(await signIn(env, { tamper: { refuse: bare } }))).toBe(
      '/login?error=access_denied'
    )
  })

  it('authenticates with client_secret_post when offered, else client_secret_basic', async () => {
    expect((await signIn(env)).headers.get('location')).toBe('https://hello.fling.test/page')
    expect(env.idp.lastClientAuth).toBe('post')

    const basicOnly = setup({}, testIdp({ authMethods: ['client_secret_basic'] }))
    const res = await signIn(basicOnly)
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(basicOnly.idp.lastClientAuth).toBe('basic')
  })

  it('refuses a code the IdP will not redeem (e.g. replayed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await signIn(env, { editCallback: q => q.set('code', 'code-unknown') })
    expect(errorOf(res)).toBe('/login?error=oauth_failed')
  })

  it.each([
    [{ email_verified: false }, 'email_unverified'],
    [{ email_verified: undefined }, 'email_unverified'],
    [{ email: 'eve@elsewhere.test' }, 'domain_not_allowed'],
    [{ email: 'eve@evil.example.test' }, 'domain_not_allowed'],
  ])('applies the email policy to %j', async (claims, reason) => {
    const res = await signIn(env, { tamper: { claims } })
    expect(errorOf(res)).toBe(`/login?error=${reason}`)
    expect(cookiesOf(res)[SESSION]).toBeUndefined()
    expect(await env.store.getUser('eve@elsewhere.test')).toBeNull()
  })

  it('admits an address listed in ALLOWED_EMAILS on a domain that is not allowed', async () => {
    env = setup({ allowedEmails: ['me@gmail.test'] })
    const res = await signIn(env, { tamper: { claims: { email: 'Me@gmail.test' } } })
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(await env.store.getUser('me@gmail.test')).not.toBeNull()
    const other = await signIn(env, { tamper: { claims: { email: 'you@gmail.test' } } })
    expect(errorOf(other)).toBe('/login?error=domain_not_allowed')
  })

  it('admits an invited address outside the policy while its invitation stands', async () => {
    env.config.invites = true
    const outsider = { claims: { email: 'pat@outside.test' } }
    expect(errorOf(await signIn(env, { tamper: outsider }))).toBe('/login?error=domain_not_allowed')
    await env.store.putInvitation({
      email: 'pat@outside.test',
      role: 'member',
      invitedBy: 'admin@example.test',
      via: 'admin',
      createdAt: env.deps.clock.now().toISOString(),
    })
    const res = await signIn(env, { tamper: outsider })
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(await env.store.getUser('pat@outside.test')).not.toBeNull()
    await env.store.revokeInvitation('pat@outside.test', env.deps.clock.now().toISOString())
    expect(errorOf(await signIn(env, { tamper: outsider }))).toBe('/login?error=domain_not_allowed')
  })

  it('OIDC_ASSUME_EMAIL_VERIFIED trusts a missing email_verified, never an explicit false', async () => {
    const config = testConfig()
    env = setup({ oidc: { ...config.oidc, assumeEmailVerified: true } })
    const missing = await signIn(env, { tamper: { claims: { email_verified: undefined } } })
    expect(missing.headers.get('location')).toBe('https://hello.fling.test/page')
    const unverified = await signIn(env, { tamper: { claims: { email_verified: false } } })
    expect(errorOf(unverified)).toBe('/login?error=email_unverified')
  })

  it('a discovery failure is a sign-in error, retried next time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const idp = testIdp()
    const real = idp.fetch
    let down = true
    idp.fetch = ((input, init) =>
      down
        ? Promise.resolve(new Response('no', { status: 503 }))
        : real(input, init)) as typeof fetch
    env = setup({}, idp)
    const res = await env.app.request('/auth/login')
    expect(errorOf(res)).toBe('/login?error=oauth_failed')
    down = false
    expect((await signIn(env)).headers.get('location')).toBe('https://hello.fling.test/page')
  })
})

/** The Google client's config: GOOGLE_CLIENT_ID/SECRET, with or without OIDC_ISSUER. */
const googleClient = (withOidc = false) => {
  const config = testConfig()
  return {
    oidc: withOidc ? config.oidc : { assumeEmailVerified: false },
    secrets: {
      ...config.secrets,
      ...(withOidc ? {} : { oidcClientSecret: undefined }),
      googleClientId: GOOGLE_CLIENT_ID,
      googleClientSecret: 'google-secret',
    },
  }
}

describe('Google client', () => {
  it('reads GOOGLE_CLIENT_ID/SECRET as accounts.google.com on /auth/google/callback', () => {
    const e = setup(googleClient(), googleIdp())
    expect(signInProviders(e.config)).toEqual([
      expect.objectContaining({
        id: 'google',
        issuer: GOOGLE_ISSUER,
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: 'google-secret',
        displayName: 'Google',
        redirectUri: `${APP_ORIGIN}/auth/google/callback`,
        authParams: { prompt: 'select_account', hd: 'example.test' },
      }),
    ])
    expect(instanceMetadata(e.config).auth).toEqual({
      kind: 'oidc',
      issuer: GOOGLE_ISSUER,
      displayName: 'Google',
      providers: [{ id: 'google', displayName: 'Google', issuer: GOOGLE_ISSUER }],
      emailDomains: ['example.test'],
    })
  })

  it("drops Google's hd hint when it would turn away an invited address", () => {
    const params = (overrides: Partial<Config>) =>
      signInProviders(setup({ ...googleClient(), ...overrides }, googleIdp()).config)[0]?.authParams
    expect(params({})).toEqual({ prompt: 'select_account', hd: 'example.test' })
    expect(params({ allowedEmails: ['me@gmail.test'] })).toEqual({ prompt: 'select_account' })
    expect(params({ allowedEmailDomains: [], allowedEmails: ['me@gmail.test'] })).toEqual({
      prompt: 'select_account',
    })
    expect(params({ allowedEmailDomains: ['a.test', 'b.test'] })).toEqual({
      prompt: 'select_account',
    })
  })

  it.each(['/auth/google', '/auth/login'])('signs in alone, started at %s', async start => {
    const e = setup(googleClient(), googleIdp())
    e.idp.claims.hd = 'example.test'
    const res = await signIn(e, { start })
    expect(e.idp.lastAuthorization?.get('redirect_uri')).toBe(`${APP_ORIGIN}/auth/google/callback`)
    expect(e.idp.lastAuthorization?.get('prompt')).toBe('select_account')
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(cookiesOf(res)[SESSION]).toBeDefined()
    // Basic would send 123456789012%2Dabcdef%2Eapps…, which Google answers with invalid_client.
    expect(e.idp.lastClientAuth).toBe('post')
  })

  it('is not offered twice when OIDC_ISSUER is Google itself', () => {
    const config = testConfig()
    const cfg = {
      ...config,
      oidc: { ...config.oidc, issuer: GOOGLE_ISSUER },
      secrets: { ...config.secrets, googleClientId: 'g', googleClientSecret: 'g' },
    }
    expect(signInProviders(cfg).map(p => [p.id, p.redirectUri])).toEqual([
      ['oidc', `${APP_ORIGIN}/auth/callback`],
    ])
  })
})

describe('two sign-in providers', () => {
  /** Google's client and OIDC_ISSUER together, each with its own in-process IdP. */
  function dual() {
    const google = googleIdp()
    const oidc = testIdp()
    const e = setup(googleClient(true), oidc)
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      return (url.origin === new URL(GOOGLE_ISSUER).origin ? google : oidc).fetch(input, init)
    }) as typeof globalThis.fetch
    e.deps.identities = identityProvidersFor(e.config, { fetch, jwksCooldownMs: 0 })
    return { e, google, oidc }
  }
  /** Sign in with one of them: the env's `idp` is the one that approves. */
  const as = (e: Env, idp: TestIdp): Env => ({ ...e, idp })

  it('offers both, Google first, in the metadata', () => {
    const { e } = dual()
    expect(instanceMetadata(e.config).auth).toEqual({
      kind: 'oidc',
      displayName: 'Google or Single sign-on',
      providers: [
        { id: 'google', displayName: 'Google', issuer: GOOGLE_ISSUER },
        { id: 'oidc', displayName: 'Single sign-on', issuer: IDP_ISSUER },
      ],
      emailDomains: ['example.test'],
    })
  })

  it('without a provider, sends the browser to the login page to choose', async () => {
    const { e } = dual()
    const ret = 'https://hello.fling.test/page'
    const res = await e.app.request(`/auth/login?return=${encodeURIComponent(ret)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/login?return=${encodeURIComponent(ret)}`)
    expect(cookiesOf(res).fling_oauth).toBeUndefined()
    const unknown = await e.app.request(
      `/auth/login?provider=nope&return=${encodeURIComponent(ret)}`
    )
    expect(unknown.headers.get('location')).toBe(`/login?return=${encodeURIComponent(ret)}`)
  })

  it.each([
    ['google', '/auth/google/callback'],
    ['oidc', '/auth/callback'],
  ])('signs in with %s on its own callback', async (provider, path) => {
    const { e, google, oidc } = dual()
    const idp = provider === 'google' ? google : oidc
    const res = await signIn(as(e, idp), { start: `/auth/login?provider=${provider}` })
    expect(idp.lastAuthorization?.get('redirect_uri')).toBe(`${APP_ORIGIN}${path}`)
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(cookiesOf(res)[SESSION]).toBeDefined()
  })

  it('is one user whichever provider they sign in with', async () => {
    const { e, google, oidc } = dual()
    await signIn(as(e, google), { start: '/auth/google' })
    google.claims.name = 'Alice G'
    oidc.claims.sub = 'another-sub'
    await signIn(as(e, oidc), { start: '/auth/login?provider=oidc' })
    const { users } = await e.store.listUsers({ prefix: 'alice@', limit: 10 })
    expect(users.map(u => u.email)).toEqual(['alice@example.test'])
  })

  it("refuses a flow on the other provider's callback", async () => {
    const { e, oidc } = dual()
    const res = await signIn(as(e, oidc), {
      start: '/auth/login?provider=oidc',
      callbackPath: '/auth/google/callback',
    })
    expect(errorOf(res)).toBe('/login?error=oauth_state_mismatch')
    expect(oidc.hits.token).toBe(0)
  })

  it('applies the same email policy to both', async () => {
    const { e, google, oidc } = dual()
    const outsider = { claims: { email: 'eve@elsewhere.test' } }
    for (const [idp, start] of [
      [google, '/auth/google'],
      [oidc, '/auth/login?provider=oidc'],
    ] as const) {
      const res = await signIn(as(e, idp), { start, tamper: outsider })
      expect(errorOf(res)).toBe('/login?error=domain_not_allowed')
    }
    const unverified = await signIn(as(e, oidc), {
      start: '/auth/login?provider=oidc',
      tamper: { claims: { email_verified: undefined } },
    })
    expect(errorOf(unverified)).toBe('/login?error=email_unverified')
  })

  it('sends the CLI login to the login page, then back to /auth/cli with either', async () => {
    const { e, oidc } = dual()
    const cli = '/auth/cli?redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=s1'
    const first = await e.app.request(cli)
    const choose = new URL(first.headers.get('location') as string, APP_ORIGIN)
    expect(choose.pathname).toBe('/login')
    const ret = choose.searchParams.get('return') as string
    expect(ret).toMatch(/^https:\/\/fling\.test\/auth\/cli\?/)
    const res = await signIn(as(e, oidc), { start: '/auth/login?provider=oidc', ret })
    expect(res.headers.get('location')).toBe(ret)
  })
})

describe('sign-in config', () => {
  const base = {
    APP_ENV: 'production',
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    TABLE_NAME: 't',
    SITES_BUCKET: 'b',
    KVS_ARN: 'k',
  }
  const secrets = { sessionSecret: 's'.repeat(40), siteHmacKey: 'h'.repeat(40) }

  it('reads OIDC_*: display name derived from the issuer unless set, scopes', () => {
    const cfg = (env: Record<string, string>) => ({
      ...loadBaseConfig({ ...base, OIDC_CLIENT_ID: 'c', ...env }),
      secrets: { ...secrets, oidcClientSecret: 'x' },
    })
    const name = (issuer: string) => signInProviders(cfg({ OIDC_ISSUER: issuer }))[0]?.displayName
    expect(name(GOOGLE_ISSUER)).toBe('Google')
    expect(name('https://login.microsoftonline.com/0000-tenant/v2.0')).toBe('Microsoft')
    expect(name('https://example-test.okta.com')).toBe('Okta')
    expect(name('https://example-test.eu.auth0.com/')).toBe('Auth0')
    expect(name('https://sso.example.test/realms/staff')).toBe('Single sign-on')
    const [custom] = signInProviders(
      cfg({
        OIDC_ISSUER: 'https://sso.example.test',
        OIDC_DISPLAY_NAME: 'Example SSO',
        OIDC_SCOPES: 'openid email',
      })
    )
    expect(custom).toMatchObject({ displayName: 'Example SSO', scopes: ['openid', 'email'] })
  })

  it('refuses half or missing configuration in production', () => {
    expect(() => loadBaseConfig({ ...base, OIDC_ISSUER: 'https://sso.example.test' })).toThrow(
      /go together/
    )
    expect(() =>
      loadBaseConfig({ ...base, OIDC_ISSUER: 'http://sso.example.test', OIDC_CLIENT_ID: 'c' })
    ).toThrow(/https/)
    const noSecret = {
      ...loadBaseConfig({ ...base, OIDC_ISSUER: 'https://sso.example.test', OIDC_CLIENT_ID: 'c' }),
      secrets,
    }
    expect(() => signInProviders(noSecret)).toThrow(/OIDC_CLIENT_SECRET/)
    expect(() => signInProviders({ ...loadBaseConfig(base), secrets })).toThrow(/not configured/)
    expect(signInProviders({ ...loadBaseConfig({}), secrets })).toEqual([]) // dev: dev-login
  })
})
