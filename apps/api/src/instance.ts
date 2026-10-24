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
import { oidcSettings } from './auth/oidc.ts'
import type { Config } from './config.ts'

/** The sign-in method people see: the instance's OIDC issuer, or dev-login in local dev. */
function authInfo(config: Config): InstanceAuth {
  const oidc = oidcSettings(config)
  if (oidc) {
    return {
      kind: 'oidc',
      issuer: oidc.issuer,
      displayName: oidc.displayName,
      emailDomains: config.allowedEmailDomains,
    }
  }
  return { kind: 'dev', displayName: 'Dev login', emailDomains: [] }
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
    capabilities: { ...CORE_CAPABILITIES, comments: config.comments },
    installCommand: config.installCommand,
  }
}
