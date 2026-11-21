/**
 * The AWS adapters for the drivers config selects (DynamoDB, S3, CloudFront KeyValueStore; the
 * production defaults), handed to the core's buildDeps; with live rooms on, the API Gateway
 * WebSocket hub (live.ts) over the same Store; with MAIL_DRIVER=ses, the SES mailer (mail/ses.ts);
 * with SERVERS on, site servers on Lambda Web Functions and their logs in CloudWatch (servers/).
 * Any other driver is the core's own memory/fs adapter.
 */

import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { S3Blobs } from '@fling/platform-s3/blobs'
import { ApiGatewayLiveHub, apiGatewayConnections, type Connections } from './live.ts'
import { SesMailer } from './mail/ses.ts'
import { CloudFrontRouteTable } from './route-table/cloudfront.ts'
import { awsServersSettings, awsSiteServers } from './servers/index.ts'
import type { AwsSiteServers } from './servers/site-servers.ts'
import { DynamoTable } from './table/dynamo.ts'

export function buildAwsDeps(
  config: Config,
  opts: { connections?: Connections; env?: Record<string, string | undefined> } = {}
): { deps: Deps; live: ApiGatewayLiveHub | null; servers: AwsSiteServers | null } {
  const store =
    config.storeDriver === 'dynamo'
      ? new Records(new DynamoTable(config.tableName ?? ''))
      : undefined
  const blobs = config.storageDriver === 's3' ? new S3Blobs(config.sitesBucket ?? '') : undefined
  const settings = awsServersSettings(opts.env ?? process.env, config)
  const servers = settings && blobs ? awsSiteServers(settings, blobs) : null
  const deps = buildDeps(config, {
    store,
    blobs,
    ...(servers ? { servers: servers.servers, serverLogs: servers.logs } : {}),
    routeTable:
      config.kvsDriver === 'cloudfront' ? new CloudFrontRouteTable(config.kvsArn ?? '') : undefined,
    mailer:
      config.mail?.driver === 'ses'
        ? new SesMailer({ configurationSet: config.mail.sesConfigurationSet })
        : undefined,
  })
  const aws = servers?.servers ?? null
  if (!config.live || !config.liveUrl) return { deps, live: null, servers: aws }
  const live = new ApiGatewayLiveHub(
    deps.store,
    opts.connections ?? apiGatewayConnections(config.liveUrl)
  )
  return { deps: { ...deps, live }, live, servers: aws }
}
