/**
 * The admins' Settings tab (`GET /api/admin/settings`): every env key with its effective value and
 * whether it was set, grouped; the secrets by name only. And the outside-invitations keys
 * (`INVITES`, `INVITES_PER_DAY`) the config validates.
 */
import { SETTING_GROUPS } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  ENV_KEYS,
  loadBaseConfig,
  SECRET_SETTINGS,
  SETTING_GROUP,
  type Secrets,
} from '../src/config.ts'
import { APP_ORIGIN, api, createUser, type Env, json, setup } from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const BOSS = 'boss@example.test'
const MEMBER = 'member@example.test'
const MAIL = { MAIL_DRIVER: 'memory', MAIL_FROM: 'fling@mail.example.test' }

function browser(env: Env, session: string, path: string) {
  const verify = env.config.secrets.originVerifySecret
  return env.app.request(path, {
    headers: {
      cookie: `${SESSION}=${session}`,
      origin: APP_ORIGIN,
      ...(verify ? { 'x-origin-verify': verify } : {}),
    },
  })
}

describe('setting groups', () => {
  it('give every env key a group the Settings tab shows', () => {
    for (const key of ENV_KEYS) expect(SETTING_GROUPS, key).toContain(SETTING_GROUP[key])
  })

  it('give every secret a name and a group', () => {
    for (const { name, group } of Object.values(SECRET_SETTINGS)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/)
      expect(SETTING_GROUPS).toContain(group)
    }
  })
})

describe('outside invitations config', () => {
  it('is off by default, 20 a day', () => {
    const cfg = loadBaseConfig({})
    expect([cfg.invites, cfg.invitesPerDay]).toEqual([false, 20])
  })

  it('turns on only with mail', () => {
    expect(() => loadBaseConfig({ INVITES: 'on' })).toThrow(/INVITES=on needs email/)
    expect(loadBaseConfig({ ...MAIL, INVITES: 'on' }).invites).toBe(true)
    expect(loadBaseConfig({ ...MAIL, INVITES: 'off' }).invites).toBe(false)
  })

  it('takes a positive whole number a day', () => {
    expect(loadBaseConfig({ INVITES_PER_DAY: '5' }).invitesPerDay).toBe(5)
    for (const bad of ['0', '-1', '2.5', 'many']) {
      expect(() => loadBaseConfig({ INVITES_PER_DAY: bad }), bad).toThrow()
    }
  })
})

describe('GET /api/admin/settings', () => {
  it('is a 404 to anyone who is not an admin, by session or key', async () => {
    const env = setup({ adminEmails: [BOSS] })
    const member = await createUser(env, MEMBER)
    expect((await browser(env, member.session, '/api/admin/settings')).status).toBe(404)
    expect((await api(env, member.key, 'GET', '/api/admin/settings')).status).toBe(404)
  })

  it('lists every env key once, effective value and set or default, for an admin session or key', async () => {
    const env = setup({ adminEmails: [BOSS] })
    const boss = await createUser(env, BOSS)
    for (const res of [
      await browser(env, boss.session, '/api/admin/settings'),
      await api(env, boss.key, 'GET', '/api/admin/settings'),
    ]) {
      expect(res.status).toBe(200)
      const { settings } = await json(res)
      expect(settings.map((s: { key: string }) => s.key)).toEqual(ENV_KEYS)
      const byKey = Object.fromEntries(settings.map((s: { key: string }) => [s.key, s]))
      expect(byKey.SITES_DOMAIN).toEqual({
        key: 'SITES_DOMAIN',
        group: 'sites',
        value: 'fling.test',
        set: true,
      })
      expect(byKey.INSTANCE_NAME).toMatchObject({ value: 'Fling', set: false })
      expect(byKey.INVITES).toMatchObject({ group: 'features', value: false, set: false })
      expect(byKey.INVITES_PER_DAY).toMatchObject({ value: 20, set: false })
    }
  })

  it('shows derived defaults as the value the instance runs with', () => {
    const settings = loadBaseConfig({ ALLOWED_EMAILS: 'me@gmail.test' }).settings
    const of = (key: string) => settings.find(s => s.key === key)
    expect(of('STORE_DRIVER')).toMatchObject({ value: 'memory', set: false })
    expect(of('ALLOWED_EMAIL_DOMAINS')).toMatchObject({ value: [], set: false })
    expect(of('ALLOWED_EMAILS')).toMatchObject({ value: ['me@gmail.test'], set: true })
    expect(of('MAIL_DRIVER')).toMatchObject({ value: null, set: false })
  })

  it('names the secrets, set or not, and never carries their values', async () => {
    const secrets: Required<Secrets> = {
      oidcClientSecret: 'oidc-secret-value-0123456789',
      googleClientId: 'google-id-value-0123456789',
      googleClientSecret: 'google-secret-value-0123456789',
      sessionSecret: 'session-secret-value-0123456789abcdef',
      siteHmacKey: 'hmac-key-value-0123456789abcdefghijk',
      originVerifySecret: 'origin-verify-value-0123456789',
    }
    const env = setup({ adminEmails: [BOSS], secrets })
    const boss = await createUser(env, BOSS)
    const res = await browser(env, boss.session, '/api/admin/settings')
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const value of Object.values(secrets)) expect(text).not.toContain(value)
    const body = JSON.parse(text)
    expect(body.secrets).toHaveLength(Object.keys(SECRET_SETTINGS).length)
    for (const s of body.secrets) expect(Object.keys(s).sort()).toEqual(['group', 'name', 'set'])
    expect(body.secrets.every((s: { set: boolean }) => s.set)).toBe(true)

    const bare = setup({ adminEmails: [BOSS] })
    const again = await createUser(bare, BOSS)
    const listed = (await json(await browser(bare, again.session, '/api/admin/settings'))).secrets
    expect(listed.find((s: { name: string }) => s.name === 'ORIGIN_VERIFY_SECRET')).toEqual({
      name: 'ORIGIN_VERIFY_SECRET',
      group: 'platform',
      set: false,
    })
  })
})
