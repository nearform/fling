/**
 * The deploy config check (scripts/config.mjs) that deploy.mjs runs before touching anything, and
 * the Worker config rendered from it.
 */
import { describe, expect, it } from 'vitest'
import { checkDeployConfig, readJsonc, renderWranglerConfig, TEMPLATE } from '../scripts/config.mjs'

const config = (instance: Record<string, string>) => ({
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  WORKER_NAME: 'fling',
  ZONE_NAME: 'example.test',
  APP_ORIGIN: 'https://fling.example.test',
  SITES_DOMAIN: 'fling.example.test',
  D1_DATABASE_NAME: 'fling',
  D1_DATABASE_ID: 'db',
  R2_BUCKET: 'fling-sites',
  KV_NAMESPACE_ID: 'kv',
  INSTANCE: instance,
})

describe('checkDeployConfig', () => {
  it('needs who may sign in: domains, addresses or both', () => {
    const ok: Record<string, string>[] = [
      { ALLOWED_EMAIL_DOMAINS: 'example.test' },
      { ALLOWED_EMAILS: 'me@gmail.test' },
      { ALLOWED_EMAIL_DOMAINS: 'example.test', ALLOWED_EMAILS: 'me@gmail.test' },
      { ALLOWED_EMAIL_DOMAINS: '', ALLOWED_EMAILS: 'me@gmail.test' },
    ]
    for (const instance of ok) {
      expect(() => checkDeployConfig(config(instance))).not.toThrow()
    }
    const refused: Record<string, string>[] = [
      {},
      { ALLOWED_EMAIL_DOMAINS: ' ', ALLOWED_EMAILS: '' },
    ]
    for (const instance of refused) {
      expect(() => checkDeployConfig(config(instance))).toThrow(
        /ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS/
      )
    }
  })
})

describe('INSTANCE.INVITES', () => {
  it('turns on only with MAIL', () => {
    const instance = { ALLOWED_EMAIL_DOMAINS: 'example.test', INVITES: 'on' }
    expect(() => checkDeployConfig(config(instance))).toThrow(/INVITES needs MAIL/)
    const mail = { MAIL: { FROM: 'fling@mail.example.test' } }
    expect(() => checkDeployConfig({ ...config(instance), ...mail })).not.toThrow()
    expect(() => checkDeployConfig(config({ ...instance, INVITES: 'off' }))).not.toThrow()
  })
})

describe('renderWranglerConfig', () => {
  it('keeps the live rooms (their Durable Object and its migration) and points LIVE_URL at the Worker', () => {
    const out = renderWranglerConfig(
      readJsonc(TEMPLATE),
      config({ ALLOWED_EMAIL_DOMAINS: 'example.test', LIVE: 'false' }),
      '/tmp/dist'
    ) as unknown as Record<string, unknown> & { vars: Record<string, string> }
    expect(out.durable_objects).toEqual({
      bindings: [{ name: 'LIVE_ROOMS', class_name: 'LiveRoom' }],
    })
    expect(out.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['LiveRoom'] }])
    expect(out.vars.LIVE_URL).toBe('wss://fling.example.test/api/live')
    expect(out.vars.LIVE).toBe('false')
  })
})

describe('MAIL', () => {
  type Rendered = Record<string, unknown> & {
    vars: Record<string, string>
    triggers: { crons: string[] }
    send_email?: unknown
  }
  const render = (extra: Record<string, unknown>) =>
    renderWranglerConfig(
      readJsonc(TEMPLATE),
      { ...config({ ALLOWED_EMAIL_DOMAINS: 'example.test' }), ...extra },
      '/tmp/dist'
    ) as unknown as Rendered

  it('renders the send_email binding, the every-minute cron and the mail vars', () => {
    const out = render({
      MAIL: {
        FROM: 'Fling@Mail.Example.test',
        FROM_NAME: 'Acme Fling',
        REPLY_TO: 'help@example.test',
      },
    })
    expect(out.send_email).toEqual([
      { name: 'EMAIL', allowed_sender_addresses: ['fling@mail.example.test'] },
    ])
    expect(out.triggers.crons).toEqual(['17 * * * *', '* * * * *'])
    expect(out.vars).toMatchObject({
      MAIL_DRIVER: 'cloudflare',
      MAIL_FROM: 'fling@mail.example.test',
      MAIL_FROM_NAME: 'Acme Fling',
      MAIL_REPLY_TO: 'help@example.test',
    })
  })

  it('leaves the optional values out when they are not set', () => {
    const out = render({ MAIL: { FROM: 'fling@mail.example.test' } })
    expect(out.vars).not.toHaveProperty('MAIL_FROM_NAME')
    expect(out.vars).not.toHaveProperty('MAIL_REPLY_TO')
  })

  it('without MAIL: no binding, no every-minute cron, no mail vars', () => {
    const out = render({})
    expect(out).not.toHaveProperty('send_email')
    expect(out.triggers.crons).toEqual(['17 * * * *'])
    expect(Object.keys(out.vars).filter(k => k.startsWith('MAIL_'))).toEqual([])
  })

  it('refuses a malformed MAIL, and mail settings in INSTANCE', () => {
    const refused: unknown[] = [
      'fling@mail.example.test',
      {},
      { FROM: 'not an address' },
      { FROM: 'fling@mail.example.test', FROM_NAME: 'Acme\nBcc: x@example.test' },
      { FROM: 'fling@mail.example.test', REPLY_TO: 'nobody' },
      { FROM: 'fling@mail.example.test', DRIVER: 'ses' },
    ]
    for (const MAIL of refused) {
      expect(() =>
        checkDeployConfig({ ...config({ ALLOWED_EMAILS: 'a@example.test' }), MAIL })
      ).toThrow(/MAIL/)
    }
    expect(() =>
      checkDeployConfig(config({ ALLOWED_EMAILS: 'a@example.test', MAIL_DRIVER: 'cloudflare' }))
    ).toThrow(/INSTANCE.MAIL_DRIVER is not allowed/)
  })
})
