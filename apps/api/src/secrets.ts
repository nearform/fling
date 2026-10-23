/**
 * Secrets from SSM SecureString parameters under `SSM_PREFIX` (e.g. `/labs/production/fling/`):
 * google-client-id, google-client-secret, session-secret, site-hmac-key, origin-verify-secret.
 * Loaded once per cold start with GetParametersByPath(WithDecryption).
 */
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { Secrets } from './config.ts'

const NAMES = {
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

  for (const required of [
    'googleClientId',
    'googleClientSecret',
    'sessionSecret',
    'siteHmacKey',
  ] as const) {
    if (!found[required]) throw new Error(`SSM parameter missing under ${path}: ${required}`)
  }
  return found as Secrets
}
