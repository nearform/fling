/** The deploy config check (scripts/config.mjs) that deploy.mjs runs before touching anything. */
import { describe, expect, it } from 'vitest'
import { checkDeployConfig } from '../scripts/config.mjs'

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
