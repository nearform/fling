/**
 * Secrets from SSM SecureString parameters under `SSM_PREFIX` (e.g. `/example/fling/`):
 * oidc-client-secret (the OIDC_ISSUER client's), google-client-id + google-client-secret (the
 * Google client), session-secret, site-hmac-key, origin-verify-secret and, with site servers on,
 * site-secrets-key. An instance signs in with either client or both (see @fling/api
 * auth/oidc.ts), so it needs at least one. Loaded once per cold start with
 * GetParametersByPath(WithDecryption).
 *
 * Beside them, settings Terraform can't put in the function's environment (`SETTINGS`, by the env
 * name they stand for): sites-distribution-arn, with site servers on (infra/servers.tf).
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
  'site-secrets-key': 'siteSecretsKey',
} as const

/** Parameters that are settings, by the environment name each stands for. */
const SETTINGS = {
  'sites-distribution-arn': 'SITES_DISTRIBUTION_ARN',
} as const

export async function loadSecretsFromSsm(prefix: string, client = new SSMClient({})) {
  return (await loadFromSsm(prefix, client)).secrets
}

/** The secrets, and the settings (`SETTINGS`) as environment values. */
export async function loadFromSsm(
  prefix: string,
  client = new SSMClient({})
): Promise<{ secrets: Secrets; settings: Record<string, string> }> {
  const path = prefix.endsWith('/') ? prefix : `${prefix}/`
  const found: Partial<Record<keyof Secrets, string>> = {}
  const settings: Record<string, string> = {}
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
      const setting = short ? SETTINGS[short as keyof typeof SETTINGS] : undefined
      if (setting && p.Value) settings[setting] = p.Value
    }
    nextToken = res.NextToken
  } while (nextToken)

  for (const required of ['sessionSecret', 'siteHmacKey'] as const) {
    if (!found[required]) throw new Error(`SSM parameter missing under ${path}: ${required}`)
  }
  if (!found.oidcClientSecret && !(found.googleClientId && found.googleClientSecret)) {
    throw new Error(`SSM parameter missing under ${path}: oidc-client-secret`)
  }
  return { secrets: found as Secrets, settings }
}
