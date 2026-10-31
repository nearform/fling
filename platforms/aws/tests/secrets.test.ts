import type { SSMClient } from '@aws-sdk/client-ssm'
import { describe, expect, it } from 'vitest'
import { loadSecretsFromSsm } from '../src/secrets.ts'

/** An SSM client that answers GetParametersByPath from `params` (names relative to the prefix). */
function fakeSsm(params: Record<string, string>) {
  return {
    send: async () => ({
      Parameters: Object.entries(params).map(([name, value]) => ({
        Name: `/example/fling/${name}`,
        Value: value,
      })),
    }),
  } as unknown as SSMClient
}

const core = { 'session-secret': 's'.repeat(40), 'site-hmac-key': 'h'.repeat(40) }

describe('loadSecretsFromSsm', () => {
  it('reads the OIDC client secret', async () => {
    const secrets = await loadSecretsFromSsm(
      '/example/fling',
      fakeSsm({ ...core, 'oidc-client-secret': 'oidc' })
    )
    expect(secrets).toMatchObject({ oidcClientSecret: 'oidc', sessionSecret: 's'.repeat(40) })
  })

  it('reads the Google client', async () => {
    const secrets = await loadSecretsFromSsm(
      '/example/fling/',
      fakeSsm({ ...core, 'google-client-id': 'gid', 'google-client-secret': 'gsecret' })
    )
    expect(secrets).toMatchObject({ googleClientId: 'gid', googleClientSecret: 'gsecret' })
  })

  it('reads both clients, for an instance that offers both', async () => {
    const secrets = await loadSecretsFromSsm(
      '/example/fling/',
      fakeSsm({
        ...core,
        'oidc-client-secret': 'oidc',
        'google-client-id': 'gid',
        'google-client-secret': 'gsecret',
      })
    )
    expect(secrets).toMatchObject({
      oidcClientSecret: 'oidc',
      googleClientId: 'gid',
      googleClientSecret: 'gsecret',
    })
  })

  it('refuses to start without a sign-in client secret', async () => {
    await expect(loadSecretsFromSsm('/example/fling/', fakeSsm(core))).rejects.toThrow(
      /oidc-client-secret/
    )
    await expect(
      loadSecretsFromSsm('/example/fling/', fakeSsm({ ...core, 'google-client-id': 'gid' }))
    ).rejects.toThrow(/oidc-client-secret/)
  })
})
