/**
 * The instance metadata (`GET /.well-known/fling`, contract in @fling/shared/instance): every value
 * comes from config, so the CLI, the MCP servers and the web build stay instance-agnostic. Also the
 * wording the remote MCP server renders its tool descriptions with.
 */
import {
  CORE_CAPABILITIES,
  INSTANCE_METADATA_VERSION,
  type InstanceAuth,
  type InstanceMetadata,
} from '@fling/shared'
import type { Config } from './config.ts'

/** The sign-in method people see. Generic OIDC (one issuer per instance) replaces Google later. */
function authInfo(config: Config): InstanceAuth {
  const { googleClientId, googleClientSecret } = config.secrets
  const google = Boolean(googleClientId && googleClientSecret)
  if (!google && config.devLogin) {
    return { kind: 'dev', displayName: 'Dev login', emailDomains: [] }
  }
  return { kind: 'google', displayName: 'Google', emailDomains: config.allowedEmailDomains }
}

export function instanceMetadata(config: Config): InstanceMetadata {
  return {
    version: INSTANCE_METADATA_VERSION,
    name: config.instanceName,
    appOrigin: config.appOrigin,
    sitesDomain: config.sitesDomain,
    siteScheme: config.siteScheme,
    auth: authInfo(config),
    brand: config.brand,
    capabilities: { ...CORE_CAPABILITIES },
    installCommand: config.installCommand,
  }
}
