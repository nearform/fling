import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearExternalKeys } from '../src/oauth/external.ts'
import { APP_ORIGIN, type Env, json, setup } from './helpers.ts'
import { rpc } from './oauth-helpers.ts'

const AS = 'https://access.example.test'
const { privateKey, publicKey } = await generateKeyPair('ES256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url === `${AS}/.well-known/oauth-authorization-server`) {
    return Response.json({ issuer: AS, jwks_uri: `${AS}/.well-known/jwks.json` })
  }
  if (url === `${AS}/.well-known/jwks.json`) return Response.json({ keys: [jwk] })
  return new Response('not found', { status: 404 })
}) as typeof fetch

const token = (claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string } = {}) =>
  new SignJWT({ email: 'alice@example.test', ...claims })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'k1' })
    .setIssuer(opts.iss ?? AS)
    .setAudience(opts.aud ?? `${APP_ORIGIN}/mcp`)
    .setSubject('person-1')
    .setIssuedAt(new Date('2026-01-01T00:00:00Z'))
    .setExpirationTime(new Date('2026-01-01T01:00:00Z'))
    .sign(privateKey)

let env: Env

beforeEach(() => {
  clearExternalKeys()
  env = setup({ mcpAuthorizationServer: AS })
  env.deps.fetch = fakeFetch
})

describe('/mcp with an outside authorization server', () => {
  it('names the outside server in the protected-resource metadata', async () => {
    const res = await env.app.request('/.well-known/oauth-protected-resource/mcp')
    expect((await json(res)).authorization_servers).toEqual([AS])
  })

  it("accepts the outside server's token for this resource and makes the user", async () => {
    const res = await rpc(env, await token(), 'tools/list')
    expect(res.status).toBe(200)
    expect(await env.store.getUser('alice@example.test')).not.toBeNull()
  })

  it('refuses a token for another resource or from another issuer', async () => {
    for (const t of [
      await token({}, { aud: 'https://other.example.test/mcp' }),
      await token({}, { iss: 'https://evil.example.test' }),
    ]) {
      expect((await rpc(env, t, 'tools/list')).status).toBe(401)
    }
  })

  it('refuses someone without standing on this instance', async () => {
    const res = await rpc(env, await token({ email: 'mallory@outside.test' }), 'tools/list')
    expect(res.status).toBe(401)
    expect(await env.store.getUser('mallory@outside.test')).toBeNull()
  })

  it('accepts nothing from outside when no outside server is set', async () => {
    const plain = setup()
    plain.deps.fetch = fakeFetch
    expect((await rpc(plain, await token(), 'tools/list')).status).toBe(401)
  })
})
