/**
 * Tokens issued by Fling's OAuth authorization server (for the remote MCP connector).
 *  - access token: HS256 JWT (RFC 9068 shape, `typ: at+jwt`), 1 h, `iss` = APP_ORIGIN,
 *    `aud` = the MCP resource (APP_ORIGIN/mcp), `sub` = email, `client_id`, `grant_id`, `scope`.
 *    Signed with a key derived from SESSION_SECRET by HKDF-SHA256 (info `fling/oauth-access-token/v1`)
 *    so no new secret is needed and a session JWT can never pass as an access token.
 *  - refresh token / authorization code: opaque random strings, stored only as sha256 hex.
 */
import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import type { Config } from '../config.ts'

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const AUTH_CODE_TTL_SECONDS = 60
export const AUTH_REQUEST_TTL_SECONDS = 10 * 60
export const CLIENT_TTL_SECONDS = 90 * 24 * 60 * 60
export const SCOPE = 'fling'

export const mcpResource = (cfg: Pick<Config, 'appOrigin'>) => `${cfg.appOrigin}/mcp`
export const resourceMetadataUrl = (cfg: Pick<Config, 'appOrigin'>) =>
  `${cfg.appOrigin}/.well-known/oauth-protected-resource/mcp`

const keys = new Map<string, Uint8Array>()

/** The access-token signing key, derived from SESSION_SECRET (cached per secret). */
export function accessTokenKey(sessionSecret: string): Uint8Array {
  let key = keys.get(sessionSecret)
  if (!key) {
    key = new Uint8Array(
      hkdfSync('sha256', sessionSecret, 'fling', 'fling/oauth-access-token/v1', 32)
    )
    keys.set(sessionSecret, key)
  }
  return key
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

export interface AccessClaims {
  email: string
  clientId: string
  grantId: string
  scope: string
}

export async function signAccessToken(cfg: Config, claims: AccessClaims, now: Date) {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT({ client_id: claims.clientId, grant_id: claims.grantId, scope: claims.scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(cfg.appOrigin)
    .setAudience(mcpResource(cfg))
    .setSubject(claims.email)
    .setJti(randomToken(12))
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(accessTokenKey(cfg.secrets.sessionSecret))
}

/** Verified claims, or null for anything invalid, expired, or meant for another audience. */
export async function verifyAccessToken(
  cfg: Config,
  token: string,
  now: Date
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessTokenKey(cfg.secrets.sessionSecret), {
      algorithms: ['HS256'],
      typ: 'at+jwt',
      issuer: cfg.appOrigin,
      audience: mcpResource(cfg),
      currentDate: now,
    })
    const { sub, client_id, grant_id, scope } = payload
    if (typeof sub !== 'string' || typeof client_id !== 'string' || typeof grant_id !== 'string') {
      return null
    }
    return {
      email: sub,
      clientId: client_id,
      grantId: grant_id,
      scope: typeof scope === 'string' ? scope : SCOPE,
    }
  } catch {
    return null
  }
}
