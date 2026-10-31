/**
 * A real, if tiny, OpenID Connect provider for tests, served in-process: discovery, JWKS and a
 * token endpoint that checks the client secret, the redirect URI and PKCE, then signs an RS256 ID
 * token. Tests drive the browser's half with `authorize(location)`, which turns the authorization
 * URL the API redirected to into a code, and can tamper with the next token or rotate keys.
 */
import { Hono } from 'hono'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import * as oauth from 'oauth4webapi'

export const IDP_ISSUER = 'https://idp.example.test'
export const IDP_CLIENT_ID = 'fling-client'
export const IDP_CLIENT_SECRET = 'fling-client-secret'

interface SigningKey {
  kid: string
  privateKey: CryptoKey
  jwk: JWK
}

interface Grant {
  redirectUri: string
  challenge: string
  nonce: string
  claims: Record<string, unknown>
}

/**
 * Changes to the next token response: ID token claims (`undefined` removes one), a key the JWKS
 * lacks, or a 400 with this body instead of tokens (`refuse`, as Cognito answers when its own
 * access check turns someone away).
 */
export interface Tamper {
  claims?: Record<string, unknown>
  rogueKey?: boolean
  refuse?: Record<string, unknown>
}

let counter = 0

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const kid = `k${++counter}`
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  }
}

export function testIdp(
  opts: {
    issuer?: string
    clientId?: string
    clientSecret?: string
    /** Discovery's token_endpoint_auth_methods_supported. */
    authMethods?: string[]
    /** Take Basic credentials without form-decoding them, as Google does. */
    literalBasic?: boolean
  } = {}
) {
  const issuer = opts.issuer ?? IDP_ISSUER
  const clientId = opts.clientId ?? IDP_CLIENT_ID
  const clientSecret = opts.clientSecret ?? IDP_CLIENT_SECRET
  let keys: Promise<SigningKey[]> = Promise.all([newKey()])
  const grants = new Map<string, Grant>()
  const hits = { discovery: 0, jwks: 0, token: 0 }
  let tamper: Tamper | undefined
  const idp = {
    issuer,
    hits,
    /** Claims (besides iss/aud/iat/exp/nonce) of the account that signs in next. */
    claims: {
      sub: 'alice-sub',
      email: 'alice@example.test',
      email_verified: true,
      name: 'Alice',
    } as Record<string, unknown>,
    /** How the client authenticated at the token endpoint last time. */
    lastClientAuth: undefined as 'basic' | 'post' | undefined,
    /** The last authorization request's parameters. */
    lastAuthorization: undefined as URLSearchParams | undefined,
    tamperNext(t: Tamper) {
      tamper = t
    },
    /** Sign with a new key; `keepOld` leaves the old one in the JWKS too. */
    async rotate(keepOld = false) {
      const next = await newKey()
      const old = await keys
      keys = Promise.resolve(keepOld ? [next, ...old] : [next])
    },
    /** The user approves: the authorization URL the API sent the browser to → a code. */
    authorize(location: string): string {
      const url = new URL(location)
      const q = url.searchParams
      idp.lastAuthorization = q
      if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`) {
        throw new Error(`not this IdP: ${location}`)
      }
      if (q.get('client_id') !== clientId) throw new Error('unknown client_id')
      if (q.get('response_type') !== 'code') throw new Error('response_type must be code')
      if (q.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required')
      if (!q.get('scope')?.split(' ').includes('openid')) throw new Error('openid scope required')
      const code = `code-${crypto.randomUUID()}`
      grants.set(code, {
        redirectUri: q.get('redirect_uri') as string,
        challenge: q.get('code_challenge') as string,
        nonce: q.get('nonce') as string,
        claims: { ...idp.claims },
      })
      return code
    },
    fetch: undefined as unknown as typeof fetch,
  }

  const app = new Hono()
  app.get('/.well-known/openid-configuration', c => {
    hits.discovery++
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: opts.authMethods ?? [
        'client_secret_basic',
        'client_secret_post',
      ],
      code_challenge_methods_supported: ['S256'],
    })
  })
  app.get('/jwks', async c => {
    hits.jwks++
    return c.json({ keys: (await keys).map(k => k.jwk) })
  })
  app.post('/token', async c => {
    hits.token++
    const form = await c.req.parseBody<Record<string, string>>()
    const basic = c.req.header('authorization')?.replace(/^Basic /, '')
    idp.lastClientAuth = basic ? 'basic' : 'post'
    const [id, secret] = basic
      ? atob(basic)
          .split(':')
          .map(v => (opts.literalBasic ? v : decodeURIComponent(v)))
      : [form.client_id, form.client_secret]
    if (id !== clientId || secret !== clientSecret) return c.json({ error: 'invalid_client' }, 401)
    const grant = grants.get(form.code ?? '')
    grants.delete(form.code ?? '')
    if (form.grant_type !== 'authorization_code' || !grant) {
      return c.json({ error: 'invalid_grant' }, 400)
    }
    if (form.redirect_uri !== grant.redirectUri) return c.json({ error: 'invalid_grant' }, 400)
    if ((await oauth.calculatePKCECodeChallenge(form.code_verifier ?? '')) !== grant.challenge) {
      return c.json({ error: 'invalid_grant', error_description: 'PKCE' }, 400)
    }
    const t = tamper
    tamper = undefined
    if (t?.refuse) return c.json(t.refuse, 400)
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = {
      iss: issuer,
      aud: clientId,
      iat: now,
      exp: now + 300,
      nonce: grant.nonce,
      ...grant.claims,
      ...t?.claims,
    }
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k]
    const [current] = await keys
    const key = t?.rogueKey ? { ...(await newKey()), kid: current?.kid } : current
    if (!key) throw new Error('no signing key')
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .sign(key.privateKey)
    return c.json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken })
  })

  idp.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.origin !== new URL(issuer).origin) throw new Error(`unexpected fetch: ${url}`)
    return app.request(url.toString(), init)
  }) as typeof fetch
  return idp
}

export type TestIdp = ReturnType<typeof testIdp>
