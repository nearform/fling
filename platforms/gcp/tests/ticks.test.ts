/**
 * The tick check against ID tokens signed with a key made here, which the verifying client takes
 * as Google's: no request leaves the process.
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { describe, expect, it } from 'vitest'
import { googleIdTokenTicks } from '../src/ticks.ts'

const AUDIENCE = 'https://fling.example.test'
const SCHEDULER = 'fling-scheduler@example-project.iam.gserviceaccount.com'
const DEPLOY = 'fling-deploy@example-project.iam.gserviceaccount.com'

const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')

function token(claims: Record<string, unknown> = {}, key = google.privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '1234567890',
    email: SCHEDULER,
    email_verified: true,
    iat: now,
    exp: now + 600,
    ...claims,
  })}`
  const signature = createSign('RSA-SHA256').update(body).sign(key).toString('base64url')
  return `${body}.${signature}`
}

function client() {
  const c = new OAuth2Client()
  const pem = google.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  c.getFederatedSignonCertsAsync = async () => ({ certs: { k1: pem }, format: 'PEM' }) as never
  return c
}

const check = googleIdTokenTicks({
  audience: AUDIENCE,
  serviceAccounts: [SCHEDULER, DEPLOY],
  client: client(),
})
const call = (authorization?: string) =>
  check(
    new Request(`${AUDIENCE}/ticks/notify`, {
      method: 'POST',
      ...(authorization ? { headers: { authorization } } : {}),
    })
  )

describe('googleIdTokenTicks', () => {
  it("takes the scheduler's and the deploy's tokens for this audience", async () => {
    expect(await call(`Bearer ${token()}`)).toBe(true)
    expect(await call(`Bearer ${token({ email: DEPLOY })}`)).toBe(true)
  })

  it('refuses no token, another account, an unverified email or another audience', async () => {
    expect(await call()).toBe(false)
    expect(await call('Basic abc')).toBe(false)
    expect(
      await call(`Bearer ${token({ email: 'other@example-project.iam.gserviceaccount.com' })}`)
    ).toBe(false)
    expect(await call(`Bearer ${token({ email_verified: false })}`)).toBe(false)
    expect(await call(`Bearer ${token({ aud: 'https://other.example.test' })}`)).toBe(false)
  })

  it('refuses an expired token, another issuer and a key that is not Google’s', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    expect(await call(`Bearer ${token({ iat: past, exp: past + 600 })}`)).toBe(false)
    expect(await call(`Bearer ${token({ iss: 'https://issuer.example.test' })}`)).toBe(false)
    expect(await call(`Bearer ${token({}, stranger.privateKey)}`)).toBe(false)
    expect(await call('Bearer not.a.token')).toBe(false)
  })

  it('needs a service account to allow', () => {
    expect(() => googleIdTokenTicks({ audience: AUDIENCE, serviceAccounts: [' '] })).toThrow()
  })
})
