import { SITE_COOKIE_NAME, verifySiteCookie } from '@fling/shared/site-cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_ISSUER, oidcSettings } from '../src/auth/oidc.ts'
import { type Config, loadBaseConfig } from '../src/config.ts'
import { instanceMetadata } from '../src/instance.ts'
import { APP_ORIGIN, cookiesOf, type Env, json, setup, testConfig } from './helpers.ts'
import { type Tamper, testIdp } from './idp.ts'

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
  } = {}
) {
  const ret = opts.ret ?? 'https://hello.fling.test/page'
  const start = await e.app.request(
    `${opts.start ?? '/auth/login'}?return=${encodeURIComponent(ret)}`
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
  return e.app.request(`${back.pathname}${back.search}`, {
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

describe('legacy Google config', () => {
  const legacy = () => {
    const config = testConfig()
    return {
      oidc: { assumeEmailVerified: false },
      secrets: {
        ...config.secrets,
        oidcClientSecret: undefined,
        googleClientId: GOOGLE_CLIENT_ID,
        googleClientSecret: 'google-secret',
      },
    }
  }

  it('maps the old Google secrets to accounts.google.com on the old callback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = setup(legacy(), googleIdp())
    expect(oidcSettings(e.config)).toMatchObject({
      issuer: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: 'google-secret',
      displayName: 'Google',
      redirectUri: `${APP_ORIGIN}/auth/google/callback`,
      authParams: { prompt: 'select_account', hd: 'example.test' },
      legacy: true,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deprecated sign-in config'))
    expect(instanceMetadata(e.config).auth).toEqual({
      kind: 'oidc',
      issuer: GOOGLE_ISSUER,
      displayName: 'Google',
      emailDomains: ['example.test'],
    })
  })

  it("drops Google's hd hint when it would turn away an invited address", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = (overrides: Partial<Config>) =>
      oidcSettings(setup({ ...legacy(), ...overrides }, googleIdp()).config)?.authParams
    expect(params({})).toEqual({ prompt: 'select_account', hd: 'example.test' })
    expect(params({ allowedEmails: ['me@gmail.test'] })).toEqual({ prompt: 'select_account' })
    expect(params({ allowedEmailDomains: [], allowedEmails: ['me@gmail.test'] })).toEqual({
      prompt: 'select_account',
    })
    expect(params({ allowedEmailDomains: ['a.test', 'b.test'] })).toEqual({
      prompt: 'select_account',
    })
  })

  it('signs in through the legacy /auth/google routes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = setup(legacy(), googleIdp())
    e.idp.claims.hd = 'example.test'
    const res = await signIn(e, { start: '/auth/google' })
    expect(e.idp.lastAuthorization?.get('redirect_uri')).toBe(`${APP_ORIGIN}/auth/google/callback`)
    expect(e.idp.lastAuthorization?.get('prompt')).toBe('select_account')
    expect(res.headers.get('location')).toBe('https://hello.fling.test/page')
    expect(cookiesOf(res)[SESSION]).toBeDefined()
    // Basic would send 123456789012%2Dabcdef%2Eapps…, which Google answers with invalid_client.
    expect(e.idp.lastClientAuth).toBe('post')
  })

  it('the generic callback serves the generic config; OIDC_* wins over the old secrets', () => {
    const config = testConfig()
    const both = {
      ...config,
      secrets: { ...config.secrets, googleClientId: 'g', googleClientSecret: 'g' },
    }
    expect(oidcSettings(both)).toMatchObject({
      issuer: 'https://idp.example.test',
      redirectUri: `${APP_ORIGIN}/auth/callback`,
      legacy: false,
    })
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
    const name = (issuer: string) => oidcSettings(cfg({ OIDC_ISSUER: issuer }))?.displayName
    expect(name(GOOGLE_ISSUER)).toBe('Google')
    expect(name('https://login.microsoftonline.com/0000-tenant/v2.0')).toBe('Microsoft')
    expect(name('https://example-test.okta.com')).toBe('Okta')
    expect(name('https://example-test.eu.auth0.com/')).toBe('Auth0')
    expect(name('https://sso.example.test/realms/staff')).toBe('sso.example.test')
    const custom = oidcSettings(
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
    expect(() => oidcSettings(noSecret)).toThrow(/OIDC_CLIENT_SECRET/)
    expect(() => oidcSettings({ ...loadBaseConfig(base), secrets })).toThrow(/not configured/)
    expect(oidcSettings({ ...loadBaseConfig({}), secrets })).toBeNull() // dev: dev-login
  })
})
