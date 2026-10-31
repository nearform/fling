/**
 * Secrets from SSM SecureString parameters under `SSM_PREFIX` (e.g. `/example/fling/`):
 * oidc-client-secret (the OIDC_ISSUER client's), google-client-id + google-client-secret (the
 * Google client), session-secret, site-hmac-key and origin-verify-secret. An instance signs in with
 * either client or both (see @fling/api auth/oidc.ts), so it needs at least one. Loaded once per
 * cold start with GetParametersByPath(WithDecryption).
 */
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { Secrets } from '@fling/api/config'

const NAMES = {
  'oidc-client-secret': 'oidcClientSecret',
  'google-client-id': 'googleClientId',
  'google-client-secret': 'googleClientSecret',
  'session-secret': 'sessionSecret',
  'site-hmac-key': 'siteHmacKey',
  'origin-verify-secret': 'originVerifySecret',
} as const

export async function loadSecretsFromSsm(prefix: string, client = new SSMClient({})) {
  const path = prefix.endsWith('/') ? prefix : `${prefix}/`
  const found: Partial<Record<keyof Secrets, string>> = {}
  let nextToken: string | undefined
  do {
    const res = await client.send(
      new GetParametersByPathCommand({
        Path: path,
        WithDecryption: true,
        Recursive: false,
        NextToken: nextToken,
      })
    )
    for (const p of res.Parameters ?? []) {
      const short = p.Name?.slice(path.length) as keyof typeof NAMES | undefined
      const key = short ? NAMES[short] : undefined
      if (key && p.Value) found[key] = p.Value
    }
    nextToken = res.NextToken
  } while (nextToken)

  for (const required of ['sessionSecret', 'siteHmacKey'] as const) {
    if (!found[required]) throw new Error(`SSM parameter missing under ${path}: ${required}`)
  }
  if (!found.oidcClientSecret && !(found.googleClientId && found.googleClientSecret)) {
    throw new Error(`SSM parameter missing under ${path}: oidc-client-secret`)
  }
  return found as Secrets
}
