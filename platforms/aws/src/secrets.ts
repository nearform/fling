/**
 * Secrets from SSM SecureString parameters under `SSM_PREFIX` (e.g. `/example/fling/`):
 * oidc-client-secret, session-secret, site-hmac-key, origin-verify-secret, and the deprecated
 * google-client-id + google-client-secret (read as the Google issuer when OIDC_ISSUER is unset;
 * see @fling/api auth/oidc.ts). Loaded once per cold start with GetParametersByPath(WithDecryption).
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
