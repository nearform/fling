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

/**
 * The sign-in method people see (the instance's OIDC issuer, or dev-login in local dev) and who it
 * lets in. Dev login applies the same email policy, so it publishes the same domains: clients
 * describe and complete addresses alike on every instance.
 */
function authInfo(config: Config): InstanceAuth {
  const allowed = {
    emailDomains: config.allowedEmailDomains,
    // Only that there are invited addresses: the metadata is public, the addresses are not.
    ...(config.allowedEmails.length > 0 && { invitedEmails: true }),
  }
  const oidc = oidcSettings(config)
  if (oidc) {
    return { kind: 'oidc', issuer: oidc.issuer, displayName: oidc.displayName, ...allowed }
  }
  return { kind: 'dev', displayName: 'Dev login', ...allowed }
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
    capabilities: { ...CORE_CAPABILITIES, comments: config.comments, live: config.live },
    installCommand: config.installCommand,
  }
}
