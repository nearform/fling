/**
 * Access tokens from an outside authorization server (`MCP_AUTHORIZATION_SERVER`), for `/mcp`. The
 * instance is then a resource server only: the outside server signs people in, asks consent and
 * issues tokens bound to this instance's MCP resource (RFC 8707), and this checks them.
 *
 * A token is accepted when it is a JWT (`typ: at+jwt`, ES256 or RS256) signed by a key from the
 * server's JWKS (`jwks_uri` in its RFC 8414 metadata), with `iss` = the server and `aud` = this
 * resource, and names the person by `email`. Who may then use Fling is still decided by standing.
 *
 * The keys are cached and re-read when a token names a key the cache lacks (a rotation), at most
 * once a minute.
 */
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import type { Config } from '../config.ts'
import { mcpResource } from './tokens.ts'

const KEYS_TTL_MS = 60 * 60 * 1000
const REFETCH_MIN_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 5000

interface CachedKeys {
  issuer: string
  jwks: JSONWebKeySet
  at: number
}

let cached: CachedKeys | null = null

type Fetch = typeof fetch

async function getJson(doFetch: Fetch, url: string): Promise<Record<string, unknown>> {
  const res = await doFetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function loadKeys(doFetch: Fetch, issuer: string): Promise<JSONWebKeySet> {
  const meta = await getJson(doFetch, `${issuer}/.well-known/oauth-authorization-server`)
  if (meta.issuer !== issuer || typeof meta.jwks_uri !== 'string') {
    throw new Error(`${issuer} publishes no matching issuer and jwks_uri`)
  }
  const jwks = await getJson(doFetch, meta.jwks_uri)
  if (!Array.isArray(jwks.keys)) throw new Error(`${meta.jwks_uri} has no keys`)
  return jwks as unknown as JSONWebKeySet
}

async function keysFor(doFetch: Fetch, issuer: string, refresh: boolean) {
  const now = Date.now()
  const fresh = cached?.issuer === issuer && now - cached.at < KEYS_TTL_MS
  const mayRefetch = !cached || cached.issuer !== issuer || now - cached.at >= REFETCH_MIN_MS
  if (!fresh || (refresh && mayRefetch)) {
    cached = { issuer, jwks: await loadKeys(doFetch, issuer), at: now }
  }
  return (cached as CachedKeys).jwks
}

/** Who the token is for, or null when it isn't a valid token from the outside server. */
export async function verifyExternalToken(
  deps: { config: Config; fetch?: Fetch },
  token: string,
  now: Date
): Promise<{ email: string } | null> {
  const issuer = deps.config.mcpAuthorizationServer
  if (!issuer) return null
  const doFetch = deps.fetch ?? fetch
  const verify = async (refresh: boolean) => {
    const keys = createLocalJWKSet(await keysFor(doFetch, issuer, refresh))
    return jwtVerify(token, keys, {
      algorithms: ['ES256', 'RS256'],
      typ: 'at+jwt',
      issuer,
      audience: mcpResource(deps.config),
      currentDate: now,
    })
  }
  try {
    let result: Awaited<ReturnType<typeof verify>>
    try {
      result = await verify(false)
    } catch (err) {
      // A key the cache doesn't have: the server rotated. Re-read its keys once.
      if ((err as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw err
      result = await verify(true)
    }
    const email = result.payload.email
    if (typeof email !== 'string' || !email.includes('@')) return null
    return { email: email.toLowerCase() }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (!code?.startsWith('ERR_J')) {
      console.warn(
        JSON.stringify({ level: 'warn', msg: 'external_token_keys', error: String(err) })
      )
    }
    return null
  }
}

/** Tests: forget the cached keys. */
export const clearExternalKeys = () => {
  cached = null
}
