/**
 * OAuth clients: Dynamic Client Registration (RFC 7591, public clients only) and Client ID
 * Metadata Documents (draft-ietf-oauth-client-id-metadata-document; the client_id is an https URL
 * we fetch). Claude uses CIMD when the AS metadata advertises it (and `none` auth), else DCR; we
 * support both.
 *
 * Redirect URIs must be on OAUTH_REDIRECT_ALLOWLIST (exact URLs, or `loopback` for any
 * http://localhost|127.0.0.1|[::1] port) AND match one the client registered/declared exactly —
 * except that loopback URIs match with the port ignored (RFC 8252 §7.3; Claude Code declares
 * `http://localhost/callback` and binds a random port).
 */
import type { Config } from '../config.ts'
import type { OAuthClientRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { CLIENT_TTL_SECONDS, randomToken } from './tokens.ts'

export interface ResolvedClient {
  clientId: string
  clientName: string
  clientUri: string | null
  /** CIMD only: host of the client_id URL (the identity we show on the consent page) */
  clientIdHost: string | null
  redirectUris: string[]
  kind: 'dcr' | 'cimd'
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export const isLoopbackUrl = (url: URL) =>
  url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)

/** Is this redirect URI one we'd ever send a code to? */
export function redirectAllowed(cfg: Pick<Config, 'oauthRedirectAllowlist'>, uri: string) {
  const url = parseUrl(uri)
  if (!url || url.hash || url.username || url.password) return false
  if (cfg.oauthRedirectAllowlist.includes(uri)) return true
  return cfg.oauthRedirectAllowlist.includes('loopback') && isLoopbackUrl(url)
}

/** Exact match, or loopback-with-any-port. */
export function redirectMatches(registered: readonly string[], requested: string) {
  if (registered.includes(requested)) return true
  const req = parseUrl(requested)
  if (!req || !isLoopbackUrl(req)) return false
  return registered.some(r => {
    const reg = parseUrl(r)
    return (
      reg !== null &&
      isLoopbackUrl(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    )
  })
}

export const clientRedirectOk = (
  cfg: Pick<Config, 'oauthRedirectAllowlist'>,
  client: ResolvedClient,
  uri: string
) => redirectAllowed(cfg, uri) && redirectMatches(client.redirectUris, uri)

// --- DCR ----------------------------------------------------------------------------------------

export class RegistrationError extends Error {
  constructor(
    readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    message: string
  ) {
    super(message)
  }
}

const str = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null

/** POST /oauth/register: validate RFC 7591 metadata and store a public client. */
export async function registerClient(deps: Deps, body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new RegistrationError('invalid_client_metadata', 'Body must be a JSON object')
  }
  const meta = body as Record<string, unknown>
  const uris = meta.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    throw new RegistrationError('invalid_redirect_uri', 'redirect_uris must list 1-10 URIs')
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri.length > 500 || !redirectAllowed(deps.config, uri)) {
      throw new RegistrationError(
        'invalid_redirect_uri',
        `Redirect URI not allowed: ${String(uri).slice(0, 200)}`
      )
    }
  }
  const grantTypes = meta.grant_types ?? ['authorization_code', 'refresh_token']
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some(g => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    throw new RegistrationError(
      'invalid_client_metadata',
      'Only the authorization_code and refresh_token grants are supported'
    )
  }
  const responseTypes = meta.response_types ?? ['code']
  if (!Array.isArray(responseTypes) || responseTypes.some(r => r !== 'code')) {
    throw new RegistrationError('invalid_client_metadata', 'Only response_type "code" is supported')
  }
  const clientUriRaw = str(meta.client_uri, 500)
  const clientUri =
    clientUriRaw && parseUrl(clientUriRaw)?.protocol === 'https:' ? clientUriRaw : null
  const now = deps.clock.now()
  const record: OAuthClientRecord = {
    clientId: `mcp_${randomToken(18)}`,
    clientName: str(meta.client_name, 100) ?? 'Unnamed app',
    clientUri,
    redirectUris: uris as string[],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CLIENT_TTL_SECONDS * 1000).toISOString(),
  }
  await deps.store.putOAuthClient(record)
  return {
    client_id: record.clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: record.clientName,
    ...(record.clientUri ? { client_uri: record.clientUri } : {}),
    redirect_uris: record.redirectUris,
    grant_types: grantTypes,
    response_types: ['code'],
    // Public clients only (PKCE); whatever was asked for, no secret is issued.
    token_endpoint_auth_method: 'none',
  }
}

// --- CIMD ---------------------------------------------------------------------------------------

const CIMD_MAX_BYTES = 16 * 1024
const CIMD_TIMEOUT_MS = 5000
const CIMD_CACHE_MS = 5 * 60 * 1000
const cimdCache = new Map<string, { client: ResolvedClient; until: number }>()

/** A client_id that is a CIMD URL: https, a real path, no IP literal / localhost / credentials. */
export function isCimdClientId(clientId: string): URL | null {
  if (!clientId.startsWith('https://') || clientId.length > 500) return null
  const url = parseUrl(clientId)
  if (url?.protocol !== 'https:' || url.pathname === '/' || url.hash) return null
  if (url.username || url.password) return null
  const host = url.hostname
  if (host === 'localhost' || host.endsWith('.localhost') || host.includes(':')) return null
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return null
  return url
}

async function fetchCimd(deps: Deps, url: URL): Promise<ResolvedClient | null> {
  const id = url.href
  const cached = cimdCache.get(id)
  if (cached && cached.until > Date.now()) return cached.client
  const doFetch = deps.fetch ?? fetch
  let doc: Record<string, unknown>
  try {
    const res = await doFetch(id, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > CIMD_MAX_BYTES) return null
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== id) return null
  const uris = doc.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.some(u => typeof u !== 'string')) {
    return null
  }
  const method = doc.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') return null
  const clientUri = str(doc.client_uri, 500)
  const client: ResolvedClient = {
    clientId: id,
    clientName: str(doc.client_name, 100) ?? url.hostname,
    clientUri: clientUri && parseUrl(clientUri)?.protocol === 'https:' ? clientUri : null,
    clientIdHost: url.hostname,
    redirectUris: uris as string[],
    kind: 'cimd',
  }
  cimdCache.set(id, { client, until: Date.now() + CIMD_CACHE_MS })
  return client
}

/** Look a client up by id: a CIMD URL is fetched, anything else must be a live DCR client. */
export async function resolveClient(deps: Deps, clientId: string): Promise<ResolvedClient | null> {
  const cimd = isCimdClientId(clientId)
  if (cimd) return fetchCimd(deps, cimd)
  if (!/^mcp_[A-Za-z0-9_-]{10,64}$/.test(clientId)) return null
  const rec = await deps.store.getOAuthClient(clientId)
  if (!rec || Date.parse(rec.expiresAt) <= deps.clock.now().getTime()) return null
  return {
    clientId: rec.clientId,
    clientName: rec.clientName,
    clientUri: rec.clientUri,
    clientIdHost: null,
    redirectUris: rec.redirectUris,
    kind: 'dcr',
  }
}

/** Push a DCR client's expiry out (it is in use). */
export async function touchClient(deps: Deps, client: ResolvedClient) {
  if (client.kind !== 'dcr') return
  const rec = await deps.store.getOAuthClient(client.clientId)
  if (!rec) return
  const expiresAt = new Date(deps.clock.now().getTime() + CLIENT_TTL_SECONDS * 1000).toISOString()
  await deps.store.putOAuthClient({ ...rec, expiresAt })
}

/** Tests: forget cached CIMD documents. */
export const clearCimdCache = () => cimdCache.clear()
