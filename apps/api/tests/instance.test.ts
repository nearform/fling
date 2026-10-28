import { CORE_CAPABILITIES, INSTANCE_METADATA_PATH, InstanceMetadataSchema } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { loadBaseConfig } from '../src/config.ts'
import { instanceMetadata } from '../src/instance.ts'
import { setup, testConfig } from './helpers.ts'

const PROD = {
  APP_ENV: 'production',
  APP_ORIGIN: 'https://fling.example.test',
  SITES_DOMAIN: 'fling.example.test',
  ALLOWED_EMAIL_DOMAINS: 'example.test',
  STORE_DRIVER: 'memory',
  STORAGE_DRIVER: 'fs',
  KVS_DRIVER: 'memory',
}

describe('GET /.well-known/fling', () => {
  it('describes the instance from config: public, cacheable, readable cross-origin', async () => {
    const env = setup()
    const res = await env.app.request(INSTANCE_METADATA_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = await res.json()
    expect(InstanceMetadataSchema.parse(body)).toEqual(body)
    expect(body).toEqual({
      version: 1,
      name: 'Fling',
      appOrigin: 'https://fling.test',
      sitesDomain: 'fling.test',
      siteScheme: 'https',
      auth: {
        kind: 'oidc',
        issuer: 'https://idp.example.test',
        displayName: 'idp.example.test',
        emailDomains: ['example.test'],
      },
      brand: { colors: {} },
      capabilities: expect.objectContaining({ ...CORE_CAPABILITIES, comments: true }),
      installCommand: expect.stringMatching(/^npm install -g \S+$/),
    })
  })

  it('advertises live rooms only with LIVE_URL, comments on and LIVE not off', async () => {
    const live = (env: Record<string, string>) => loadBaseConfig({ ...PROD, ...env }).live
    expect(live({})).toBe(false)
    expect(live({ LIVE_URL: 'wss://live.example.test/live' })).toBe(true)
    expect(live({ LIVE_URL: 'wss://live.example.test/live', LIVE: 'off' })).toBe(false)
    expect(live({ LIVE_URL: 'wss://live.example.test/live', COMMENTS: 'false' })).toBe(false)
    expect(() => live({ LIVE_URL: 'ws://live.example.test/live' })).toThrow(/wss/)
    expect(() => live({ LIVE_URL: 'https://live.example.test/live' })).toThrow()
    const env = setup({ live: true, liveUrl: 'wss://live.example.test/live' })
    const body = await (await env.app.request(INSTANCE_METADATA_PATH)).json()
    expect(body.capabilities.live).toBe(true)
    expect(JSON.stringify(body)).not.toContain('live.example.test')
  })

  it('says there are invited addresses, never which', async () => {
    const base = loadBaseConfig({
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      ALLOWED_EMAILS: 'Me@Gmail.test, other@elsewhere.test',
    })
    const env = setup({ allowedEmails: base.allowedEmails })
    const text = await (await env.app.request(INSTANCE_METADATA_PATH)).text()
    expect(text).not.toMatch(/gmail|elsewhere/i)
    expect(JSON.parse(text).auth).toEqual({
      kind: 'oidc',
      issuer: 'https://idp.example.test',
      displayName: 'idp.example.test',
      emailDomains: ['example.test'],
      invitedEmails: true,
    })
    expect(InstanceMetadataSchema.parse(JSON.parse(text)).auth.invitedEmails).toBe(true)
  })

  it('dev login publishes the domains its email policy admits, as OIDC does', () => {
    const dev = (env: Record<string, string>) =>
      instanceMetadata({ ...testConfig(), ...loadBaseConfig({ DEV_LOGIN: '1', ...env }) }).auth
    expect(dev({})).toEqual({
      kind: 'dev',
      displayName: 'Dev login',
      emailDomains: ['example.test'],
    })
    expect(dev({ ALLOWED_EMAIL_DOMAINS: 'a.test,b.test' }).emailDomains).toEqual([
      'a.test',
      'b.test',
    ])
    const invited = dev({ ALLOWED_EMAILS: 'me@gmail.test' })
    expect(invited).toMatchObject({ emailDomains: [], invitedEmails: true })
    expect(JSON.stringify(invited)).not.toContain('gmail')
  })

  it('never names the admins', async () => {
    const env = setup({ adminEmails: ['boss@example.test'] })
    const text = await (await env.app.request(INSTANCE_METADATA_PATH)).text()
    expect(text).not.toMatch(/boss|admin/i)
  })

  it('carries the configured name, brand and install command', async () => {
    const base = loadBaseConfig({
      APP_ENV: 'development',
      INSTANCE_NAME: 'Acme Fling',
      INSTALL_COMMAND: 'npx acme-fling',
      BRAND_PRIMARY: '#00e5a4',
      BRAND_INK: '#000E38',
      BRAND_LOGO_URL: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
    })
    const env = setup({
      instanceName: base.instanceName,
      brand: base.brand,
      installCommand: base.installCommand,
    })
    const body = await (await env.app.request(INSTANCE_METADATA_PATH)).json()
    expect(body).toMatchObject({
      name: 'Acme Fling',
      installCommand: 'npx acme-fling',
      brand: {
        logoUrl: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',
        colors: { primary: '#00e5a4', ink: '#000E38' },
      },
    })
    expect(body.brand.colors).not.toHaveProperty('accent')
  })
})

describe('instance config', () => {
  const prod = {
    APP_ENV: 'production',
    APP_ORIGIN: 'https://fling.example.test',
    SITES_DOMAIN: 'sites.example.test',
    STORE_DRIVER: 'memory',
    STORAGE_DRIVER: 'fs',
    KVS_DRIVER: 'memory',
  }

  it('requires the email allowlist in production (never a built-in default)', () => {
    expect(() => loadBaseConfig(prod)).toThrow(
      /ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS is required/
    )
    expect(() => loadBaseConfig({ ...prod, ALLOWED_EMAILS: ' , ' })).toThrow()
    expect(loadBaseConfig({ ...prod, ALLOWED_EMAIL_DOMAINS: 'A.test, b.test' })).toMatchObject({
      allowedEmailDomains: ['a.test', 'b.test'],
      allowedEmails: [],
    })
    expect(loadBaseConfig({}).allowedEmailDomains).toEqual(['example.test'])
    expect(loadBaseConfig({}).allowedEmails).toEqual([])
  })

  it('takes individual addresses instead of, or as well as, domains', () => {
    expect(
      loadBaseConfig({ ...prod, ALLOWED_EMAILS: ' Me@Gmail.test ,you@gmail.test' })
    ).toMatchObject({ allowedEmailDomains: [], allowedEmails: ['me@gmail.test', 'you@gmail.test'] })
    expect(
      loadBaseConfig({
        ...prod,
        ALLOWED_EMAIL_DOMAINS: 'example.test',
        ALLOWED_EMAILS: 'me@gmail.test',
      })
    ).toMatchObject({ allowedEmailDomains: ['example.test'], allowedEmails: ['me@gmail.test'] })
    // In dev too: listing addresses doesn't also let in the dev default domain.
    expect(loadBaseConfig({ ALLOWED_EMAILS: 'me@gmail.test' }).allowedEmailDomains).toEqual([])
    for (const bad of ['gmail.test', 'me@', '@gmail.test', 'a b@gmail.test', 'me@gmail.test,x']) {
      expect(() => loadBaseConfig({ ...prod, ALLOWED_EMAILS: bad }), bad).toThrow()
    }
  })

  it('takes admins who may sign in, lowercased; none by default in production', () => {
    const ok = { ...prod, ALLOWED_EMAIL_DOMAINS: 'example.test', ALLOWED_EMAILS: 'me@gmail.test' }
    expect(loadBaseConfig(ok).adminEmails).toEqual([])
    expect(
      loadBaseConfig({ ...ok, ADMIN_EMAILS: ' Boss@Example.test, ME@gmail.test ' }).adminEmails
    ).toEqual(['boss@example.test', 'me@gmail.test'])
    expect(loadBaseConfig({ ...ok, ADMIN_EMAILS: ' ' }).adminEmails).toEqual([])
    // An admin still has to get in: an address the allowlists don't admit is a config error.
    expect(() => loadBaseConfig({ ...ok, ADMIN_EMAILS: 'you@gmail.test' })).toThrow(
      /ADMIN_EMAILS: you@gmail.test may not sign in/
    )
    for (const bad of ['example.test', 'boss@', 'a b@example.test', 'boss@example.test,x']) {
      expect(() => loadBaseConfig({ ...ok, ADMIN_EMAILS: bad }), bad).toThrow()
    }
  })

  it('has a dev admin only with dev login on, and only one the dev allowlist admits', () => {
    expect(loadBaseConfig({ DEV_LOGIN: '1' }).adminEmails).toEqual(['admin@example.test'])
    expect(loadBaseConfig({}).adminEmails).toEqual([])
    expect(
      loadBaseConfig({ DEV_LOGIN: '1', ADMIN_EMAILS: 'boss@example.test' }).adminEmails
    ).toEqual(['boss@example.test'])
    expect(loadBaseConfig({ DEV_LOGIN: '1', ALLOWED_EMAILS: 'me@gmail.test' }).adminEmails).toEqual(
      []
    )
    // Dev login never runs in production, so neither does its admin.
    const p = { ...prod, ALLOWED_EMAIL_DOMAINS: 'example.test', DEV_LOGIN: '1' }
    expect(loadBaseConfig(p).adminEmails).toEqual([])
  })

  it('accepts only hex brand colours and http(s)/data:image asset URLs', () => {
    const ok = { ...prod, ALLOWED_EMAIL_DOMAINS: 'example.test' }
    expect(() => loadBaseConfig({ ...ok, BRAND_ACCENT: 'red; background: url(x)' })).toThrow()
    expect(() => loadBaseConfig({ ...ok, BRAND_LOGO_URL: 'javascript:alert(1)' })).toThrow()
    expect(loadBaseConfig({ ...ok, BRAND_ACCENT: '#166BFF' }).brand).toEqual({
      colors: { accent: '#166BFF' },
    })
  })
})
