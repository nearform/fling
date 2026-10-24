import { INSTANCE_METADATA_PATH, InstanceMetadataSchema } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { loadBaseConfig } from '../src/config.ts'
import { setup } from './helpers.ts'

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
      capabilities: {
        remoteMcp: true,
        shareLinks: true,
        publicSites: true,
        archive: true,
        rollback: true,
        comments: true,
      },
      installCommand: expect.stringMatching(/^npm install -g \S+$/),
    })
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
    expect(() => loadBaseConfig(prod)).toThrow(/ALLOWED_EMAIL_DOMAINS is required/)
    expect(loadBaseConfig({ ...prod, ALLOWED_EMAIL_DOMAINS: 'A.test, b.test' })).toMatchObject({
      allowedEmailDomains: ['a.test', 'b.test'],
    })
    expect(loadBaseConfig({}).allowedEmailDomains).toEqual(['example.test'])
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
