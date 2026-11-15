/**
 * Site servers on AWS, put together: the Terraform-set plumbing they need (servers.tf writes it
 * into the API function's environment when `servers.enabled`), and the adapters built on it. With
 * SERVERS off nothing here is built; with it on and the plumbing missing, the API refuses to start
 * and says what to turn on.
 *
 *   SERVER_FUNCTION_PREFIX        every site's Web Function name starts with it (the IAM fence's)
 *   SERVER_INSTANCE               the `fling:instance` tag on each function
 *   SERVER_ROLE_ARN               the servers' execution role (logs only)
 *   SERVER_ZIP_BUCKET             the versioned bucket revisions are built from
 *   SITES_DISTRIBUTION_ARN        the sites distribution, the only caller of a `live` endpoint
 *   SERVER_NETWORK_CONNECTOR_ARN  the egress connector (versioned ARN), for SERVERS_EGRESS=none
 */
import type { Blobs } from '@fling/api/blobs'
import type { Config } from '@fling/api/config'
import { ENTRY_FILE } from './entry-contract.ts'
import { CloudWatchLogEvents, CloudWatchServerLogs } from './server-logs.ts'
import { type AwsServersSettings, AwsSiteServers } from './site-servers.ts'
import { LambdaWebFunctions } from './web-functions.ts'
import { loadServerRuntime, type ServerRuntime } from './zip.ts'
import { S3ServerZips } from './zips.ts'

type Env = Record<string, string | undefined>

const REQUIRED = [
  'SERVER_FUNCTION_PREFIX',
  'SERVER_INSTANCE',
  'SERVER_ROLE_ARN',
  'SERVER_ZIP_BUCKET',
  'SITES_DISTRIBUTION_ARN',
] as const

/** The settings, from the environment; null with SERVERS off. Throws when some are missing. */
export function awsServersSettings(
  env: Env,
  config: Pick<Config, 'servers'>
): (AwsServersSettings & { zipBucket: string }) | null {
  if (config.servers.publish.kind === 'off') return null
  const missing = REQUIRED.filter(name => !env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `SERVERS is on, and the AWS deployment has no site server infrastructure (${missing.join(', ')} unset): turn on servers in the Terraform module (var.servers.enabled), or set SERVERS=off`
    )
  }
  const value = (name: (typeof REQUIRED)[number]) => (env[name] ?? '').trim()
  const connector = env.SERVER_NETWORK_CONNECTOR_ARN?.trim()
  return {
    functionPrefix: value('SERVER_FUNCTION_PREFIX'),
    instance: value('SERVER_INSTANCE'),
    roleArn: value('SERVER_ROLE_ARN'),
    distributionArn: value('SITES_DISTRIBUTION_ARN'),
    zipBucket: value('SERVER_ZIP_BUCKET'),
    ...(connector ? { connectorArn: connector } : {}),
    maxSites: config.servers.maxSites,
    environments: config.servers.limits.environments,
  }
}

/** The server runtime scripts/build.mjs puts beside the API's bundle (server-entry/). */
const bundledRuntime = (() => {
  let loaded: Promise<ServerRuntime> | undefined
  return () => {
    loaded ??= loadServerRuntime(new URL('./server-entry/', import.meta.url))
    return loaded
  }
})()

/** The site servers adapter and its logs, on the AWS SDK. */
export function awsSiteServers(
  settings: AwsServersSettings & { zipBucket: string },
  blobs: Blobs,
  runtime: () => Promise<ServerRuntime> = bundledRuntime
) {
  const functions = new LambdaWebFunctions(ENTRY_FILE)
  const logEvents = new CloudWatchLogEvents()
  const logs = new CloudWatchServerLogs(logEvents, functions, settings.functionPrefix)
  const servers = new AwsSiteServers({
    settings,
    functions,
    zips: new S3ServerZips(settings.zipBucket),
    blobs,
    logs,
    logEvents,
    runtime,
  })
  return { servers, logs }
}
